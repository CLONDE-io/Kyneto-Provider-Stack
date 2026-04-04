# Kyneto Provider Node

Run a Kyneto storage provider node on the Polygon Amoy Testnet.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- A Polygon Amoy wallet with:
  - POL for gas fees ([Polygon Faucet](https://faucet.polygon.technology/))
  - KYN tokens for staking
- Your wallet's **Private Key**
- Sufficient disk space for your pledged storage

## Quick Start

### 1. Clone this repository

```bash
git clone https://github.com/CLONDE-io/Kyneto-Provider-Stack.git
cd Kyneto-Provider-Stack
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and configure:

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Your wallet's private key (required) |
| `PLEDGED_CAPACITY_GB` | Storage capacity to pledge in GB (default: 10) |
| `KYNETO_VAULT_PATH` | Path for storage vault (default: ./kyneto-vault) |

> **Important**: `PLEDGED_CAPACITY_GB` must match what you pledge on the dashboard!

### 3. Create Storage Vault Directory

```bash
mkdir -p kyneto-vault
```

### 4. Run the Node

```bash
docker-compose up -d
```

This starts:
- **IPFS Node**: Handles file storage and retrieval
- **Provider Daemon**: Manages pledges, deals, and proofs
- **Storage Vault**: Pre-allocated encrypted storage container

### 5. View Logs

```bash
docker-compose logs -f provider-node
```

You should see:
```
🔐 Initializing Kyneto Storage Vault (10GB)...
✅ Storage Vault ready: 10GB at /data/kyneto-vault
🚀 Provider Daemon starting...
💾 Storage Vault: 0GB / 10GB (0% used)
```

## Storage Vault

The storage vault is a pre-allocated container for your pledged storage. It:

- **Creates a sparse file** that reserves logical space but only uses actual disk as data arrives
- **Prevents over-pledging**: You cannot pledge more storage than you have
- **Reports usage** to the network via heartbeats
- **Visible location**: Check `./kyneto-vault/` on your host machine

### Changing Pledge Size (Increasing)

To increase your storage capacity without losing data:

1. Stop the node: `docker-compose down`
2. Update `PLEDGED_CAPACITY_GB` in `.env` to the new larger value.
3. Start the node: `docker-compose up -d`
4. The node will automatically extend the `vault.img` file (non-destructive).
5. Go to the **Provider Dashboard** and upgrade your pledge to match the new capacity.

> **Note**: Shrinking the vault is not supported to prevent data loss.

## Dashboard & Node Sync

The Kyneto Dashboard and your local node communicate via the **Kyneto API** using a secure "pull-based" architecture:

1. **Heartbeats**: Your node sends a heartbeat every 30 seconds to the API.
2. **Storage Stats**: These heartbeats include your actual storage status (pledged, used, available).
3. **Dashboard View**: When you open the Provider Portal, it fetches these stats from the API.
4. **Capacity Detection**: The dashboard will automatically detect if your node has increased its local `PLEDGED_CAPACITY_GB` and will prompt you to "Upgrade Pledge" on-chain to match.

This ensures the network always has an accurate view of your available storage without requiring you to open any ports on your local machine.

## Apple Silicon (M1/M2/M3) Support


This image supports both Intel and Apple Silicon Macs. No additional configuration needed.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Wallet not connected" | Check your private key in `.env` |
| "Insufficient funds" | Get POL from [Polygon Faucet](https://faucet.polygon.technology/) |
| Docker not running | Open Docker Desktop first |
| "Insufficient disk space" | Free up space or reduce `PLEDGED_CAPACITY_GB` |
| "Vault size mismatch" | Delete `./kyneto-vault/vault.img` and restart |

### Check Vault Status

```bash
# View vault metadata
cat ./kyneto-vault/vault-metadata.json

# Check actual disk usage
du -sh ./kyneto-vault/
```

## For Maintainers

The multi-arch Docker image is automatically built via GitHub Actions when you push to `main`.

To trigger manually:
1. Go to **Actions** → **Build Multi-Arch Docker Image**
2. Click **Run workflow**

