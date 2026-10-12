// src/services/CloudStorageService.js
// Provider-aware cloud storage layer, covering both Cloudflare R2 (the new
// primary backend, 2026-10-12) and Backblaze B2 (the legacy backend, kept
// as the back-catalog source until drained). Remote key naming is IDENTICAL
// regardless of provider (movies/{imdbId}/{profile}.mp4,
// series/{id}/season.NN/sNNeNN/{profile}.mp4), so migrating a file is "same
// key, different bucket" - nothing here ever needs to translate a key.
//
// Why R2 became primary: a live incident (2026-10-12) found B2 uploads
// collapsed to ~10% of normal throughput (TCP congestion window stuck at 1,
// 16% packet retransmission to s3.us-west-004.backblazeb2.com) while a
// side-by-side raw upload to R2 stayed clean at normal speed, same host,
// same moment - isolating the problem to the network path to Backblaze
// specifically. See /home/epic/.claude/plans/peppy-dancing-yao.md for the
// full migration plan this module is part of.
'use strict';

const fs = require('fs');
const path = require('path');
const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const logger = require('./logger');
const { withDistributedLock } = require('./DistributedLockService');

const PROVIDER = { R2: 'r2', B2: 'b2' };

function stripTrailingPath(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}`;
    } catch (_err) {
        return url;
    }
}

const clients = {};
const buckets = {
    [PROVIDER.R2]: process.env.R2_BUCKET_NAME || 'contentanymovie',
    [PROVIDER.B2]: process.env.CLOUD_BUCKET_NAME || 'joshflixmedia'
};

function getBucket(provider) {
    return buckets[provider] || buckets[PROVIDER.B2];
}

// Lazily built, memoized per provider - mirrors CloudSyncWorker.js's
// existing B2 client config (same timeouts). R2 credentials deliberately
// reuse CDN_IMAGES_WRITE_ACCESS_KEY_ID/SECRET - the SAME account-scoped R2
// API token CdnSyncService.js already uses for the images bucket, confirmed
// to also have write access to the content bucket. NOT process.env.
// ACCESS_KEY_ID/SECRET_ACCESS_KEY - those generic names are already used
// elsewhere in .env for something unrelated, and a real B2->R2 copy smoke
// test failed with 403 Access Denied against that wrong credential before
// this was caught.
function getClient(provider) {
    if (clients[provider]) return clients[provider];

    const requestHandler = new NodeHttpHandler({
        connectionTimeout: 10_000,
        requestTimeout: 5 * 60 * 1000
    });

    if (provider === PROVIDER.R2) {
        clients[provider] = new S3Client({
            endpoint: stripTrailingPath(process.env.S3_API || ''),
            region: 'auto',
            credentials: {
                accessKeyId: process.env.CDN_IMAGES_WRITE_ACCESS_KEY_ID,
                secretAccessKey: process.env.CDN_IMAGES_WRITE_SECRET_ACCESS_KEY
            },
            maxAttempts: 3,
            requestHandler
        });
    } else {
        clients[provider] = new S3Client({
            endpoint: process.env.CLOUD_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com',
            credentials: {
                accessKeyId: process.env.BBkeyID,
                secretAccessKey: process.env.BBapplicationKey
            },
            region: process.env.CLOUD_REGION || 'us-west-004',
            maxAttempts: 3,
            requestHandler
        });
    }

    return clients[provider];
}

function cleanKey(key) {
    return String(key || '').replace(/\/+/g, '/').replace(/^\//, '');
}

async function objectExists(provider, key) {
    try {
        await getClient(provider).send(new HeadObjectCommand({ Bucket: getBucket(provider), Key: cleanKey(key) }));
        return true;
    } catch (_err) {
        return false;
    }
}

async function headObjectSize(provider, key) {
    try {
        const result = await getClient(provider).send(new HeadObjectCommand({ Bucket: getBucket(provider), Key: cleanKey(key) }));
        return typeof result.ContentLength === 'number' ? result.ContentLength : null;
    } catch (_err) {
        return null;
    }
}

async function getPresignedUrl(provider, key, { expiresInSec = 7200 } = {}) {
    const command = new GetObjectCommand({ Bucket: getBucket(provider), Key: cleanKey(key) });
    return getSignedUrl(getClient(provider), command, { expiresIn: expiresInSec });
}

// Local-file -> cloud. Same Upload tuning CloudSyncWorker.js's
// uploadLargeFileStream already used for B2 (queueSize 4, 5MiB parts) -
// fs.createReadStream + Upload infers ContentLength from fs.statSync, so no
// chunked/trailer-checksum fallback here.
async function uploadStream(provider, key, localPath, { contentType = 'video/mp4', onProgress } = {}) {
    const fileStream = fs.createReadStream(localPath);
    const uploadWorker = new Upload({
        client: getClient(provider),
        params: { Bucket: getBucket(provider), Key: cleanKey(key), Body: fileStream, ContentType: contentType },
        queueSize: 4,
        partSize: 1024 * 1024 * 5
    });

    if (onProgress) {
        uploadWorker.on('httpUploadProgress', onProgress);
    }

    await uploadWorker.done();
}

// B2 -> R2, streamed directly (GetObject's Body piped straight into R2's
// Upload) with no local disk buffering. ContentLength/ContentType are
// passed through explicitly from the GetObject response - without a known
// length, lib-storage falls back to chunked/trailer-checksum encoding on
// the PUT side, an unconfirmed path for R2 compatibility with multi-GB
// video files.
async function copyObjectB2ToR2(key) {
    const cleaned = cleanKey(key);
    const getResult = await getClient(PROVIDER.B2).send(new GetObjectCommand({ Bucket: getBucket(PROVIDER.B2), Key: cleaned }));

    const uploadWorker = new Upload({
        client: getClient(PROVIDER.R2),
        params: {
            Bucket: getBucket(PROVIDER.R2),
            Key: cleaned,
            Body: getResult.Body,
            ContentLength: getResult.ContentLength,
            ContentType: getResult.ContentType || 'video/mp4'
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5
    });

    await uploadWorker.done();
}

// Fire-and-forget: dedupes concurrent replication attempts for the same key
// via a short-TTL distributed lock (a losing concurrent caller just skips
// rather than blocking/retrying the copy itself - waitMs:1 rather than 0,
// since withDistributedLock's `options.waitMs || DEFAULT_WAIT_MS` treats an
// explicit 0 as falsy and would silently fall back to its 3s default).
// Returns a promise so the bulk sweep job (which wants to await/rate-limit
// each copy) can do so - but a caller on a request path (MediaService.js)
// deliberately does NOT await this, so it's still fire-and-forget there.
// onReplicated (if provided) runs only after a verified successful copy.
function triggerLazyReplication(key, { onReplicated } = {}) {
    const cleaned = cleanKey(key);
    return withDistributedLock(`r2-replicate:${cleaned}`, async () => {
        if (await objectExists(PROVIDER.R2, cleaned)) return; // sweep job (or a prior trigger) may have just finished it
        await copyObjectB2ToR2(cleaned);
        logger.info(`[CloudStorage] Lazily replicated ${cleaned} from B2 to R2.`);
        if (onReplicated) await onReplicated();
    }, { waitMs: 1 }).catch((err) => {
        logger.warn(`[CloudStorage] Lazy replication skipped/failed for ${cleaned}: ${err.message}`);
    });
}

module.exports = {
    PROVIDER,
    getClient,
    getBucket,
    objectExists,
    headObjectSize,
    getPresignedUrl,
    uploadStream,
    copyObjectB2ToR2,
    triggerLazyReplication
};
