#!/usr/bin/env node

// One-off backfill for the movie library: CloudSyncWorker only ever acts on
// files a caller has already marked storage.files[profile].status='pending'
// (see src/services/workers/CloudSyncWorker.js), and that only happens today
// as a side effect of new ingests. This script finds existing, already-local
// movies with no remoteKey yet, marks the profiles that have a matching local
// file 'pending' via the same locked MetadataRegistry path the rest of the
// app uses, then calls the cloudsync-worker to actually upload them.
//
// Series are intentionally out of scope for this pass - CloudSyncWorker's
// remote key convention is hardcoded to `movies/<id>/<profile>.mp4` regardless
// of content type, so series backfill needs its own look before reusing this.
//
// Usage:
//   node scripts/cloud-backfill.js --dry-run            # report only, no writes/uploads
//   node scripts/cloud-backfill.js --limit 20            # upload only the top 20 (by popularity)
//   node scripts/cloud-backfill.js --concurrency 2       # parallel uploads (default 1)
//
// Note: when run directly on the host (not inside a container), REDIS_URL
// from .env points at a container-only DNS name and won't resolve. That's
// fine - MetadataRegistry/DistributedLockService both degrade to disk-only,
// locked-write-skipped behavior when Redis is unreachable (see db.js). The
// authoritative state change still lands correctly because the cloudsync-
// worker itself reads/writes metadata.json directly, the same way it does
// for normal ingest traffic.

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const MetadataRegistry = require('../src/services/MetadataRegistry');

const RESOLUTION_PROFILES = ['1080p', '720p', '480p'];
const CLOUDSYNC_URL = process.env.CLOUDSYNC_BACKFILL_URL || 'http://localhost:5104/process';

// StoragePathResolver's MOVIES_DIR comes from .env, which holds the
// in-container path (/app/storage/movies) - correct for the app's own
// processes, meaningless for this script running as a bare host process.
// This intentionally uses its own env var with the real host path as the
// default instead of fighting that resolver.
const MOVIES_ROOT = process.env.BACKFILL_MOVIES_DIR || '/home/epic/movies';

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

function findLocalVideoFile(folderPath, profile, fileBlock) {
    if (fileBlock && fileBlock.localPath) {
        const candidate = path.join(folderPath, fileBlock.localPath);
        if (fs.existsSync(candidate)) return candidate;
    }

    let files;
    try {
        files = fs.readdirSync(folderPath);
    } catch (_err) {
        return null;
    }

    const suffix = profile === '1080p' ? '.web.mp4' : `.${profile}.mp4`;
    const match = files.find((f) => f.endsWith(suffix));
    return match ? path.join(folderPath, match) : null;
}

function listCandidateMovies() {
    const out = [];
    if (!fs.existsSync(MOVIES_ROOT)) {
        console.warn(`[cloud-backfill] Movies root does not exist: ${MOVIES_ROOT}`);
        return out;
    }

    let entries;
    try {
        entries = fs.readdirSync(MOVIES_ROOT, { withFileTypes: true });
    } catch (err) {
        console.warn(`[cloud-backfill] Could not read movies root ${MOVIES_ROOT}: ${err.message}`);
        return out;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // The library also nests a top-level "series" folder inside the movies
        // root on this host; that's out of scope for this movies-only pass.
        if (entry.name.toLowerCase() === 'series') continue;

        const folderPath = path.join(MOVIES_ROOT, entry.name);
        const metaPath = path.join(folderPath, 'metadata.json');
        if (fs.existsSync(metaPath)) {
            out.push({ folderName: entry.name, folderPath, metaPath });
        }
    }

    return out;
}

function popularityScore(metadata) {
    const raw = String(metadata?.enrichment?.popularity ?? metadata?.popularity ?? '').replace(/,/g, '');
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
}

function gb(bytes) {
    return (bytes / 1024 ** 3).toFixed(2);
}

