# Kyneto Provider Node Setup

This guide explains how to run a Kyneto Provider Node on the Polygon Amoy Testnet.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) installed and running.
- A Polygon Amoy wallet with some POL (for gas) and KYN tokens (for staking).
- Your wallet's **Private Key**.

## For Maintainers (Building the Image)

If you are the developer distributing this stack:
1.  Run the publish script to build and push the image to Docker Hub:
    ```powershell
    .\publish_provider.ps1
    ```

## Quick Start (For Testers)

1.  **Navigate to the provider stack directory `provider-stack` :**
    ```bash
    cd provider-stack
    ```

2.  **Configure Environment `provider-stack/.env` :**
    Copy the example environment file, and rename it to `.env`:
    ```bash
    cp .env.example .env
    ```
    Open `.env` and set your `PRIVATE_KEY`. The contract addresses are already pre-configured for the Amoy Testnet.

3.  **Run the Node `provider-stack/docker-compose.yml` :**
    ```bash
    docker-compose up -d
    ```
    This will start:
    - **IPFS Node**: Handles file storage and retrieval.
    - **Provider Daemon**: Manages pledges, deals, and proofs.

4.  **Verify Status `provider-stack/docker-compose.yml` :**
    Check the logs to ensure everything is running smoothly:
    ```bash
    docker-compose logs -f provider-node
    ```

## Registration

Once your node is running, it will automatically attempt to register and create a capacity pledge if you have configured it to do so (or you can use the CLI tools if available).

## Troubleshooting

- **"Wallet not connected"**: Ensure your private key is correct in `provider-stack/.env`.
- **"Insufficient funds"**: You need POL for gas fees. Get some from the [Polygon Faucet](https://faucet.polygon.technology/).
