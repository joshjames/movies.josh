=#!/usr/bin/env bash
echo "🎬 Ingesting custom qBittorrent profile maps into host volumes..."

# Define your project root path context safely
REPO_CONFIG_DIR="./.configs/qbittorrent"
TARGET_CONFIG_DIR="/home/epic/qbittorrent/config/qBittorrent"

# 1. Ensure all host-level media maps and data volumes exist
PATHS=(
    "/home/epic/movies"
    "/data/blockchain/media"
    "/home/epic/movie-streamer-data"
    "/home/epic/tobedel"
    "/home/epic/.config/subliminal"
    "$TARGET_CONFIG_DIR"
    "/home/epic/redis/data"
)

for path in "${PATHS[@]}"; do
    if [ ! -d "$path" ]; then
        mkdir -p "$path"
    fi
done

# 2. Safely clone your pre-configured configurations into the target mount
if [ -d "$REPO_CONFIG_DIR" ]; then
    echo "⚙️ Injecting categories, tags, and engine configurations..."
    cp -r "$REPO_CONFIG_DIR"/* "$TARGET_CONFIG_DIR/"
    
    # Secure ownership mapping so the container's 1000:1000 user context can mutate states
    chown -R 1000:1000 /home/epic/qbittorrent/config
    echo "✅ Setup profiles successfully loaded into live storage maps."
else
    echo "❌ Error: Could not find configurations at $REPO_CONFIG_DIR"
fi