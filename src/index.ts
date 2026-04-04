import { ethers } from 'ethers';
import { create as createIpfsClient } from 'kubo-rpc-client';
import * as dotenv from 'dotenv';
import axios from 'axios';
import winston from 'winston';
import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import * as fs from 'fs';
import * as path from 'path';
import { io as socketClient, Socket } from 'socket.io-client';
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
    private merkleTrees: Map<string, MerkleTree> = new Map();
    private vaultManager: StorageVaultManager | null = null;
    private vaultStatus: VaultStatus | null = null;
    private shardData: Map<string, Buffer[]> = new Map();
    private socket: Socket | null = null;

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

        // Initialize WebSocket Client to the Kyneto API (replaces Express Server + Tunnels)
        try {
            logger.info(`🔌 Connecting to Relay Server at ${this.API_URL}...`);
            this.socket = socketClient(this.API_URL, {
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                reconnectionAttempts: Infinity
            });

            this.socket.on('connect', () => {
                logger.info(`✅ Connected to Kyneto Relay Network! (Socket ID: ${this.socket?.id})`);
                logger.info('📡 Listening for RPC requests...');
                // Register this provider to receive RPC calls
                this.socket?.emit('register:provider', { address: this.wallet.address });
            });

            this.socket.on('disconnect', () => {
                logger.warn('⚠️ Disconnected from Kyneto Relay. Reconnecting...');
            });

            // RPC Handler: Get Peer ID
            this.socket.on('rpc:get-peer-id', async (callback) => {
                logger.info('➡️ Received RPC request: rpc:get-peer-id');
                try {
                    const idInfo = await this.ipfs.id();
                    callback({ peerId: idInfo.id });
                } catch (err: any) {
                    logger.error(`❌ RPC failed to get IPFS Peer ID: ${err.message}`);
                    callback({ error: 'Failed to connect to IPFS' });
                }
            });

            // RPC Handler: Get Status
            this.socket.on('rpc:get-status', (callback) => {
                callback({
                    status: 'online',
                    network: 'Polygon Amoy',
                    providerAddress: this.wallet.address,
                    vaultStatus: this.vaultStatus || 'initializing'
                });
            });

        } catch (socketError: any) {
            logger.error(`❌ Failed to initialize WebSocket client: ${socketError.message}`);
        }

        let retries = 5;
        while (retries > 0) {
            try {
                logger.info(`🔄 Attempting to connect to Kubo (Attempts left: ${retries})...`);
                const id = await this.ipfs.id();
                logger.info(`📦 Connected to Kubo: ${id.id}`);
                break;
            } catch (e: any) {
                if (e.message.includes('no protocol with name: tls')) {
                    logger.warn('⚠️  Kubo returned a "tls" protocol that this client doesn\'t recognize, but we will attempt to proceed anyway.');
                    break;
                }
                retries--;
                if (retries === 0) {
                    logger.error(`❌ Failed to connect to Kubo: ${e.message}`);
                    process.exit(1);
                }
                logger.warn(`⚠️ Kubo not ready yet, retrying in 5 seconds...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
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
        if (this.proverContract) this.proverContract.removeAllListeners();
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
