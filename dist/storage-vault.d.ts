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
export declare class StorageVaultManager {
    private readonly vaultPath;
    private readonly vaultFile;
    private readonly capacityGB;
    private readonly dataDir;
    constructor(config: VaultConfig);
    /**
     * Get the IPFS data directory path inside the vault
     */
    getIpfsDataPath(): string;
    /**
     * Ensure the storage vault exists and is properly configured
     * Creates a sparse file if it doesn't exist
     */
    ensureVaultExists(): Promise<boolean>;
    /**
     * Extend the vault file to the new capacity
     */
    private extendVaultFile;
    /**
     * Create a sparse file with the specified capacity
     * Sparse files only consume actual disk space as data is written
     */
    private createSparseFile;
    /**
     * Get available disk space in GB on the vault path
     */
    private getAvailableDiskSpace;
    /**
     * Get current vault usage status
     */
    getVaultStatus(): Promise<VaultStatus>;
    /**
     * Calculate directory size recursively (fallback method)
     */
    private calculateDirectorySize;
    /**
     * Validate that proposed capacity matches on-chain pledge
     */
    validateAgainstOnChainPledge(onChainCapacityGB: number): Promise<boolean>;
    /**
     * Write vault metadata to file
     */
    private writeMetadata;
    /**
     * Check if there's enough remaining capacity for a new file
     */
    hasCapacityFor(fileSizeBytes: number): Promise<boolean>;
}
/**
 * Create and initialize the storage vault manager from environment variables
 */
export declare function createVaultManagerFromEnv(): StorageVaultManager | null;
//# sourceMappingURL=storage-vault.d.ts.map