async function main() {
    const flags = parseArgs(process.argv);
    const dryRun = parseBool(flags['dry-run'], false);
    const limit = flags.limit ? Number(flags.limit) : Infinity;
    const concurrency = Math.max(1, Number(flags.concurrency || 1));
    const only = flags.only
        ? new Set(String(flags.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
        : null;

    console.log(`[cloud-backfill] dryRun=${dryRun} limit=${limit === Infinity ? 'none' : limit} concurrency=${concurrency}`);
    console.log(`[cloud-backfill] cloudsync worker: ${CLOUDSYNC_URL}`);

    let candidates = listCandidateMovies();
    if (only) {
        candidates = candidates.filter((c) => only.has(c.folderName.toLowerCase()));
    }
    console.log(`[cloud-backfill] Scanning ${candidates.length} movie folders...`);

    const work = [];
    for (const { folderName, folderPath, metaPath } of candidates) {
        let metadata;
        try {
            metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        } catch (err) {
            console.warn(`[cloud-backfill] Skipping ${folderName}: unreadable metadata.json (${err.message})`);
            continue;
        }

        const storageFiles = metadata?.storage?.files || {};
        const pendingProfiles = [];
        let totalBytes = 0;

        for (const profile of RESOLUTION_PROFILES) {
            const fileBlock = storageFiles[profile];
            if (fileBlock && fileBlock.remoteKey) continue; // already synced

            const localPath = findLocalVideoFile(folderPath, profile, fileBlock);
            if (!localPath) continue; // nothing local for this profile

            let size = 0;
            try {
                size = fs.statSync(localPath).size;
            } catch (_err) {
                // ignore
            }
            pendingProfiles.push(profile);
            totalBytes += size;
        }

        if (pendingProfiles.length === 0) continue;
        work.push({ folderName, folderPath, metaPath, metadata, pendingProfiles, totalBytes });
    }

    work.sort((a, b) => popularityScore(b.metadata) - popularityScore(a.metadata));
    const selected = work.slice(0, limit);
    const grandTotalBytes = selected.reduce((sum, w) => sum + w.totalBytes, 0);

    console.log(`[cloud-backfill] ${selected.length} of ${candidates.length} movie folders need upload(s).`);
    console.log(`[cloud-backfill] Estimated total upload size: ${gb(grandTotalBytes)} GB`);

    if (dryRun) {
        selected.slice(0, 40).forEach((w) => {
            console.log(`  - ${w.folderName}: ${w.pendingProfiles.join(',')} (${gb(w.totalBytes)} GB)`);
        });
        if (selected.length > 40) console.log(`  ...and ${selected.length - 40} more`);
        console.log('[cloud-backfill] Dry run complete. No metadata changed, nothing uploaded.');
        return;
    }

    let completedCount = 0;
    let failedCount = 0;
    let uploadedBytes = 0;
    const startedAt = Date.now();

    async function processOne(item) {
        const { folderName, folderPath, metaPath, pendingProfiles, totalBytes } = item;
        try {
            await MetadataRegistry.mergeAndCommit(metaPath, folderName, async (current) => {
                const next = { ...current };
                next.storage = next.storage || { location: 'local', files: {} };
                next.storage.files = { ...next.storage.files };
                for (const profile of pendingProfiles) {
                    const existing = next.storage.files[profile] || {};
                    if (existing.remoteKey) continue; // synced by someone else since we scanned
                    next.storage.files[profile] = { ...existing, status: 'pending' };
                }
                return next;
            });

            const res = await fetch(CLOUDSYNC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath, folderName, forceActualUpload: true })
            });
            const body = await res.json().catch(() => ({}));

            if (!res.ok || !body.success) {
                failedCount += 1;
                console.warn(`[cloud-backfill] FAILED ${folderName}: ${body.error || res.statusText}`);
                return;
            }

            completedCount += 1;
            uploadedBytes += totalBytes;
            const elapsedMin = (Date.now() - startedAt) / 60000;
            console.log(
                `[cloud-backfill] OK ${folderName} (${pendingProfiles.join(',')}) - `
                + `${completedCount}/${selected.length} done, ${gb(uploadedBytes)} GB uploaded, ${elapsedMin.toFixed(1)}m elapsed`
            );
        } catch (err) {
            failedCount += 1;
            console.warn(`[cloud-backfill] ERROR ${folderName}: ${err.message}`);
        }
    }

    let cursor = 0;
    async function worker() {
        while (cursor < selected.length) {
            const item = selected[cursor];
            cursor += 1;
            // eslint-disable-next-line no-await-in-loop
            await processOne(item);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));

    console.log(`[cloud-backfill] Done. Completed=${completedCount} Failed=${failedCount} Total=${selected.length}`);
}

main().catch((err) => {
    console.error('[cloud-backfill] Fatal error:', err.message || err);
    process.exit(1);
});
