import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import winston from 'winston';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

export interface VaultStatus {
    exists: boolean;
    capacityGB: number;
    usedGB: number;
    availableGB: number;
    percentUsed: number;
    vaultPath: string;
}

export interface VaultConfig {
    capacityGB: number;
    vaultPath: string;
}

/**
 * StorageVaultManager handles the creation and management of the pre-allocated
 * storage vault for Kyneto providers. This ensures providers cannot pledge more
 * storage than they have available.
 */
export class StorageVaultManager {
    private readonly vaultPath: string;
    private readonly vaultFile: string;
    private readonly capacityGB: number;
    private readonly dataDir: string;

    constructor(config: VaultConfig) {
        this.capacityGB = config.capacityGB;
        this.vaultPath = config.vaultPath || '/data/kyneto-vault';
        this.vaultFile = path.join(this.vaultPath, 'vault.img');
        this.dataDir = path.join(this.vaultPath, 'ipfs-data');
    }

    /**
     * Get the IPFS data directory path inside the vault
     */
    getIpfsDataPath(): string {
        return this.dataDir;
    }

    /**
     * Ensure the storage vault exists and is properly configured
     * Creates a sparse file if it doesn't exist
     */
    async ensureVaultExists(): Promise<boolean> {
        try {
            logger.info(`🔐 Initializing Kyneto Storage Vault (${this.capacityGB}GB)...`);

            // Create vault directory if it doesn't exist
            if (!fs.existsSync(this.vaultPath)) {
                fs.mkdirSync(this.vaultPath, { recursive: true });
                logger.info(`📁 Created vault directory: ${this.vaultPath}`);
            }

            // Check if vault file already exists
            if (fs.existsSync(this.vaultFile)) {
                const stats = fs.statSync(this.vaultFile);
                const existingCapacityGB = Math.round(stats.size / (1024 * 1024 * 1024));

                if (this.capacityGB > existingCapacityGB) {
                    logger.info(`📈 Increasing vault size from ${existingCapacityGB}GB to ${this.capacityGB}GB...`);
                    await this.extendVaultFile();
                } else if (this.capacityGB < existingCapacityGB) {
                    logger.warn(`⚠️  Vault exists with ${existingCapacityGB}GB but ${this.capacityGB}GB requested`);
                    logger.warn(`⚠️  Shrinking is not supported to prevent data loss. Keeping existing size.`);
                } else {
                    logger.info(`✅ Vault already exists: ${this.vaultFile} (${this.capacityGB}GB)`);
                }
            } else {
                // Validate we have enough disk space
                const available = await this.getAvailableDiskSpace();
                if (available < this.capacityGB) {
                    logger.error(`❌ Insufficient disk space! Need ${this.capacityGB}GB but only ${available}GB available`);
                    return false;
                }

                // Create sparse file
                await this.createSparseFile();
            }

            // Ensure IPFS data directory exists inside vault
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir, { recursive: true });
                logger.info(`📁 Created IPFS data directory: ${this.dataDir}`);
            }

            // Write vault metadata
            await this.writeMetadata();

