#!/usr/bin/env bash
# scripts/cdn-sync-images.sh
# Replicate image assets to the Cloudflare R2 image bucket behind images.any.movie,
# then regenerate the CDN manifest the app uses to decide which keys are edge-safe.
#
# Usage:
#   ./scripts/cdn-sync-images.sh              # sync everything, then rebuild manifest
#   ./scripts/cdn-sync-images.sh --dry-run    # show what would transfer, change nothing
#   ./scripts/cdn-sync-images.sh --only tv-covers
#   ./scripts/cdn-sync-images.sh --manifest-only
#
# Credentials come from cftoken.env (account-scoped R2 keys). The bucket-scoped keys in
# .env are limited to contentanymovie and will fail with AccessDenied here.
#
# movie-assets and movie-assets/series point at the 1.2TB movies/series volumes, which
# are otherwise full of video/subtitle/metadata files. Only *cover.jpg one level below
# the source root is included (see FILTERS below) — nothing else in those trees is ever
# read for upload.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CRED_FILE="${CDN_CRED_FILE:-$REPO_ROOT/cftoken.env}"
BUCKET="${R2_IMAGES_BUCKET:-imagesanymovie}"
CDN_BASE="${CDN_IMAGES_BASE_URL:-https://images.any.movie}"
MANIFEST_DIR="${METADATA_HOST_DIR:-/home/epic/movie-streamer-data}"
MANIFEST_PATH="$MANIFEST_DIR/cdn-images-manifest.json"

# Covers are addressed by IMDb id and always emitted with a ?v=<mtime> token by
# CoverUrlService, so the object itself can be treated as immutable at the edge.
IMMUTABLE_CACHE_CONTROL="public, max-age=31536000, immutable"

DRY_RUN=""
ONLY=""
MANIFEST_ONLY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)       DRY_RUN="--dry-run"; shift ;;
        --only)          ONLY="$2"; shift 2 ;;
        --manifest-only) MANIFEST_ONLY="1"; shift ;;
        -h|--help)       sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [[ ! -f "$CRED_FILE" ]]; then
    echo "❌ Credential file not found: $CRED_FILE" >&2
    exit 1
fi

# shellcheck disable=SC1090
set -a; . "$CRED_FILE"; set +a

: "${ACCESS_ID:?ACCESS_ID (Cloudflare account id) missing from $CRED_FILE}"
: "${ACCESS_KEY_ID:?ACCESS_KEY_ID missing from $CRED_FILE}"
: "${SECRET_ACCESS_KEY:?SECRET_ACCESS_KEY missing from $CRED_FILE}"

R2_ENDPOINT="https://${ACCESS_ID}.r2.cloudflarestorage.com"

RCLONE_ARGS=(
    --s3-provider Cloudflare
    --s3-region auto
    --s3-endpoint "$R2_ENDPOINT"
    --s3-access-key-id "$ACCESS_KEY_ID"
    --s3-secret-access-key "$SECRET_ACCESS_KEY"
    --s3-no-check-bucket
    # R2 does not return the trailing-checksum headers rclone expects for multipart
    # uploads; posters are small enough that single-part uploads are correct anyway.
    --s3-upload-cutoff 200M
    --transfers 32
    --checkers 32
    --fast-list
    --stats-one-line
    --stats 5s
)

MOVIES_HOST_DIR="${MOVIES_HOST_DIR:-/home/epic/movies}"
SERIES_HOST_DIR="${SERIES_HOST_DIR:-/data/blockchain/media/Series}"

# key = destination prefix in the bucket, value = local source directory
declare -A SOURCES=(
    ["catalog-covers"]="$REPO_ROOT/public/images/catalog-covers"
    ["tv-covers"]="$MANIFEST_DIR/tv-covers"
    ["movie-assets"]="$MOVIES_HOST_DIR"
    ["movie-assets/series"]="$SERIES_HOST_DIR"
)

# Per-prefix rclone --include filter. Empty means "everything in the source dir",
# which is correct for the flat cover-only directories but must never be used for
# movie-assets/* — those sources hold the full media library.
declare -A FILTERS=(
    ["movie-assets"]="*/cover.jpg"
    ["movie-assets/series"]="*/cover.jpg"
)

sync_prefix() {
    local prefix="$1"
    local src="${SOURCES[$prefix]}"
    local filter="${FILTERS[$prefix]:-}"

    if [[ ! -d "$src" ]]; then
        echo "⚠️  Skipping $prefix — source directory missing: $src"
        return 0
    fi

    local filter_args=()
    local count
    if [[ -n "$filter" ]]; then
        filter_args=(--include "$filter")
        count="$(find "$src" -mindepth 2 -maxdepth 2 -name "$(basename "$filter")" -type f | wc -l)"
    else
        count="$(find "$src" -type f | wc -l)"
    fi
    echo "📤 $prefix  <-  $src  ($count files)${filter:+, filter: $filter}"

    # --include alone is not depth-limited in rclone (it matches the basename pattern
    # regardless of how many directories precede it), so a filtered sync also needs
    # --max-depth to keep season-level covers (movies/Show/Season.01/cover.jpg) out.
    if [[ -n "$filter" ]]; then
        filter_args+=(--max-depth 2)
    fi

    rclone sync "$src" ":s3:${BUCKET}/${prefix}" \
        "${RCLONE_ARGS[@]}" \
        "${filter_args[@]}" \
        ${DRY_RUN:+$DRY_RUN} \
        --header-upload "Cache-Control: $IMMUTABLE_CACHE_CONTROL" \
        --exclude ".*" \
        --exclude "*.tmp" \
        --exclude "*.part"
}

if [[ -z "$MANIFEST_ONLY" ]]; then
    echo "🌐 Bucket:   $BUCKET"
    echo "🌐 Endpoint: $R2_ENDPOINT"
    echo "🌐 CDN base: $CDN_BASE"
    [[ -n "$DRY_RUN" ]] && echo "🧪 DRY RUN — nothing will be written"
    echo

    if [[ -n "$ONLY" ]]; then
        if [[ -z "${SOURCES[$ONLY]+x}" ]]; then
            echo "❌ Unknown prefix '$ONLY'. Known: ${!SOURCES[*]}" >&2
            exit 2
        fi
        sync_prefix "$ONLY"
    else
        for prefix in "${!SOURCES[@]}"; do
            sync_prefix "$prefix"
        done
    fi
    echo
fi

if [[ -n "$DRY_RUN" ]]; then
    echo "🧪 Dry run complete — manifest left untouched."
    exit 0
fi

echo "🧾 Rebuilding manifest -> $MANIFEST_PATH"
mkdir -p "$MANIFEST_DIR"

TMP_KEYS="$(mktemp)"
trap 'rm -f "$TMP_KEYS"' EXIT

rclone lsf -R --files-only ":s3:${BUCKET}" "${RCLONE_ARGS[@]}" > "$TMP_KEYS"

CDN_BASE="$CDN_BASE" BUCKET="$BUCKET" MANIFEST_PATH="$MANIFEST_PATH" \
    node "$REPO_ROOT/scripts/cdn-build-images-manifest.js" "$TMP_KEYS"

echo
echo "✅ Done. Spot check:"
echo "   curl -sI $CDN_BASE/catalog-covers/tt0111161.jpg"
