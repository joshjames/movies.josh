// src/services/CdnSyncService.js
// Real-time, single-object accelerator for the image CDN (images.any.movie).
//
// scripts/cdn-sync-images.sh remains the source of truth for bulk reconciliation; this
// module exists so a cover doesn't have to wait for the next scheduled/manual sync to
// reach the edge after a title is ingested, a poster is replaced, or a folder is
// renamed. It is best-effort: if write credentials are absent or a push/delete fails, it
// quietly no-ops and the asset simply serves from origin (or keeps its stale CDN key)
// until the next bulk sync reconciles it. A failure here must never fail the caller.
//
// Manifest updates are read-modify-write with no locking. The only two writers are this
// process and the metadata-worker container, cover changes are infrequent, and a lost
// update just means one key is missing until the next bulk sync — acceptable given the
// alternative (a locking scheme) for how rarely it can actually collide.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { resolveMovieFolderPath, resolveSeriesFolderPath } = require('./StoragePathResolver');

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

let s3Client = null;
let PutObjectCommand = null;
let DeleteObjectCommand = null;

function parseBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function isWriteEnabled() {
    return parseBool(process.env.CDN_IMAGES_WRITE_ENABLED, false)
        && Boolean(process.env.CDN_IMAGES_WRITE_ACCESS_KEY_ID)
        && Boolean(process.env.CDN_IMAGES_WRITE_SECRET_ACCESS_KEY)
        && Boolean(process.env.ACCOUNT_ID);
}

function getBucket() {
    return String(process.env.R2_IMAGES_BUCKET || 'imagesanymovie').trim();
}

function getBaseUrl() {
    return String(process.env.CDN_IMAGES_BASE_URL || '').trim().replace(/\/+$/, '');
}

function getManifestPath() {
    const explicit = String(process.env.CDN_IMAGES_MANIFEST_PATH || '').trim();
    if (explicit) return explicit;

    const metadataDir = String(process.env.METADATA_DIR || '').trim()
        || path.join(__dirname, '../../metadata');
    return path.join(metadataDir, 'cdn-images-manifest.json');
}

// Lazy require so a deployment without write credentials never even loads the S3 SDK
// path through this module (CdnAssetService's read-only path has no such dependency).
function getClient() {
    if (s3Client) return s3Client;

    const { S3Client, PutObjectCommand: Put, DeleteObjectCommand: Delete } = require('@aws-sdk/client-s3');
    PutObjectCommand = Put;
    DeleteObjectCommand = Delete;

    s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.CDN_IMAGES_WRITE_ACCESS_KEY_ID,
            secretAccessKey: process.env.CDN_IMAGES_WRITE_SECRET_ACCESS_KEY
        }
    });

    return s3Client;
}

function readManifestKeys(manifestPath) {
    try {
        const payload = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        return Array.isArray(payload.keys) ? payload.keys : [];
    } catch (_err) {
        return [];
    }
}

function countsByPrefix(keys) {
    const counts = {};
    for (const key of keys) {
        const prefix = key.includes('/') ? key.slice(0, key.indexOf('/')) : '(root)';
        counts[prefix] = (counts[prefix] || 0) + 1;
    }
    return counts;
}

