import { ethers } from 'ethers';
import { create as createIpfsClient } from 'kubo-rpc-client';
import * as dotenv from 'dotenv';
import axios from 'axios';
import winston from 'winston';
import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import * as fs from 'fs';
import * as path from 'path';
import { StorageVaultManager, createVaultManagerFromEnv, VaultStatus } from './storage-vault.js';

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
    private postPollInterval: NodeJS.Timeout | null = null;
    private lastPolledBlock: number = 0;
    private merkleTrees: Map<string, MerkleTree> = new Map();
    private vaultManager: StorageVaultManager | null = null;
    private vaultStatus: VaultStatus | null = null;
    private shardData: Map<string, Buffer[]> = new Map();

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

        let connected = false;
        for (let i = 0; i < 5; i++) {
            try {
                const id = await this.ipfs.id();
                logger.info(`📦 Connected to Kubo: ${id.id}`);
                connected = true;
                break;
            } catch (e: any) {
                logger.warn(`⚠️ Waiting for Kubo API... (${e.message})`);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
        if (!connected) {
            logger.error('❌ Failed to connect to Kubo after multiple attempts. Exiting.');
            process.exit(1);
        }

        // Initialize Proof Verifier listener via block polling
        // (Public RPC nodes expire event filters, causing "filter not found" errors
        //  with ethers .on(). Polling avoids this entirely.)
        if (this.proverContract) {
            logger.info(`🛡️  Monitoring PoSt challenges at ${this.proverContract.target}`);
            this.lastPolledBlock = await this.provider.getBlockNumber();
            this.postPollInterval = setInterval(() => this.pollPoStChallenges(), 15000); // Every 15s
            this.pollPoStChallenges(); // Check immediately
        } else {
            logger.warn('⚠️  PROOF_VERIFIER_CONTRACT not set. PoSt challenges will not be handled.');
        }

        // Start heartbeat
        this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), this.HEARTBEAT_MS);
        this.sendHeartbeat();

        // Start event listener (polling for simplicity in this version)
        this.eventInterval = setInterval(() => this.checkAssignments(), 60000); // Every minute
        this.checkAssignments();

        logger.info('✅ Provider Daemon is active and monitoring.');
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

    /**
     * Poll for PoStChallengeCreated events by querying recent blocks.
     * This avoids the "filter not found" error from public RPC nodes.
     */
    private async pollPoStChallenges() {
        try {
            if (!this.proverContract) return;

            const currentBlock = await this.provider.getBlockNumber();
            if (currentBlock <= this.lastPolledBlock) return;

            const fromBlock = this.lastPolledBlock + 1;
            const toBlock = currentBlock;

            const filter = this.proverContract.filters.PoStChallengeCreated();
            const events = await this.proverContract.queryFilter(filter, fromBlock, toBlock);

            for (const event of events) {
                const parsed = event as ethers.EventLog;
                const challengeId = parsed.args[0];
                const dealId = parsed.args[1];
                const provider = parsed.args[2];

                if (provider.toLowerCase() === this.wallet.address.toLowerCase()) {
                    await this.handlePoStChallenge(challengeId, dealId);
                }
            }

            this.lastPolledBlock = toBlock;
        } catch (error: any) {
            logger.warn(`⚠️ PoSt poll error: ${error.message}`);
        }
    }

    private async sendHeartbeat() {
        try {
            // Update vault status before sending heartbeat
            if (this.vaultManager) {
                this.vaultStatus = await this.vaultManager.getVaultStatus();
            }

            // Sign the heartbeat message (EIP-191) — required by the server
            const message = `Kyneto Provider Heartbeat`;
            const signature = await this.wallet.signMessage(message);

            const heartbeatData: any = {
                provider_address: this.wallet.address,
                signature
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
        } catch (error: any) {
            logger.error(`❌ Error checking assignments: ${error.message}`);
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
        if (this.postPollInterval) clearInterval(this.postPollInterval);
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
