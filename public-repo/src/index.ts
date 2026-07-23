import { ethers } from 'ethers';
import { create as createIpfsClient } from 'ipfs-http-client';
import * as dotenv from 'dotenv';
import axios from 'axios';
import winston from 'winston';
import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import * as fs from 'fs';
import * as path from 'path';
import { StorageVaultManager, createVaultManagerFromEnv, VaultStatus } from './storage-vault.js';
import { io as ioClient, Socket } from 'socket.io-client';

dotenv.config();

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [new winston.transports.Console()]
});

class ProviderDaemon {
    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private ipfs: any;
    private proverContract: ethers.Contract | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private eventInterval: NodeJS.Timeout | null = null;
    private merkleTrees: Map<string, MerkleTree> = new Map();
    private vaultManager: StorageVaultManager | null = null;
    private vaultStatus: VaultStatus | null = null;
    private shardData: Map<string, Buffer[]> = new Map();
    private relaySocket: Socket | null = null;

    private readonly API_URL = process.env.API_URL || 'http://localhost:3000';
    private readonly HEARTBEAT_MS = 30000; // 30 seconds
    private readonly SECTOR_SIZE = 1024; // 1KB sectors for Merkle tree
    private readonly DATA_DIR = path.join(process.cwd(), 'data');

    constructor() {
        this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, this.provider);
        this.ipfs = createIpfsClient({ url: process.env.KUBO_API_URL || 'http://localhost:5001' });

        if (!fs.existsSync(this.DATA_DIR)) {
            fs.mkdirSync(this.DATA_DIR);
        }

