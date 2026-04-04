"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ethers_1 = require("ethers");
const ipfs_http_client_1 = require("ipfs-http-client");
const dotenv = __importStar(require("dotenv"));
const axios_1 = __importDefault(require("axios"));
const winston_1 = __importDefault(require("winston"));
const merkletreejs_1 = require("merkletreejs");
const keccak256_1 = __importDefault(require("keccak256"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const storage_vault_1 = require("./storage-vault");
dotenv.config();
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)),
    transports: [new winston_1.default.transports.Console()]
});
class ProviderDaemon {
    constructor() {
        this.proverContract = null;
        this.heartbeatInterval = null;
        this.eventInterval = null;
        this.merkleTrees = new Map();
        this.vaultManager = null;
        this.vaultStatus = null;
        this.shardData = new Map();
        this.API_URL = process.env.API_URL || 'http://localhost:3000';
        this.HEARTBEAT_MS = 30000; // 30 seconds
        this.SECTOR_SIZE = 1024; // 1KB sectors for Merkle tree
        this.DATA_DIR = path.join(process.cwd(), 'data');
        this.provider = new ethers_1.ethers.JsonRpcProvider(process.env.RPC_URL);
        this.wallet = new ethers_1.ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
        this.ipfs = (0, ipfs_http_client_1.create)({ url: process.env.KUBO_API_URL || 'http://localhost:5001' });
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
            this.proverContract = new ethers_1.ethers.Contract(proverAddress, proverABI, this.wallet);
        }
    }
    async start() {
        logger.info('🚀 Provider Daemon starting...');
        logger.info(`📍 Provider Address: ${this.wallet.address}`);
        // Initialize Storage Vault
        this.vaultManager = (0, storage_vault_1.createVaultManagerFromEnv)();
        if (this.vaultManager) {
            const success = await this.vaultManager.ensureVaultExists();
            if (!success) {
                logger.error('❌ Failed to initialize storage vault. Exiting.');
                process.exit(1);
            }
            this.vaultStatus = await this.vaultManager.getVaultStatus();
            logger.info(`💾 Storage Vault: ${this.vaultStatus.usedGB}GB / ${this.vaultStatus.capacityGB}GB (${this.vaultStatus.percentUsed}% used)`);
        }
        else {
            logger.warn('⚠️  Storage vault not configured. Set PLEDGED_CAPACITY_GB in .env');
        }
        try {
            const id = await this.ipfs.id();
            logger.info(`📦 Connected to Kubo: ${id.id}`);
        }
        catch (e) {
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
        }
        else {
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
    async handlePoStChallenge(challengeId, dealId) {
        logger.info(`🎯 Received PoSt Challenge #${challengeId} for Deal #${dealId}`);
        try {
            if (!this.proverContract)
                return;
            logger.info(`🧪 Generating real Merkle proofs for challenge #${challengeId}...`);
            // We need the shard CID associated with this deal
            const response = await axios_1.default.get(`${this.API_URL}/api/deals/${dealId}`);
            const shard = response.data.shards.find((s) => s.provider_address === this.wallet.address);
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
            const leafData = [];
            const proofs = [];
            for (const index of indices) {
                const sector = sectors[index % sectors.length];
                leafData.push(ethers_1.ethers.hexlify(sector));
                const proof = tree.getHexProof((0, keccak256_1.default)(sector));
                proofs.push(proof);
            }
            logger.info(`📤 Submitting real PoSt proof for challenge #${challengeId}...`);
            const tx = await this.proverContract.submitPoSt(challengeId, leafData, proofs);
            logger.info(`📝 Transaction sent: ${tx.hash}`);
            await tx.wait();
            logger.info(`✅ PoSt proof verified on-chain for challenge #${challengeId}`);
        }
        catch (error) {
            logger.error(`❌ Failed to handle PoSt challenge: ${error.message}`);
        }
    }
    async sendHeartbeat() {
        try {
            // Update vault status before sending heartbeat
            if (this.vaultManager) {
                this.vaultStatus = await this.vaultManager.getVaultStatus();
            }
            const heartbeatData = {
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
            await axios_1.default.post(`${this.API_URL}/api/heartbeat`, heartbeatData);
            if (this.vaultStatus) {
                logger.info(`💓 Heartbeat sent (Storage: ${this.vaultStatus.usedGB}GB / ${this.vaultStatus.capacityGB}GB)`);
            }
            else {
                logger.info('💓 Heartbeat sent');
            }
        }
        catch (error) {
            logger.warn(`⚠️ Heartbeat failed: ${error.message}`);
        }
    }
    async checkAssignments() {
        try {
            logger.info('🔍 Checking for new shard assignments...');
            const response = await axios_1.default.get(`${this.API_URL}/api/providers/${this.wallet.address}`);
            const deals = response.data.deals || [];
            for (const deal of deals) {
                const dealDetail = await axios_1.default.get(`${this.API_URL}/api/deals/${deal.deal_id}`);
                const myShards = dealDetail.data.shards.filter((s) => s.provider_address === this.wallet.address);
                for (const shard of myShards) {
                    if (shard.active) {
                        await this.ensurePinned(shard.shard_cid);
                    }
                }
            }
        }
        catch (error) {
            logger.error(`❌ Error checking assignments: ${error.message}`);
        }
    }
    async ensurePinned(cid) {
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
        }
        catch (e) {
            try {
                logger.info(`📌 Pinning new shard: ${cid}`);
                await this.ipfs.pin.add(cid);
                logger.info(`✅ Shard pinned: ${cid}`);
                await this.buildMerkleTree(cid);
            }
            catch (pinError) {
                logger.error(`❌ Failed to pin/process ${cid}: ${pinError.message}`);
            }
        }
    }
    async buildMerkleTree(cid) {
        try {
            logger.info(`🌳 Building Merkle tree for shard ${cid}...`);
            const chunks = [];
            for await (const chunk of this.ipfs.cat(cid)) {
                chunks.push(chunk);
            }
            const data = Buffer.concat(chunks);
            // Split into sectors
            const sectors = [];
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
            const leaves = sectors.map(s => (0, keccak256_1.default)(s));
            const tree = new merkletreejs_1.MerkleTree(leaves, keccak256_1.default, { sortPairs: true });
            this.merkleTrees.set(cid, tree);
            this.shardData.set(cid, sectors);
            logger.info(`✅ Merkle tree built for ${cid}. Root: ${tree.getHexRoot()}`);
        }
        catch (error) {
            logger.error(`❌ Failed to build Merkle tree for ${cid}: ${error.message}`);
        }
    }
    stop() {
        if (this.heartbeatInterval)
            clearInterval(this.heartbeatInterval);
        if (this.eventInterval)
            clearInterval(this.eventInterval);
        if (this.proverContract)
            this.proverContract.removeAllListeners();
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
//# sourceMappingURL=index.js.map