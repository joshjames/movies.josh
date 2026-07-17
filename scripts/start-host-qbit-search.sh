#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${QBIT_HOST_PROFILE_DIR:-/home/epic/qbit-hostsearch-profile}"
WEBUI_PORT="${QBIT_HOST_WEBUI_PORT:-18080}"
TORRENT_PORT="${QBIT_HOST_TORRENT_PORT:-16881}"

mkdir -p "$PROFILE_DIR"

if ! command -v qbittorrent-nox >/dev/null 2>&1; then
  echo "qbittorrent-nox is not installed on host."
  echo "Install with: sudo apt-get update && sudo apt-get install -y qbittorrent-nox"
  exit 1
fi

echo "Starting host qBittorrent search runtime"
echo "Profile: $PROFILE_DIR"
echo "WebUI:   http://127.0.0.1:${WEBUI_PORT}"
echo "Torrent: ${TORRENT_PORT}"

exec qbittorrent-nox \
  --profile="$PROFILE_DIR" \
  --webui-port="$WEBUI_PORT" \
  --torrenting-port="$TORRENT_PORT"
