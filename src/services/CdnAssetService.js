// src/services/CdnAssetService.js
// Maps origin-relative image paths onto the Cloudflare R2 image CDN (images.any.movie).
//
// Rewriting is manifest-gated: an asset is only pointed at the edge if the sync job
// (scripts/cdn-sync-images.sh) confirmed the object exists in the bucket. Anything not
// in the manifest keeps its origin path, so a partial or stale sync degrades to the
// current behaviour rather than to broken images.

const fs = require('fs');
const path = require('path');

// Origin URL prefix -> object key prefix inside the bucket.
// Order matters: '/movie-assets/series/' must be checked before the plain
// '/movie-assets/' entry, since the former is also a prefix match of the latter.
const PREFIX_MAP = [
    ['/images/catalog-covers/', 'catalog-covers/'],
    ['/images/tv-covers/', 'tv-covers/'],
    ['/movie-assets/series/', 'movie-assets/series/'],
    ['/movie-assets/', 'movie-assets/']
];

// TV covers are emitted as an API path rather than a static path, but the route is a
// thin cache-or-fetch wrapper over the same tv-covers/<imdbId>.jpg object, so it maps
// onto the bucket just like a static prefix does.
const PATTERN_MAP = [
    [/^\/api\/tv-shows\/(tt\d+)\/cover$/i, (match) => `tv-covers/${match[1].toLowerCase()}.jpg`]
];

const MANIFEST_RELOAD_INTERVAL_MS = 30_000;

let manifestKeys = new Set();
let manifestMtimeMs = 0;
let manifestLastCheckedAt = 0;
let manifestPathCache = null;

function parseBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function isEnabled() {
    return parseBool(process.env.CDN_IMAGES_ENABLED, false);
}

function getBaseUrl() {
    return String(process.env.CDN_IMAGES_BASE_URL || '').trim().replace(/\/+$/, '');
}

function getManifestPath() {
    const explicit = String(process.env.CDN_IMAGES_MANIFEST_PATH || '').trim();
    if (explicit) return explicit;

    // Defaults to the shared metadata volume so the host sync job and the container
    // read the same file (/app/metadata -> /home/epic/movie-streamer-data).
    const metadataDir = String(process.env.METADATA_DIR || '').trim()
        || path.join(__dirname, '../../metadata');
    return path.join(metadataDir, 'cdn-images-manifest.json');
}

function loadManifest() {
    const now = Date.now();
    if (now - manifestLastCheckedAt < MANIFEST_RELOAD_INTERVAL_MS) return;
    manifestLastCheckedAt = now;

    const filePath = getManifestPath();

    // A changed manifest path (test harness, env reload) must force a re-read.
    if (filePath !== manifestPathCache) {
        manifestPathCache = filePath;
        manifestMtimeMs = 0;
    }

    let stats;
    try {
        stats = fs.statSync(filePath);
    } catch (_err) {
        // No manifest yet -> nothing is edge-safe.
        if (manifestKeys.size > 0) manifestKeys = new Set();
        manifestMtimeMs = 0;
        return;
    }

    if (stats.mtimeMs === manifestMtimeMs) return;

    try {
        const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        manifestKeys = new Set(Array.isArray(payload.keys) ? payload.keys : []);
        manifestMtimeMs = stats.mtimeMs;
    } catch (_err) {
        // Keep the previous good manifest rather than blanking the CDN mid-flight.
    }
}

function toObjectKey(publicUrl = '') {
    const clean = String(publicUrl || '').trim().split('?')[0].split('#')[0];
    if (!clean) return '';

    for (const [urlPrefix, keyPrefix] of PREFIX_MAP) {
        if (!clean.startsWith(urlPrefix)) continue;
        const fileName = clean.slice(urlPrefix.length);
        if (!fileName || fileName.includes('..')) return '';
        return `${keyPrefix}${decodeURIComponent(fileName)}`;
    }

    for (const [pattern, toKey] of PATTERN_MAP) {
        const match = clean.match(pattern);
        if (match) return toKey(match);
    }

    return '';
}

/**
 * Resolve an origin-relative asset path to its CDN URL.
 * Returns '' when the asset should keep its origin path.
 */
function toCdnUrl(publicUrl = '') {
    if (!isEnabled()) return '';

    const baseUrl = getBaseUrl();
    if (!baseUrl) return '';

    const objectKey = toObjectKey(publicUrl);
    if (!objectKey) return '';

    loadManifest();
    if (!manifestKeys.has(objectKey)) return '';

    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
    return `${baseUrl}/${encodedKey}`;
}

/** Diagnostics for /api/admin health surfaces. */
function getStatus() {
    loadManifest();
    return {
        enabled: isEnabled(),
        baseUrl: getBaseUrl(),
        manifestPath: getManifestPath(),
        manifestKeyCount: manifestKeys.size,
        manifestMtime: manifestMtimeMs ? new Date(manifestMtimeMs).toISOString() : null,
        mappedPrefixes: PREFIX_MAP.map(([urlPrefix, keyPrefix]) => ({ urlPrefix, keyPrefix })),
        mappedPatterns: PATTERN_MAP.map(([pattern]) => String(pattern))
    };
}

/** Test hook — drops cached manifest state so the next call re-reads from disk. */
function resetCache() {
    manifestKeys = new Set();
    manifestMtimeMs = 0;
    manifestLastCheckedAt = 0;
    manifestPathCache = null;
}

module.exports = {
    toCdnUrl,
    toObjectKey,
    getStatus,
    resetCache
};