        const proverAddress = process.env.PROOF_VERIFIER_CONTRACT;
        if (proverAddress) {
            const proverABI = [
                'event PoStChallengeCreated(uint256 indexed challengeId, uint256 dealId, address provider)',
                'function submitPoSt(uint256 challengeId, bytes32[] calldata leafData, bytes32[][] calldata proofs) external',
                'function postChallenges(uint256) view returns (uint256 dealId, address provider, uint256 challengeTimestamp, uint256 deadline, bool submitted, bool verified)',
                'function getChallengeIndices(uint256 challengeId) view returns (uint256[])'
            ];
            this.proverContract = new ethers.Contract(proverAddress, proverABI, this.wallet);
        }
    }

    async start() {
        logger.info('🚀 Provider Daemon starting...');
        logger.info(`📍 Provider Address: ${this.wallet.address}`);

        // Initialize Storage Vault
        this.vaultManager = createVaultManagerFromEnv();
        if (this.vaultManager) {
            const success = await this.vaultManager.ensureVaultExists();
            if (!success) {
                logger.error('❌ Failed to initialize storage vault. Exiting.');
                process.exit(1);
            }
            this.vaultStatus = await this.vaultManager.getVaultStatus();
            logger.info(`💾 Storage Vault: ${this.vaultStatus.usedGB}GB / ${this.vaultStatus.capacityGB}GB (${this.vaultStatus.percentUsed}% used)`);
        } else {
            logger.warn('⚠️  Storage vault not configured. Set PLEDGED_CAPACITY_GB in .env');
        }

        try {
            const id = await this.ipfs.id();
            logger.info(`📦 Connected to Kubo: ${id.id}`);
        } catch (e) {
            logger.error('❌ Failed to connect to Kubo. Ensure IPFS is running.');
            process.exit(1);
        }

        // Initialize Proof Verifier listener
        if (this.proverContract) {
            logger.info(`🛡️  Monitoring PoSt challenges at ${this.proverContract.target}`);
            this.proverContract.on('PoStChallengeCreated', async (challengeId, dealId, provider) => {
                if (provider.toLowerCase() === this.wallet.address.toLowerCase()) {
                    await this.handlePoStChallenge(challengeId, dealId);
                }
            });
        } else {
            logger.warn('⚠️  PROOF_VERIFIER_CONTRACT not set. PoSt challenges will not be handled.');
        }

        // Connect to relay WebSocket for real-time deal cancellation events
        this.connectRelaySocket();

        // Start heartbeat
        this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), this.HEARTBEAT_MS);
        this.sendHeartbeat();

        // Start event listener (polling for simplicity in this version)
        this.eventInterval = setInterval(() => this.checkAssignments(), 60000); // Every minute
        this.checkAssignments();

        logger.info('✅ Provider Daemon is active and monitoring.');
    }

    /**
     * Connect to the API relay WebSocket for real-time deal cancellation events
     */
    private connectRelaySocket() {
        try {
            this.relaySocket = ioClient(this.API_URL);

            this.relaySocket.on('connect', () => {
                logger.info('🔌 Connected to API relay WebSocket');
                // Register this provider for RPC
                this.relaySocket!.emit('register:provider', { address: this.wallet.address });
            });

            // Listen for deal cancellation events — triggers immediate cleanup
            this.relaySocket.on('deal:cancelled', async (data: { dealId: string, shardCIDs: string[], providerAddresses: string[] }) => {
                const myAddress = this.wallet.address.toLowerCase();
                const isAffected = data.providerAddresses.some(
                    (addr: string) => addr.toLowerCase() === myAddress
                );

                if (isAffected) {
                    logger.info(`🗑️  Deal #${data.dealId} cancelled — cleaning up ${data.shardCIDs.length} shards immediately`);
                    for (const cid of data.shardCIDs) {
                        await this.unpinAndCleanup(cid);
                    }
                }
            });

            // Respond to RPC peer-id requests from the dashboard
            this.relaySocket.on('rpc:get-peer-id', async (callback: Function) => {
                try {
                    const id = await this.ipfs.id();
                    callback({ peerId: id.id });
                } catch (e) {
                    callback({ error: 'Failed to get peer ID' });
                }
            });

            this.relaySocket.on('disconnect', () => {
                logger.warn('🔌 Disconnected from API relay WebSocket');
            });
        } catch (err: any) {
            logger.warn(`⚠️ Failed to connect relay WebSocket: ${err.message}`);
        }
    }

    private async handlePoStChallenge(challengeId: bigint, dealId: bigint) {
        logger.info(`🎯 Received PoSt Challenge #${challengeId} for Deal #${dealId}`);

        try {
            if (!this.proverContract) return;

            logger.info(`🧪 Generating real Merkle proofs for challenge #${challengeId}...`);

            // We need the shard CID associated with this deal
            const response = await axios.get(`${this.API_URL}/api/deals/${dealId}`);
            const shard = response.data.shards.find((s: any) => s.provider_address === this.wallet.address);

            if (!shard) {
                throw new Error(`No shard found for deal ${dealId} assigned to this provider`);
            }

            const cid = shard.shard_cid;
            let tree = this.merkleTrees.get(cid);
            let sectors = this.shardData.get(cid);

            if (!tree || !sectors) {
                await this.ensurePinned(cid);
                tree = this.merkleTrees.get(cid);
                sectors = this.shardData.get(cid);
            }

            if (!tree || !sectors) {
                throw new Error(`Failed to load Merkle tree for shard ${cid}`);
            }

            // Fetch real challenged indices from contract
            logger.info(`🔍 Fetching challenged indices for challenge #${challengeId}...`);
            const indices = await this.proverContract.getChallengeIndices(challengeId);
            logger.info(`🎯 Challenged indices: [${indices.join(', ')}]`);

            const leafData: string[] = [];
            const proofs: string[][] = [];

            for (const index of indices) {
                const sector = sectors[index % sectors.length];
                leafData.push(ethers.hexlify(sector));

                const proof = tree.getHexProof(keccak256(sector));
                proofs.push(proof);
            }

            logger.info(`📤 Submitting real PoSt proof for challenge #${challengeId}...`);
            const tx = await this.proverContract.submitPoSt(challengeId, leafData, proofs);
            logger.info(`📝 Transaction sent: ${tx.hash}`);

            await tx.wait();
            logger.info(`✅ PoSt proof verified on-chain for challenge #${challengeId}`);

        } catch (error: any) {
            logger.error(`❌ Failed to handle PoSt challenge: ${error.message}`);
        }
    }

    private async sendHeartbeat() {
        try {
            // Update vault status before sending heartbeat
            if (this.vaultManager) {
                this.vaultStatus = await this.vaultManager.getVaultStatus();
            }

            const heartbeatData: any = {
                provider_address: this.wallet.address
            };

            // Include storage vault status in heartbeat
            if (this.vaultStatus) {
                heartbeatData.storage = {
                    pledged_capacity_gb: this.vaultStatus.capacityGB,
                    used_gb: this.vaultStatus.usedGB,
                    available_gb: this.vaultStatus.availableGB,
                    percent_used: this.vaultStatus.percentUsed
                };
            }

            await axios.post(`${this.API_URL}/api/heartbeat`, heartbeatData);

            if (this.vaultStatus) {
                logger.info(`💓 Heartbeat sent (Storage: ${this.vaultStatus.usedGB}GB / ${this.vaultStatus.capacityGB}GB)`);
            } else {
                logger.info('💓 Heartbeat sent');
            }
        } catch (error: any) {
            logger.warn(`⚠️ Heartbeat failed: ${error.message}`);
        }
    }

    private async checkAssignments() {
        try {
            logger.info('🔍 Checking for new shard assignments...');
            const response = await axios.get(`${this.API_URL}/api/providers/${this.wallet.address}`);
            const deals = response.data.deals || [];

            for (const deal of deals) {
                const dealDetail = await axios.get(`${this.API_URL}/api/deals/${deal.deal_id}`);
                const myShards = dealDetail.data.shards.filter((s: any) => s.provider_address === this.wallet.address);

                for (const shard of myShards) {
                    if (shard.active) {
                        await this.ensurePinned(shard.shard_cid);
                    }
                }
            }

            // After pinning active shards, clean up any shards from cancelled/completed/failed deals
            await this.cleanupDeletedShards();
        } catch (error: any) {
            logger.error(`❌ Error checking assignments: ${error.message}`);
        }
    }

    /**
     * Poll the API for shards that should be unpinned and clean them up
     */
    private async cleanupDeletedShards() {
        try {
            logger.info('🧹 Checking for shards to clean up...');
            const response = await axios.get(`${this.API_URL}/api/providers/${this.wallet.address}/cleanup`);
            const { shards, cleanup_count } = response.data;

            if (cleanup_count === 0) {
                logger.info('✅ No shards to clean up.');
                return;
            }

            logger.info(`🗑️  Found ${cleanup_count} shards to clean up`);

            for (const shard of shards) {
                await this.unpinAndCleanup(shard.shard_cid);
            }

            logger.info(`✅ Cleanup complete — ${cleanup_count} shards freed`);
        } catch (error: any) {
            logger.error(`❌ Error during shard cleanup: ${error.message}`);
        }
    }

    /**
     * Unpin a CID from IPFS and free associated in-memory data
     */
    private async unpinAndCleanup(cid: string) {
        try {
            // Unpin from IPFS/Kubo to free disk space
            try {
                await this.ipfs.pin.rm(cid);
                logger.info(`📌 Unpinned shard: ${cid}`);
            } catch (unpinErr: any) {
                // May already be unpinned or not found — that's fine
                if (!unpinErr.message?.includes('not pinned')) {
                    logger.warn(`⚠️ Could not unpin ${cid}: ${unpinErr.message}`);
                }
            }

            // Free in-memory Merkle tree and sector data
            if (this.merkleTrees.has(cid)) {
                this.merkleTrees.delete(cid);
                logger.info(`🌳 Freed Merkle tree for: ${cid}`);
            }
            if (this.shardData.has(cid)) {
                this.shardData.delete(cid);
                logger.info(`💾 Freed sector data for: ${cid}`);
            }

            // Decrease utilization in Vault if configured
            if (this.vaultManager) {
                await this.vaultManager.decreaseUsedGB(1); // Approximation per shard
                logger.info(`💾 Vault utilization decreased by 1GB`);
                // Update local status cache for heartbeat
                this.vaultStatus = await this.vaultManager.getVaultStatus();
            }

            // Trigger IPFS garbage collection to reclaim disk space
            try {
                await this.ipfs.repo.gc();
            } catch (gcErr: any) {
                // GC is best-effort
                logger.debug(`GC note: ${gcErr.message}`);
            }
        } catch (error: any) {
            logger.error(`❌ Failed to cleanup shard ${cid}: ${error.message}`);
        }
    }

    private async ensurePinned(cid: string) {
        try {
            // Check if already pinned
            const pins = await this.ipfs.pin.ls({ paths: cid });
            let isPinned = false;
            for await (const pin of pins) {
                if (pin.cid.toString() === cid) {
                    isPinned = true;
                    break;
                }
            }

            if (!isPinned) {
                logger.info(`📌 Pinning new shard: ${cid}`);
                await this.ipfs.pin.add(cid);
                logger.info(`✅ Shard pinned: ${cid}`);
            }

            // Build Merkle tree if not already in memory
            if (!this.merkleTrees.has(cid)) {
                await this.buildMerkleTree(cid);
            }
        } catch (e) {
            try {
                logger.info(`📌 Pinning new shard: ${cid}`);
                await this.ipfs.pin.add(cid);
                logger.info(`✅ Shard pinned: ${cid}`);
                await this.buildMerkleTree(cid);
            } catch (pinError: any) {
                logger.error(`❌ Failed to pin/process ${cid}: ${pinError.message}`);
            }
        }
    }

    private async buildMerkleTree(cid: string) {
        try {
            logger.info(`🌳 Building Merkle tree for shard ${cid}...`);
            const chunks: Uint8Array[] = [];
            for await (const chunk of this.ipfs.cat(cid)) {
                chunks.push(chunk);
            }
            const data = Buffer.concat(chunks);

            // Split into sectors
            const sectors: Buffer[] = [];
            for (let i = 0; i < data.length; i += this.SECTOR_SIZE) {
                sectors.push(data.subarray(i, Math.min(i + this.SECTOR_SIZE, data.length)));
            }

            // Pad last sector if needed
            if (sectors.length > 0 && sectors[sectors.length - 1].length < this.SECTOR_SIZE) {
                const lastSector = sectors[sectors.length - 1];
                const padded = Buffer.alloc(this.SECTOR_SIZE, 0);
                lastSector.copy(padded);
                sectors[sectors.length - 1] = padded;
            }

            // If too few sectors, add dummy ones to ensure at least CHALLENGE_SECTORS
            while (sectors.length < 10) {
                sectors.push(Buffer.alloc(this.SECTOR_SIZE, 0));
            }

            const leaves = sectors.map(s => keccak256(s));
            const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });

            this.merkleTrees.set(cid, tree);
            this.shardData.set(cid, sectors);

            logger.info(`✅ Merkle tree built for ${cid}. Root: ${tree.getHexRoot()}`);
        } catch (error: any) {
            logger.error(`❌ Failed to build Merkle tree for ${cid}: ${error.message}`);
        }
    }

    stop() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.eventInterval) clearInterval(this.eventInterval);
        if (this.proverContract) this.proverContract.removeAllListeners();
        if (this.relaySocket) this.relaySocket.disconnect();
        logger.info('🛑 Provider Daemon stopped.');
    }
}

const daemon = new ProviderDaemon();
daemon.start().catch(err => {
    logger.error(`💥 Fatal error: ${err.message}`);
    process.exit(1);
});

process.on('SIGINT', () => {
    daemon.stop();
    process.exit(0);
});
