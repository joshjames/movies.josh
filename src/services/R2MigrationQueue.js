// src/services/R2MigrationQueue.js
// Persistent cursor/queue for the bulk B2->R2 background migration (see
// CloudStorageService.js and /home/epic/.claude/plans/peppy-dancing-yao.md).
// Two halves: `buildQueue()` (slow, walks the whole library for anything not
// yet provider:'r2' and tops up the persisted file) and `popBatch(n)` (fast,
// pops a few items for the sweep job to actually replicate). Splitting it
// this way avoids re-walking the whole library on every sweep tick - same
// reasoning as CdnSyncService.js's own manifest-file pattern, which this
// mirrors (a small JSON file under METADATA_DIR, read-modify-write, no
// locking needed since the scheduler-worker container is this file's only
// writer).
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getLibrary } = require('./db');
const { resolveMovieFolderPath, resolveSeriesFolderPath } = require('./StoragePathResolver');

const RESOLUTION_PROFILES = ['1080p', '720p', '480p'];

function getQueuePath() {
    const metadataDir = String(process.env.METADATA_DIR || '').trim() || path.join(__dirname, '../../metadata');
    return path.join(metadataDir, 'r2-migration-queue.json');
}

function readQueueFile() {
    try {
        const payload = JSON.parse(fs.readFileSync(getQueuePath(), 'utf-8'));
        return { schemaVersion: 1, generatedAt: payload.generatedAt || null, pending: Array.isArray(payload.pending) ? payload.pending : [] };
    } catch (_err) {
        return { schemaVersion: 1, generatedAt: null, pending: [] };
    }
}

function writeQueueFile(queue) {
    const queuePath = getQueuePath();
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 4), 'utf-8');
}

function readMetadataIfExists(metaPath) {
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

// Walks the whole library (movies + series) for any resolution profile
// that's synced with a remoteKey but not yet provider:'r2', and appends
// anything not already in the persisted queue. Intentionally slow/occasional
// (daily by default via SchedulerService.js) - the sweep job is what
// actually drains it.
async function buildQueue() {
    const queue = readQueueFile();
    const alreadyQueued = new Set(queue.pending.map((item) => `${item.key}`));
    let appended = 0;

    const library = await getLibrary();

    for (const row of (library.movies || [])) {
        const folderName = decodeURIComponent(String(row.id || ''));
        if (!folderName) continue;

        const folderPath = resolveMovieFolderPath(folderName);
        const metaFilePath = path.join(folderPath, 'metadata.json');
        const metadata = readMetadataIfExists(metaFilePath);
        if (!metadata?.storage?.files) continue;

        for (const profile of RESOLUTION_PROFILES) {
            const block = metadata.storage.files[profile];
            if (!block || block.status !== 'synced' || !block.remoteKey || block.provider === 'r2') continue;
            const key = String(block.remoteKey).replace(/\/+/g, '/').replace(/^\//, '');
            if (alreadyQueued.has(key)) continue;

            queue.pending.push({ key, contentType: 'movie', metaFilePath, folderName, profile });
            alreadyQueued.add(key);
            appended += 1;
        }
    }

    for (const row of (library.shows || [])) {
        const folderName = String(row.id || '').replace(/^series\//i, '');
        if (!folderName) continue;

        const showPath = resolveSeriesFolderPath(folderName, { mustExist: true });
        if (!showPath) continue;
        const seriesJsonPath = path.join(showPath, 'series.json');
        const seriesData = readMetadataIfExists(seriesJsonPath);
        if (!seriesData?.seasons) continue;

        for (const seasonEntry of Object.values(seriesData.seasons)) {
            for (const episode of (seasonEntry.episodes || [])) {
                const files = episode.storage?.files || {};
                for (const profile of RESOLUTION_PROFILES) {
                    const block = files[profile];
                    if (!block || block.status !== 'synced' || !block.remoteKey || block.provider === 'r2') continue;
                    const key = String(block.remoteKey).replace(/\/+/g, '/').replace(/^\//, '');
                    if (alreadyQueued.has(key)) continue;

                    queue.pending.push({
                        key, contentType: 'series', metaFilePath: seriesJsonPath, folderName, profile,
                        seasonNumber: seasonEntry.seasonNumber ?? episode.seasonNumber,
                        episodeNumber: episode.episodeNumber
                    });
                    alreadyQueued.add(key);
                    appended += 1;
                }
            }
        }
    }

    queue.generatedAt = new Date().toISOString();
    writeQueueFile(queue);
    logger.info(`[R2MigrationQueue] Build pass complete: ${appended} new item(s) queued, ${queue.pending.length} total pending.`);
    return { appended, totalPending: queue.pending.length };
}

// Pops up to `n` items off the front for the sweep job to replicate,
// re-persisting the remainder immediately. Failures are the sweep job's
// concern to put back (see putBack below) - popBatch itself just hands
// items out.
function popBatch(n) {
    const queue = readQueueFile();
    const batch = queue.pending.splice(0, Math.max(1, n));
    writeQueueFile(queue);
    return batch;
}

// Re-queues an item that failed replication this tick, at the back so a
// persistently-failing item doesn't starve the rest of the queue.
function putBack(item) {
    const queue = readQueueFile();
    queue.pending.push(item);
    writeQueueFile(queue);
}

module.exports = { buildQueue, popBatch, putBack };
