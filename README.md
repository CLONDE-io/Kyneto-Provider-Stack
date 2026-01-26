# Kyneto Provider Node

Run a Kyneto storage provider node on the Polygon Amoy Testnet.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running
- A Polygon Amoy wallet with:
  - POL for gas fees ([Polygon Faucet](https://faucet.polygon.technology/))
  - KYN tokens for staking
- Your wallet's **Private Key**

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

Edit `.env` and set your `PRIVATE_KEY`. All contract addresses are pre-configured.

### 3. Run the Node

```bash
docker-compose up -d
```

This starts:
- **IPFS Node**: Handles file storage and retrieval
- **Provider Daemon**: Manages pledges, deals, and proofs

### 4. View Logs

```bash
docker-compose logs -f provider-node
```

## Apple Silicon (M1/M2/M3) Support

This image supports both Intel and Apple Silicon Macs. No additional configuration needed.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Wallet not connected" | Check your private key in `.env` |
| "Insufficient funds" | Get POL from [Polygon Faucet](https://faucet.polygon.technology/) |
| Docker not running | Open Docker Desktop first |

## For Maintainers

The multi-arch Docker image is automatically built via GitHub Actions when you push to `main`.

To trigger manually:
1. Go to **Actions** → **Build Multi-Arch Docker Image**
2. Click **Run workflow**