            logger.info(`✅ Storage Vault ready: ${this.capacityGB}GB at ${this.vaultPath}`);
            return true;

        } catch (error: any) {
            logger.error(`❌ Failed to initialize vault: ${error.message}`);
            return false;
        }
    }

    /**
     * Extend the vault file to the new capacity
     */
    private async extendVaultFile(): Promise<void> {
        logger.info(`🔨 Extending vault file to ${this.capacityGB}GB...`);
        const sizeBytes = BigInt(this.capacityGB) * BigInt(1024 * 1024 * 1024);

        try {
            // Use truncate to extend the file (safe for sparse files)
            fs.truncateSync(this.vaultFile, Number(sizeBytes));
            logger.info(`✅ Vault file extended: ${this.vaultFile}`);
        } catch (error: any) {
            logger.error(`❌ Failed to extend vault file: ${error.message}`);
            throw error;
        }
    }

    /**
     * Create a sparse file with the specified capacity
     * Sparse files only consume actual disk space as data is written
     */
    private async createSparseFile(): Promise<void> {
        logger.info(`🔨 Creating ${this.capacityGB}GB sparse vault file...`);

        const sizeBytes = BigInt(this.capacityGB) * BigInt(1024 * 1024 * 1024);

        // Create sparse file by seeking to the end and writing a single byte
        const fd = fs.openSync(this.vaultFile, 'w');
        try {
            // Write a null byte at the position of (size - 1) to create sparse file
            const buffer = Buffer.alloc(1, 0);
            fs.writeSync(fd, buffer, 0, 1, Number(sizeBytes - BigInt(1)));
        } finally {
            fs.closeSync(fd);
        }

        logger.info(`✅ Sparse vault file created: ${this.vaultFile}`);
    }

    /**
     * Get available disk space in GB on the vault path
     */
    private async getAvailableDiskSpace(): Promise<number> {
        try {
            // Use df command to get available space (works in Linux/Docker)
            const result = execSync(`df -BG "${this.vaultPath}" | tail -1 | awk '{print $4}'`, {
                encoding: 'utf-8'
            }).trim();

            // Remove 'G' suffix and parse
            const availableGB = parseInt(result.replace('G', ''), 10);
            return isNaN(availableGB) ? 0 : availableGB;
        } catch (error) {
            // Fallback: try to read statvfs-style info
            try {
                const stats = fs.statfsSync(this.vaultPath);
                const availableBytes = stats.bavail * stats.bsize;
                return Math.floor(availableBytes / (1024 * 1024 * 1024));
            } catch {
                logger.warn('⚠️  Could not determine available disk space, proceeding anyway');
                return Number.MAX_SAFE_INTEGER;
            }
        }
    }

    /**
     * Get current vault usage status
     */
    async getVaultStatus(): Promise<VaultStatus> {
        const status: VaultStatus = {
            exists: false,
            capacityGB: this.capacityGB,
            usedGB: 0,
            availableGB: this.capacityGB,
            percentUsed: 0,
            vaultPath: this.vaultPath
        };

        if (!fs.existsSync(this.dataDir)) {
            return status;
        }

        status.exists = true;

        try {
            // Calculate actual disk usage of the data directory
            const result = execSync(`du -s "${this.dataDir}" | cut -f1`, {
                encoding: 'utf-8'
            }).trim();

            const usedKB = parseInt(result, 10);
            status.usedGB = Math.round((usedKB / (1024 * 1024)) * 100) / 100;
            status.availableGB = Math.round((this.capacityGB - status.usedGB) * 100) / 100;
            status.percentUsed = Math.round((status.usedGB / this.capacityGB) * 100 * 10) / 10;
        } catch (error) {
            // Fallback: walk directory manually
            status.usedGB = this.calculateDirectorySize(this.dataDir);
            status.availableGB = this.capacityGB - status.usedGB;
            status.percentUsed = (status.usedGB / this.capacityGB) * 100;
        }

        return status;
    }

    /**
     * Calculate directory size recursively (fallback method)
     */
    private calculateDirectorySize(dirPath: string): number {
        let totalBytes = 0;

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    totalBytes += this.calculateDirectorySize(fullPath);
                } else if (entry.isFile()) {
                    try {
                        const stats = fs.statSync(fullPath);
                        totalBytes += stats.blocks * 512; // Actual disk usage
                    } catch {
                        // Skip files we can't stat
                    }
                }
            }
        } catch {
            // Directory might not exist or be inaccessible
        }

        return totalBytes / (1024 * 1024 * 1024); // Convert to GB
    }

    /**
     * Validate that proposed capacity matches on-chain pledge
     */
    async validateAgainstOnChainPledge(onChainCapacityGB: number): Promise<boolean> {
        if (this.capacityGB < onChainCapacityGB) {
            logger.error(`❌ PLEDGED_CAPACITY_GB (${this.capacityGB}GB) is less than on-chain pledge (${onChainCapacityGB}GB)`);
            logger.error(`❌ Please increase PLEDGED_CAPACITY_GB or reduce your on-chain pledge`);
            return false;
        }

        if (this.capacityGB > onChainCapacityGB) {
            logger.warn(`⚠️  PLEDGED_CAPACITY_GB (${this.capacityGB}GB) exceeds on-chain pledge (${onChainCapacityGB}GB)`);
            logger.warn(`⚠️  Only ${onChainCapacityGB}GB will count towards rewards`);
        }

        return true;
    }

    /**
     * Write vault metadata to file
     */
    private async writeMetadata(): Promise<void> {
        const metadata = {
            version: '1.0.0',
            createdAt: new Date().toISOString(),
            capacityGB: this.capacityGB,
            vaultFile: this.vaultFile
        };

        const metadataPath = path.join(this.vaultPath, 'vault-metadata.json');
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        logger.info(`📝 Vault metadata written to ${metadataPath}`);
    }

    /**
     * Check if there's enough remaining capacity for a new file
     */
    async hasCapacityFor(fileSizeBytes: number): Promise<boolean> {
        const status = await this.getVaultStatus();
        const fileSizeGB = fileSizeBytes / (1024 * 1024 * 1024);
        return status.availableGB >= fileSizeGB;
    }
}

/**
 * Create and initialize the storage vault manager from environment variables
 */
export function createVaultManagerFromEnv(): StorageVaultManager | null {
    const capacityGB = parseInt(process.env.PLEDGED_CAPACITY_GB || '0', 10);

    if (capacityGB <= 0) {
        logger.warn('⚠️  PLEDGED_CAPACITY_GB not set or invalid. Storage vault disabled.');
        return null;
    }

    const vaultPath = process.env.KYNETO_VAULT_PATH || '/data/kyneto-vault';

    return new StorageVaultManager({
        capacityGB,
        vaultPath
    });
}