function writeManifestKeys(manifestPath, keys) {
    const sorted = [...new Set(keys)].sort();
    const payload = {
        schemaVersion: 1,
        bucket: getBucket(),
        baseUrl: getBaseUrl(),
        generatedAt: new Date().toISOString(),
        totalKeys: sorted.length,
        countsByPrefix: countsByPrefix(sorted),
        keys: sorted
    };

    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const tmpPath = `${manifestPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tmpPath, manifestPath);
}

function addKeyToManifest(objectKey) {
    const manifestPath = getManifestPath();
    const keys = readManifestKeys(manifestPath);
    if (keys.includes(objectKey)) return;
    writeManifestKeys(manifestPath, [...keys, objectKey]);
}

function removeKeyFromManifest(objectKey) {
    const manifestPath = getManifestPath();
    const keys = readManifestKeys(manifestPath);
    if (!keys.includes(objectKey)) return;
    writeManifestKeys(manifestPath, keys.filter((key) => key !== objectKey));
}

/** Upload one local file to the bucket and, only on success, record it in the manifest. */
async function pushObject(objectKey, localFilePath, { contentType = 'image/jpeg' } = {}) {
    if (!isWriteEnabled()) return false;
    if (!objectKey || !localFilePath || !fs.existsSync(localFilePath)) return false;

    try {
        const client = getClient();
        await client.send(new PutObjectCommand({
            Bucket: getBucket(),
            Key: objectKey,
            Body: fs.readFileSync(localFilePath),
            ContentType: contentType,
            CacheControl: IMMUTABLE_CACHE_CONTROL
        }));
        addKeyToManifest(objectKey);
        logger.info(`☁️ [CDN] Pushed ${objectKey}`);
        return true;
    } catch (err) {
        logger.warn(`⚠️ [CDN] Push failed for ${objectKey}: ${err.message}`);
        return false;
    }
}

/** Delete one object from the bucket and, only on success, drop it from the manifest. */
async function deleteObject(objectKey) {
    if (!isWriteEnabled()) return false;
    if (!objectKey) return false;

    try {
        const client = getClient();
        await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: objectKey }));
        removeKeyFromManifest(objectKey);
        logger.info(`☁️ [CDN] Deleted ${objectKey}`);
        return true;
    } catch (err) {
        logger.warn(`⚠️ [CDN] Delete failed for ${objectKey}: ${err.message}`);
        return false;
    }
}

// --- Convenience wrappers matching CdnAssetService's key scheme ---

function movieCoverKey(folder) { return `movie-assets/${folder}/cover.jpg`; }
function seriesCoverKey(folder) { return `movie-assets/series/${folder}/cover.jpg`; }
function catalogCoverKey(imdbId) { return `catalog-covers/${imdbId}.jpg`; }
function tvCoverKey(imdbId) { return `tv-covers/${imdbId}.jpg`; }

function pushMovieCover(folder) {
    const folderPath = resolveMovieFolderPath(folder);
    if (!folderPath) return Promise.resolve(false);
    return pushObject(movieCoverKey(folder), path.join(folderPath, 'cover.jpg'));
}

function pushSeriesCover(folder) {
    const folderPath = resolveSeriesFolderPath(folder);
    if (!folderPath) return Promise.resolve(false);
    return pushObject(seriesCoverKey(folder), path.join(folderPath, 'cover.jpg'));
}

function pushCoverForContentType(contentType, folder) {
    return String(contentType || '').toLowerCase() === 'series'
        ? pushSeriesCover(folder)
        : pushMovieCover(folder);
}

function deleteMovieCover(folder) { return deleteObject(movieCoverKey(folder)); }
function deleteSeriesCover(folder) { return deleteObject(seriesCoverKey(folder)); }

function deleteCoverForContentType(contentType, folder) {
    return String(contentType || '').toLowerCase() === 'series'
        ? deleteSeriesCover(folder)
        : deleteMovieCover(folder);
}

function pushCatalogCover(imdbId, localFilePath) {
    return pushObject(catalogCoverKey(imdbId), localFilePath);
}

function pushTvCover(imdbId, localFilePath) {
    return pushObject(tvCoverKey(imdbId), localFilePath);
}

function getStatus() {
    return {
        writeEnabled: isWriteEnabled(),
        bucket: getBucket(),
        baseUrl: getBaseUrl(),
        manifestPath: getManifestPath()
    };
}

module.exports = {
    isWriteEnabled,
    pushObject,
    deleteObject,
    pushMovieCover,
    pushSeriesCover,
    pushCoverForContentType,
    deleteMovieCover,
    deleteSeriesCover,
    deleteCoverForContentType,
    pushCatalogCover,
    pushTvCover,
    getStatus
};
