#!/usr/bin/env node

// Controlled backfill for TV series: runs TRANSCODE then CLOUDSYNC for every
// already-registered series folder. Both worker endpoints already walk an
// entire series root internally (every season, every episode in one call),
// so this script's only job is to iterate series folders and call the two
// endpoints in order - no per-episode logic needed here.
//
// TRANSCODE picks the cheapest sufficient pass per episode automatically
// (remux / audio-fix / full re-encode - see TranscoderWorker.js), extracts
// embedded subtitles, and correctly marks the preferred audio track as
// default for multi-track sources. CLOUDSYNC only uploads episodes that
// don't already have a remoteKey, so this is safe to re-run.
//
// Must run inside a container (e.g. `docker exec movie-streamer-cloudsync-worker
// node scripts/series-transcode-cloudsync-backfill.js`), not on the bare
// host: the worker containers only see their own mounted path
// (/app/storage/series, not /data/blockchain/media/Series). SERIES_DIR and
// WORKER_URL_TRANSCODE default to the same env vars the real app containers
// already use. CLOUDSYNC deliberately does NOT reuse WORKER_URL_CLOUDSYNC -
// see the constant below for why.
//
// Usage (from inside a container):
//   node scripts/series-transcode-cloudsync-backfill.js --dry-run
//   node scripts/series-transcode-cloudsync-backfill.js
//   node scripts/series-transcode-cloudsync-backfill.js --only "Furious.2026,Dark.2017"

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TRANSCODE_URL = process.env.WORKER_URL_TRANSCODE || process.env.BACKFILL_TRANSCODE_URL || 'http://transcoder-worker:5003/process';
// 127.0.0.1, not the 'cloudsync-worker' service DNS name: this script always
// runs via `docker exec` inside the cloudsync-worker container itself (see
// header), and calling a container's own published port through its service
// name hairpins back out through the docker bridge/NAT - which silently
// black-holed the HTTP response after large (multi-GB) uploads in production.
const CLOUDSYNC_URL = process.env.BACKFILL_CLOUDSYNC_URL || 'http://127.0.0.1:5004/process';
const SERIES_ROOT = process.env.SERIES_DIR || process.env.BACKFILL_SERIES_DIR || '/app/storage/series';
const REQUEST_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h ceiling - a season pack can have many episodes to re-encode

function parseArgs(argv) {
    const flags = {};
    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            flags[key] = 'true';
            continue;
        }
        flags[key] = next;
        i += 1;
    }
    return flags;
}

function parseBool(value, fallback = false) {
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function listSeriesFolders() {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(SERIES_ROOT, { withFileTypes: true });
    } catch (err) {
        console.warn(`[series-backfill] Could not read series root ${SERIES_ROOT}: ${err.message}`);
        return out;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folderPath = path.join(SERIES_ROOT, entry.name);
        const metaPath = path.join(folderPath, 'metadata.json');
        if (!fs.existsSync(metaPath)) continue; // not a registered series - out of scope here
        out.push({ folderName: entry.name, folderPath, metaPath });
    }
    return out;
}

function readImdbId(metaPath) {
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        return meta.imdbId || meta.imdb_id || meta.imdbID || null;
    } catch (_err) {
        return null;
    }
}

// axios, not fetch(): Node's built-in fetch (undici) enforces its own
// default 5-minute headersTimeout/bodyTimeout underneath any AbortSignal we
// pass in, so a season pack that legitimately takes longer than 5 minutes
// to transcode/upload gets killed with a generic "fetch failed" even though
// the worker keeps working and finishes server-side. axios has no such
// hidden floor - only the timeout we explicitly set applies. This matches
// how PipelineWorker.js already calls these same endpoints.
async function callWorker(url, payload) {
    const res = await axios.post(url, payload, { timeout: REQUEST_TIMEOUT_MS });
    return res.data;
}

async function main() {
    const flags = parseArgs(process.argv);
    const dryRun = parseBool(flags['dry-run'], false);
    const only = flags.only
        ? new Set(String(flags.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
        : null;

    let items = listSeriesFolders();
    if (only) {
        items = items.filter((i) => only.has(i.folderName.toLowerCase()));
    }

    console.log(`[series-backfill] ${items.length} registered series folder(s) to process.`);
    items.forEach((i) => console.log(`  - ${i.folderName}`));

    if (dryRun) {
        console.log('[series-backfill] Dry run complete. No changes made.');
        return;
    }

    let ok = 0;
    let failed = 0;
    const startedAt = Date.now();

    for (const item of items) {
        const imdbId = readImdbId(item.metaPath);
        console.log(`\n[series-backfill] === ${item.folderName} ===`);
        try {
            console.log('[series-backfill] Transcoding (skips episodes that already have a .web.mp4)...');
            const t = await callWorker(TRANSCODE_URL, {
                folderPath: item.folderPath,
                folderName: item.folderName,
                contentType: 'series'
            });
            if (t.success === false) throw new Error(t.error || 'transcode failed');
            console.log(`[series-backfill]   -> ${t.message || 'done'} (processed=${t.processedCount ?? '?'}, skipped=${t.skippedCount ?? '?'})`);

            console.log('[series-backfill] Uploading newly-transcoded episodes to cloud storage...');
            const c = await callWorker(CLOUDSYNC_URL, {
                folderPath: item.folderPath,
                folderName: item.folderName,
                contentType: 'series',
                imdbId,
                forceActualUpload: true
            });
            if (c.success === false) throw new Error(c.error || 'cloudsync failed');
            console.log(`[series-backfill]   -> ${c.message || 'done'}`);

            ok += 1;
        } catch (err) {
            failed += 1;
            console.warn(`[series-backfill] FAILED ${item.folderName}: ${err.message}`);
        }

        const elapsedMin = (Date.now() - startedAt) / 60000;
        console.log(`[series-backfill] Progress: ${ok + failed}/${items.length} (ok=${ok} failed=${failed}) - ${elapsedMin.toFixed(1)}m elapsed`);
    }

    console.log(`\n[series-backfill] Done. OK=${ok} Failed=${failed} Total=${items.length}`);
}

main()
    .then(() => process.exit(0)) // required: the redis client's open socket
                                  // otherwise keeps the process alive forever
                                  // after main() resolves, hanging the parent
                                  // execFileSync/backfill call indefinitely.
    .catch((err) => {
        console.error('[series-backfill] Fatal error:', err.message || err);
        process.exit(1);
    });
