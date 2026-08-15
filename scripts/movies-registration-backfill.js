#!/usr/bin/env node

// Backfill for movies that fell through the cracks of the manual "drop file +
// marker + library scan" workflow (see MEMORY: that path only ever writes a
// bare metadata stub, never calls OMDB, and never enqueues a real pipeline
// job - so SUBTITLES/TRANSCODE/CLOUDSYNC never ran for anything added this
// way). Covers three categories found by scanning /home/epic/movies:
//
//   A. No metadata.json at all (and has a real video file - skips things
//      like a stray audiobook folder) -> full chain: METADATA -> TRANSCODE ->
//      cloud-backfill.js's upload step.
//   B. Has metadata.json but no cover.jpg -> re-run METADATA just to backfill
//      the poster (title/plot/etc get refreshed too, which is fine/desired).
//   C. Has metadata.json but no .web.mp4 (never transcoded) -> TRANSCODE ->
//      cloud-backfill.js's upload step.
//
// Each worker call uses that worker's own real logic (OMDB lookup, ffmpeg
// remux/audio-fix/full-reencode decision, S3 upload) - this script is purely
// an orchestrator, same shape as scripts/cloud-backfill.js.
//
// Must run inside a container (e.g. `docker exec movie-streamer-cloudsync-worker
// node scripts/movies-registration-backfill.js`), not on the bare host: the
// worker containers only see their own mounted paths (/app/storage/movies,
// not /home/epic/movies), and metadata.json is root-owned from being written
// by the (root) app containers - a host-run process can't write it either.
// Defaults below match the same env vars the real app containers already use
// (MOVIES_DIR, WORKER_URL_METADATA, WORKER_URL_TRANSCODE), so this just works
// when run where it belongs without needing any special configuration.
//
// Usage (from inside a container):
//   node scripts/movies-registration-backfill.js --dry-run
//   node scripts/movies-registration-backfill.js
//   node scripts/movies-registration-backfill.js --skip-cover-only

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const MetadataRegistry = require('../src/services/MetadataRegistry');

const METADATA_URL = process.env.WORKER_URL_METADATA || process.env.BACKFILL_METADATA_URL || 'http://metadata-worker:5001/process';
const TRANSCODE_URL = process.env.WORKER_URL_TRANSCODE || process.env.BACKFILL_TRANSCODE_URL || 'http://transcoder-worker:5003/process';
const MOVIES_ROOT = process.env.MOVIES_DIR || process.env.BACKFILL_MOVIES_DIR || '/app/storage/movies';
const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv)$/i;
const REQUEST_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3h ceiling - a full re-encode of a large file can be slow

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

function hasVideoFile(folderPath) {
    try {
        return fs.readdirSync(folderPath).some((f) => VIDEO_EXT.test(f));
    } catch (_err) {
        return false;
    }
}

function hasWebMp4(folderPath) {
    try {
        return fs.readdirSync(folderPath).some((f) => f.toLowerCase().endsWith('.web.mp4'));
    } catch (_err) {
        return false;
    }
}

function scanMovies() {
    const categories = { unregistered: [], missingCover: [], needsTranscode: [] };
    let entries;
    try {
        entries = fs.readdirSync(MOVIES_ROOT, { withFileTypes: true });
    } catch (err) {
        console.warn(`[movies-backfill] Could not read movies root ${MOVIES_ROOT}: ${err.message}`);
        return categories;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.toLowerCase() === 'series') continue;
        const folderPath = path.join(MOVIES_ROOT, entry.name);
        const metaPath = path.join(folderPath, 'metadata.json');
        const item = { folderName: entry.name, folderPath, metaPath };

        if (!fs.existsSync(metaPath)) {
            if (hasVideoFile(folderPath)) categories.unregistered.push(item);
            continue;
        }

        if (!fs.existsSync(path.join(folderPath, 'cover.jpg'))) {
            categories.missingCover.push(item);
        }
        if (!hasWebMp4(folderPath)) {
            categories.needsTranscode.push(item);
        }
    }

    return categories;
}

async function callWorker(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return res.json();
}

async function fetchMetadataAndCover(item, { fullRegister }) {
    const body = await callWorker(METADATA_URL, {
        folderPath: item.folderPath,
        folderName: item.folderName,
        contentType: 'movie'
    });
    if (body.success === false) {
        throw new Error(body.error || 'metadata worker returned failure');
    }

    const patch = body.patchData || {};
    await MetadataRegistry.mergeAndCommit(item.metaPath, item.folderName, async (current) => ({
        ...current,
        ...patch,
        contentType: 'movie',
        addedAt: current.addedAt || new Date().toISOString(),
        storage: current.storage || { location: 'local', files: {} },
        pipelineState: {
            currentStep: fullRegister ? 'TRANSCODE' : (current.pipelineState?.currentStep || 'COMPLETED'),
            lastUpdated: new Date().toISOString(),
            error: null
        }
    }));

    return patch;
}

async function transcode(item) {
    const body = await callWorker(TRANSCODE_URL, {
        folderPath: item.folderPath,
        folderName: item.folderName,
        contentType: 'movie'
    });
    if (body.success === false) {
        throw new Error(body.error || 'transcode worker returned failure');
    }
    return body;
}

