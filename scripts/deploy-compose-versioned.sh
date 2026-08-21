#!/usr/bin/env bash

set -euo pipefail

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
ROOT_DIR=$(cd -- "$(dirname -- "$0")/.." >/dev/null 2>&1 && pwd)
cd "$ROOT_DIR"

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

NPM_URL=$(grep -E '^NPM_URL=' .env | head -n1 | cut -d '=' -f2- || true)
NPM_ADMIN_USER=$(grep -E '^(NPM_ADMIN_USER|PM_ADMIN_USER)=' .env | head -n1 | cut -d '=' -f2- || true)
NPM_ADMIN_PASSWORD=$(grep -E '^NPM_ADMIN_PASSWORD=' .env | head -n1 | cut -d '=' -f2- || true)
NPM_PROXY_DOMAINS=$(grep -E '^NPM_PROXY_DOMAINS=' .env | head -n1 | cut -d '=' -f2- || true)

STAMP=$(date -u +%Y%m%d%H%M%S)
SHORT_SHA=$(git rev-parse --short HEAD)
VERSION_TAG="${CURRENT_BRANCH}-${STAMP}-${SHORT_SHA}"
IMAGE_NAME="simple-streamer:${VERSION_TAG}"
APP_CONTAINER_NAME="movie-streamer-${CURRENT_BRANCH}-${STAMP}"
APP_DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Branch defaults. Keep worker containers stable and only rotate the web container.
COMPOSE_PROJECT_NAME="movie-streamer-v2"
if [[ "$CURRENT_BRANCH" == "edgeplayer" ]]; then
    COMPOSE_PROJECT_NAME="movie-streamer-edgeplayer"
fi

echo "==> Deploy branch: ${CURRENT_BRANCH}"
echo "==> Image tag: ${IMAGE_NAME}"
echo "==> Container: ${APP_CONTAINER_NAME}"
echo "==> Compose project: ${COMPOSE_PROJECT_NAME}"

# All 7 services below share one identical build context/Dockerfile/image
# name (see x-app-common in docker-compose.yml). Passing all 7 to a single
# `up --build` makes Compose build each one as its own buildx bake target
# regardless of the shared image name, so all 7 race to write the exact same
# final tag concurrently - two lose with "already exists" (nondeterministic:
# sometimes wins, sometimes doesn't - neither COMPOSE_BAKE=false nor
# BUILDX_NO_DEFAULT_ATTESTATIONS reliably prevented it, see chat log
# 2026-08-17). The actual fix: build the image exactly once (as a single
# target, so there's nothing to race), then bring every service up without
# rebuilding - they all resolve to the tag that single build already
# produced. Verified clean and deterministic across repeated runs.
# DEPLOY_WORKERS=false restricts the rollout to just the web container - for
# a satellite node (e.g. Sydney) that isn't meant to run the pipeline/worker
# services itself right now and shouldn't have them woken back up as a side
# effect of picking up a code update. Defaults to true (the historical/full
# behavior every other deploy - e.g. LA - still relies on).
DEPLOY_WORKERS=${DEPLOY_WORKERS:-true}
DEPLOY_SERVICES=(movie-streamer)
if [[ "$DEPLOY_WORKERS" == "true" ]]; then
    DEPLOY_SERVICES+=(pipeline-runner ingest-worker metadata-worker subtitle-worker transcoder-worker cloudsync-worker)
fi
echo "==> Deploy workers: ${DEPLOY_WORKERS} (services: ${DEPLOY_SERVICES[*]})"

COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
APP_IMAGE_NAME="$IMAGE_NAME" \
APP_BUILD_VERSION="$VERSION_TAG" \
APP_DEPLOYED_AT="$APP_DEPLOYED_AT" \
"${COMPOSE_BIN[@]}" build movie-streamer

COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
APP_IMAGE_NAME="$IMAGE_NAME" \
APP_CONTAINER_NAME="$APP_CONTAINER_NAME" \
APP_BUILD_VERSION="$VERSION_TAG" \
APP_DEPLOYED_AT="$APP_DEPLOYED_AT" \
"${COMPOSE_BIN[@]}" up -d --no-deps "${DEPLOY_SERVICES[@]}"

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

if [[ -n "$NPM_URL" && -n "$NPM_ADMIN_USER" && -n "$NPM_ADMIN_PASSWORD" ]]; then
    echo "==> Updating NPM proxy host targets via API"
    TARGET_CONTAINER_HOST="$APP_CONTAINER_NAME" \
    TARGET_CONTAINER_PORT="3000" \
    NPM_URL="$NPM_URL" \
    NPM_ADMIN_USER="$NPM_ADMIN_USER" \
    NPM_ADMIN_PASSWORD="$NPM_ADMIN_PASSWORD" \
    NPM_PROXY_DOMAINS="${NPM_PROXY_DOMAINS:-any.movie,www.any.movie,anyseries.online,anymovie.app,anymovie.online,anymovie.digital,anymovie.club,anymovie.today}" \
    node scripts/npm-switch-proxy-hosts.js
else
    echo "==> NPM API update skipped (missing NPM_URL/NPM_ADMIN_USER/NPM_ADMIN_PASSWORD in .env)"
fi

echo ""
echo "Deployment complete."
echo "New container: ${APP_CONTAINER_NAME}"
echo "Image tag: ${IMAGE_NAME}"
echo "Version endpoint (inside container): /api/runtime/version"
echo "Metrics endpoint: /api/runtime/metrics"
echo ""
echo "Next step: in NPM, update proxy destination to http://${APP_CONTAINER_NAME}:3000 when ready."
