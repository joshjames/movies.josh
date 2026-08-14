#!/usr/bin/env bash
# Deploy the latest v2 commit to a secondary/regional node (e.g. Sydney).
#
# Unlike scripts/deploy-compose-versioned.sh (LA's versioned-tag, multi-container,
# NPM-repoint flow, built for zero-disruption rollovers), this is intentionally
# simple: single static image tag, single container, in-place replace. Good
# enough while testing capability on a secondary region; revisit once this
# node runs multiple containers behind a load balancer the same way LA will.

set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "$0")/.." >/dev/null 2>&1 && pwd)
cd "$ROOT_DIR"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "==> Branch: ${CURRENT_BRANCH}"

echo "==> Pulling latest commits"
git pull --ff-only

if docker compose version >/dev/null 2>&1; then
    COMPOSE_BIN=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_BIN=(docker-compose)
else
    echo "ERROR: docker compose/docker-compose not found."
    exit 1
fi

if [[ ! -f .env ]]; then
    echo "ERROR: .env not found in repository root."
    exit 1
fi

APP_CONTAINER_NAME=$(grep -E '^APP_CONTAINER_NAME=' .env | head -n1 | cut -d '=' -f2- || true)
APP_CONTAINER_NAME=${APP_CONTAINER_NAME:-movie-streamer-v2-snode}

echo "==> Building and redeploying ${APP_CONTAINER_NAME}"
"${COMPOSE_BIN[@]}" --project-directory "$ROOT_DIR" -f "$ROOT_DIR/docker-compose.yml" up -d --build movie-streamer

echo "==> Waiting for runtime health endpoint..."
for i in {1..30}; do
    if docker exec "$APP_CONTAINER_NAME" node -e "const http=require('http');const req=http.get('http://127.0.0.1:3000/api/runtime/health',(res)=>{process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.setTimeout(2000,()=>{req.destroy();process.exit(1);});"; then
        echo "==> Health check passed (${APP_CONTAINER_NAME})"
        break
    fi
    if [[ "$i" -eq 30 ]]; then
        echo "ERROR: Health check failed after 30 attempts."
        exit 1
    fi
    sleep 2
done

echo ""
echo "Deployment complete on this node."
echo "Container: ${APP_CONTAINER_NAME}"
echo "Version endpoint (inside container): /api/runtime/version"