// Reuses the already-built, already-tested movie cloud-sync backfill script
// (scans for a locally-transcoded profile with no remoteKey yet and uploads
// it) instead of duplicating its pending-flag + upload logic here.
function cloudSyncViaExistingBackfillScript(folderName) {
    const scriptPath = path.join(__dirname, 'cloud-backfill.js');
    // cloud-backfill.js's own defaults predate running it from inside a
    // container via this orchestrator - point it at the same movies root
    // this script resolved, and at the cloudsync worker's internal service
    // name/port rather than its host-published one.
    const output = execFileSync('node', [scriptPath, '--only', folderName], {
        encoding: 'utf-8',
        env: {
            ...process.env,
            BACKFILL_MOVIES_DIR: MOVIES_ROOT,
            // 127.0.0.1, not the service DNS name - see series-transcode-cloudsync-backfill.js
            // for why (hairpin NAT silently black-holed responses after large uploads).
            CLOUDSYNC_BACKFILL_URL: process.env.CLOUDSYNC_BACKFILL_URL || 'http://127.0.0.1:5004/process'
        }
    });
    console.log(output.trim().split('\n').map((line) => `    ${line}`).join('\n'));
}

async function main() {
    const flags = parseArgs(process.argv);
    const dryRun = parseBool(flags['dry-run'], false);
    const skipCoverOnly = parseBool(flags['skip-cover-only'], false);

    const categories = scanMovies();
    console.log(`[movies-backfill] Unregistered (no metadata.json): ${categories.unregistered.length}`);
    categories.unregistered.forEach((i) => console.log(`  - ${i.folderName}`));
    console.log(`[movies-backfill] Has metadata but missing cover.jpg: ${categories.missingCover.length}`);
    categories.missingCover.forEach((i) => console.log(`  - ${i.folderName}`));
    console.log(`[movies-backfill] Has metadata but never transcoded: ${categories.needsTranscode.length}`);
    categories.needsTranscode.forEach((i) => console.log(`  - ${i.folderName}`));

    if (dryRun) {
        console.log('[movies-backfill] Dry run complete. No changes made.');
        return;
    }

    const totalItems = categories.unregistered.length
        + (skipCoverOnly ? 0 : categories.missingCover.length)
        + categories.needsTranscode.length;

    let ok = 0;
    let failed = 0;
    let doneCount = 0;
    const startedAt = Date.now();

    function logProgress() {
        doneCount += 1;
        const elapsedMin = (Date.now() - startedAt) / 60000;
        console.log(`[movies-backfill] Progress: ${doneCount}/${totalItems} (ok=${ok} failed=${failed}) - ${elapsedMin.toFixed(1)}m elapsed`);
    }

    for (const item of categories.unregistered) {
        console.log(`\n[movies-backfill] === [UNREGISTERED] ${item.folderName} ===`);
        try {
            console.log('[movies-backfill] Fetching metadata + cover...');
            const patch = await fetchMetadataAndCover(item, { fullRegister: true });
            console.log(`[movies-backfill]   -> imdbId=${patch.imdbId || 'unknown'} title="${patch.title || item.folderName}"`);

            console.log('[movies-backfill] Transcoding...');
            const t = await transcode(item);
            console.log(`[movies-backfill]   -> ${t.message || 'transcode complete'}`);

            console.log('[movies-backfill] Uploading to cloud storage...');
            cloudSyncViaExistingBackfillScript(item.folderName);

            ok += 1;
        } catch (err) {
            failed += 1;
            console.warn(`[movies-backfill] FAILED ${item.folderName}: ${err.message}`);
        }
        logProgress();
    }

    if (!skipCoverOnly) {
        for (const item of categories.missingCover) {
            console.log(`\n[movies-backfill] === [MISSING COVER] ${item.folderName} ===`);
            try {
                const patch = await fetchMetadataAndCover(item, { fullRegister: false });
                console.log(`[movies-backfill]   -> refreshed metadata/cover (imdbId=${patch.imdbId || 'unknown'})`);
                ok += 1;
            } catch (err) {
                failed += 1;
                console.warn(`[movies-backfill] FAILED ${item.folderName}: ${err.message}`);
            }
            logProgress();
        }
    }

    for (const item of categories.needsTranscode) {
        console.log(`\n[movies-backfill] === [NEEDS TRANSCODE] ${item.folderName} ===`);
        try {
            console.log('[movies-backfill] Transcoding...');
            const t = await transcode(item);
            console.log(`[movies-backfill]   -> ${t.message || 'transcode complete'}`);

            console.log('[movies-backfill] Uploading to cloud storage...');
            cloudSyncViaExistingBackfillScript(item.folderName);

            ok += 1;
        } catch (err) {
            failed += 1;
            console.warn(`[movies-backfill] FAILED ${item.folderName}: ${err.message}`);
        }
        logProgress();
    }

    console.log(`\n[movies-backfill] Done. OK=${ok} Failed=${failed} Total=${totalItems}`);
}

main().catch((err) => {
    console.error('[movies-backfill] Fatal error:', err.message || err);
    process.exit(1);
});
