#!/bin/bash
# Kyneto Storage Vault Initialization Script
# This script runs before IPFS starts to ensure the storage vault exists

set -e

VAULT_PATH="${KYNETO_VAULT_PATH:-/data/kyneto-vault}"
VAULT_FILE="$VAULT_PATH/vault.img"
CAPACITY_GB="${PLEDGED_CAPACITY_GB:-10}"
IPFS_DATA="$VAULT_PATH/ipfs-data"

echo "🔐 Kyneto Storage Vault Initialization"
echo "   Capacity: ${CAPACITY_GB}GB"
echo "   Path: $VAULT_PATH"

# Create vault directory if it doesn't exist
if [ ! -d "$VAULT_PATH" ]; then
    echo "📁 Creating vault directory..."
    mkdir -p "$VAULT_PATH"
fi

# Check if vault file already exists
if [ -f "$VAULT_FILE" ]; then
    EXISTING_SIZE=$(stat -c%s "$VAULT_FILE" 2>/dev/null || stat -f%z "$VAULT_FILE")
    EXISTING_GB=$((EXISTING_SIZE / 1073741824))
    echo "✅ Vault exists: ${EXISTING_GB}GB"
    
    if [ "$CAPACITY_GB" -gt "$EXISTING_GB" ]; then
        echo "📈 Increasing vault size from ${EXISTING_GB}GB to ${CAPACITY_GB}GB..."
        # Extend sparse file (non-destructive)
        truncate -s "${CAPACITY_GB}G" "$VAULT_FILE"
        echo "✅ Vault extended successfully"
    elif [ "$CAPACITY_GB" -lt "$EXISTING_GB" ]; then
        echo "⚠️  Warning: Requested capacity (${CAPACITY_GB}GB) is smaller than existing vault (${EXISTING_GB}GB)"
        echo "   Shrinking is not supported to prevent data loss. Keeping existing size."
    fi
else
    # Check available disk space
    AVAILABLE_KB=$(df -k "$VAULT_PATH" | tail -1 | awk '{print $4}')
    AVAILABLE_GB=$((AVAILABLE_KB / 1048576))
    
    if [ "$AVAILABLE_GB" -lt "$CAPACITY_GB" ]; then
        echo "❌ Insufficient disk space!"
        echo "   Need: ${CAPACITY_GB}GB"
        echo "   Available: ${AVAILABLE_GB}GB"
        exit 1
    fi
    
    echo "🔨 Creating ${CAPACITY_GB}GB sparse vault file..."
    
    # Create sparse file (only uses space as data is written)
    truncate -s "${CAPACITY_GB}G" "$VAULT_FILE"
    
    echo "✅ Vault file created: $VAULT_FILE"
fi

# Create IPFS data directory inside vault
if [ ! -d "$IPFS_DATA" ]; then
    echo "📁 Creating IPFS data directory..."
    mkdir -p "$IPFS_DATA"
fi

# Write vault metadata
cat > "$VAULT_PATH/vault-metadata.json" << EOF
{
    "version": "1.0.0",
    "created_at": "$(date -Iseconds)",
    "capacity_gb": $CAPACITY_GB,
    "vault_file": "$VAULT_FILE",
    "ipfs_data": "$IPFS_DATA"
}
EOF

echo "✅ Storage Vault ready: ${CAPACITY_GB}GB at $VAULT_PATH"
echo ""

# Execute the original command (passed as arguments)
exec "$@"
