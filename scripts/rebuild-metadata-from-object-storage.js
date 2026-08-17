#!/usr/bin/env node

// Disaster-recovery reconciliation: the LA server (primary - ran qBittorrent,
// all 5 pipeline workers, and did the actual transcode + cloud upload work)
// was cut off (unpaid hosting bill) mid-way through a movies+series backfill
// that was uploading to Backblaze B2. The LA -> Sydney app-state rsync
// (sync-app-folders.sh) never caught up to the last few items that finished
// uploading before the cutoff, so Sydney's local metadata.json/series.json
// files are stale: some media is actually sitting in the B2 bucket already,
// but Sydney's manifests still say "pending"/unavailable and won't offer
// cloud playback for it.
//
// This script is the source-of-truth reversal: instead of trusting the
// (stale, unreachable) LA manifests, it lists what's ACTUALLY in the B2
// bucket and patches Sydney's local manifests to match, using the exact
// same storage.files[profile] = {status:'synced', remoteKey} shape that
// CloudSyncWorker.js writes, so playback (MediaService.getPlaybackUrl /
// resolveEpisodeCloudPlaybackUrl) picks it up with zero other changes.
//
// It never removes or downgrades existing state - only fills in gaps found
// in the bucket that the local manifest doesn't know about yet. Safe to
// re-run any number of times.
//
// Must run inside a container that has the /app/storage/movies and
// /app/storage/series mounts and a working redis connection (e.g.
// `docker exec movie-streamer-v2-snode node scripts/rebuild-metadata-from-object-storage.js`)
// - same reason as the other backfill scripts: MetadataRegistry needs redis,
// and the host-side paths differ from the container's mounted paths.
//
// Usage:
//   node scripts/rebuild-metadata-from-object-storage.js --dry-run
//   node scripts/rebuild-metadata-from-object-storage.js --execute
//   node scripts/rebuild-metadata-from-object-storage.js --execute --only "Dark.2017,From"

'use strict';

const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

const MetadataRegistry = require('../src/services/MetadataRegistry');

const BUCKET_NAME = process.env.CLOUD_BUCKET_NAME || 'joshflixmedia';
const RESOLUTION_PROFILES = ['1080p', '720p', '480p'];
const MOVIES_ROOT = process.env.MOVIES_DIR || process.env.BACKFILL_MOVIES_DIR || '/app/storage/movies';
const SERIES_ROOT = process.env.SERIES_DIR || process.env.BACKFILL_SERIES_DIR || '/app/storage/series';

const s3Client = new S3Client({
    endpoint: process.env.CLOUD_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com',
    credentials: {
        accessKeyId: process.env.BBkeyID,
        secretAccessKey: process.env.BBapplicationKey
    },
    region: process.env.CLOUD_REGION || 'us-west-004',
    maxAttempts: 3,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 10_000, requestTimeout: 5 * 60 * 1000 })
});

function parseArgs(argv) {
    const flags = {};
    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) { flags[key] = 'true'; continue; }
        flags[key] = next;
        i += 1;
    }
    return flags;
}

const MOVIE_KEY_RE = /^movies\/([^/]+)\/([^/]+)\.mp4$/;
const SERIES_KEY_RE = /^series\/([^/]+)\/season\.(\d+)\/s(\d+)e(\d+)\/([^/]+)\.mp4$/;

async function listAllObjects() {
    const objects = [];
    let continuationToken;
    do {
        const res = await s3Client.send(new ListObjectsV2Command({
            Bucket: BUCKET_NAME,
            ContinuationToken: continuationToken
        }));
        for (const obj of res.Contents || []) objects.push(obj.Key);
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
}

function buildMoviesIndex(keys) {
    // directoryId -> Set<profile>
    const index = new Map();
    for (const key of keys) {
        const m = key.match(MOVIE_KEY_RE);
        if (!m) continue;
        const [, directoryId, profile] = m;
        if (!RESOLUTION_PROFILES.includes(profile)) continue;
        if (!index.has(directoryId)) index.set(directoryId, new Set());
        index.get(directoryId).add(profile);
    }
    return index;
}

function buildSeriesIndex(keys) {
    // directoryId -> Map<"season-episode", Set<profile>>
    const index = new Map();
    for (const key of keys) {
        const m = key.match(SERIES_KEY_RE);
        if (!m) continue;
        const [, directoryId, , seasonPadded, episodePadded, profile] = m;
        if (!RESOLUTION_PROFILES.includes(profile)) continue;
        const season = parseInt(seasonPadded, 10);
        const episode = parseInt(episodePadded, 10);
        if (!index.has(directoryId)) index.set(directoryId, new Map());
        const epMap = index.get(directoryId);
        const epKey = `${season}-${episode}`;
        if (!epMap.has(epKey)) epMap.set(epKey, new Set());
        epMap.get(epKey).add(profile);
    }
    return index;
}

function readJsonSafe(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function directoryIdFor(metadata, folderName) {
    const imdbId = metadata?.imdbId || metadata?.imdb_id;
    return (imdbId && imdbId !== 'N/A') ? imdbId : folderName;
}

async function main() {
    const flags = parseArgs(process.argv);
    const dryRun = !(flags.execute === 'true');
    const only = flags.only ? new Set(String(flags.only).split(',').map((s) => s.trim()).filter(Boolean)) : null;

    console.log(`[rebuild-metadata] Listing all objects in bucket "${BUCKET_NAME}"...`);
    const allKeys = await listAllObjects();
    console.log(`[rebuild-metadata] Found ${allKeys.length} objects in bucket.`);

    const moviesFound = buildMoviesIndex(allKeys);
    const seriesFound = buildSeriesIndex(allKeys);
    console.log(`[rebuild-metadata] Bucket has ${moviesFound.size} movie directoryIds, ${seriesFound.size} series directoryIds.`);

    // ---------------------------------------------------------------
    // MOVIES
    // ---------------------------------------------------------------
    let movieEntries;
    try {
        movieEntries = fs.readdirSync(MOVIES_ROOT, { withFileTypes: true });
    } catch (err) {
        console.warn(`[rebuild-metadata] Could not read movies root ${MOVIES_ROOT}: ${err.message}`);
        movieEntries = [];
    }

    const matchedMovieDirectoryIds = new Set();
    let moviesPatched = 0;
    let moviesUpToDate = 0;

    for (const entry of movieEntries) {
        if (!entry.isDirectory() || entry.name.toLowerCase() === 'series') continue;
        if (only && !only.has(entry.name)) continue;

        const folderPath = path.join(MOVIES_ROOT, entry.name);
        const metaPath = path.join(folderPath, 'metadata.json');
        const metadata = readJsonSafe(metaPath);
        if (!metadata) continue;

        const directoryId = directoryIdFor(metadata, entry.name);
        const remoteProfiles = moviesFound.get(directoryId);
        if (!remoteProfiles || remoteProfiles.size === 0) continue;
        matchedMovieDirectoryIds.add(directoryId);

        const existingFiles = metadata.storage?.files || {};
        const missingProfiles = [...remoteProfiles].filter((profile) => {
            const fileMeta = existingFiles[profile];
            const expectedKey = `movies/${directoryId}/${profile}.mp4`;
            return !(fileMeta?.status === 'synced' && fileMeta?.remoteKey === expectedKey);
        });

        if (missingProfiles.length === 0) {
            moviesUpToDate += 1;
            continue;
        }

        console.log(`[rebuild-metadata] MOVIE ${entry.name} (${directoryId}): bucket has [${[...remoteProfiles].join(', ')}], patching [${missingProfiles.join(', ')}]`);
        moviesPatched += 1;

        if (dryRun) continue;

        await MetadataRegistry.mergeAndCommit(metaPath, entry.name, async (current) => {
            const next = { ...current };
            const files = { ...(next.storage?.files || {}) };
            for (const profile of missingProfiles) {
                files[profile] = {
                    ...(files[profile] || {}),
                    status: 'synced',
                    localPath: files[profile]?.localPath || null,
                    remoteKey: `movies/${directoryId}/${profile}.mp4`
                };
            }
            next.storage = { location: 'remote', files };
            next.pipelineState = { currentStep: 'COMPLETED', lastUpdated: new Date().toISOString(), error: null };
            return next;
        });
    }

    // ---------------------------------------------------------------
    // SERIES
    // ---------------------------------------------------------------
    let seriesEntries;
    try {
        seriesEntries = fs.readdirSync(SERIES_ROOT, { withFileTypes: true });
    } catch (err) {
        console.warn(`[rebuild-metadata] Could not read series root ${SERIES_ROOT}: ${err.message}`);
        seriesEntries = [];
    }

    const matchedSeriesDirectoryIds = new Set();
    let episodesPatched = 0;
    let episodesUpToDate = 0;
    let seriesFoldersTouched = 0;

    for (const entry of seriesEntries) {
        if (!entry.isDirectory()) continue;
        if (only && !only.has(entry.name)) continue;

        const folderPath = path.join(SERIES_ROOT, entry.name);
        const seriesJsonPath = path.join(folderPath, 'series.json');
        const metaPath = path.join(folderPath, 'metadata.json');
        const seriesData = readJsonSafe(seriesJsonPath);
        const metadata = readJsonSafe(metaPath);
        if (!seriesData) continue;

        const directoryId = directoryIdFor(metadata || {}, entry.name);
        const remoteEpisodes = seriesFound.get(directoryId);
        if (!remoteEpisodes || remoteEpisodes.size === 0) continue;
        matchedSeriesDirectoryIds.add(directoryId);

        // Figure out (without writing yet) which season/episode/profile combos
        // actually need a patch, so we can skip the write entirely if nothing changed.
        const patchPlan = []; // { season, episode, profiles }
        for (const [epKey, remoteProfiles] of remoteEpisodes.entries()) {
            const [seasonStr, episodeStr] = epKey.split('-');
            const season = seasonStr;
            const episodeNum = parseInt(episodeStr, 10);
            const seasonEntry = seriesData.seasons?.[season];
            const episodeEntry = seasonEntry?.episodes?.find((e) => Number(e.episodeNumber) === episodeNum);
            const existingFiles = episodeEntry?.storage?.files || {};

            const missingProfiles = [...remoteProfiles].filter((profile) => {
                const fileMeta = existingFiles[profile];
                const seasonPadded = String(season).padStart(2, '0');
                const episodePadded = String(episodeNum).padStart(2, '0');
                const expectedKey = `series/${directoryId}/season.${seasonPadded}/s${seasonPadded}e${episodePadded}/${profile}.mp4`;
                return !(fileMeta?.status === 'synced' && fileMeta?.remoteKey === expectedKey);
            });

            if (missingProfiles.length > 0) {
                patchPlan.push({ season, episodeNum, profiles: missingProfiles });
            } else {
                episodesUpToDate += 1;
            }
        }

        if (patchPlan.length === 0) continue;

        console.log(`[rebuild-metadata] SERIES ${entry.name} (${directoryId}): ${patchPlan.length} episode(s) need patching`);
        for (const p of patchPlan) {
            console.log(`    S${p.season}E${p.episodeNum} -> [${p.profiles.join(', ')}]`);
        }
        episodesPatched += patchPlan.length;
        seriesFoldersTouched += 1;

        if (dryRun) continue;

        await MetadataRegistry.mergeAndCommit(seriesJsonPath, entry.name, async (structure) => {
            const next = { ...structure, seasons: { ...structure.seasons } };
            for (const { season, episodeNum, profiles } of patchPlan) {
                const seasonEntry = next.seasons[season];
                if (!seasonEntry) continue;
                const episodes = [...(seasonEntry.episodes || [])];
                const idx = episodes.findIndex((e) => Number(e.episodeNumber) === episodeNum);
                if (idx === -1) continue;

                const currentEp = episodes[idx];
                const existingFiles = currentEp.storage?.files || {};
                const files = { ...existingFiles };
                const seasonPadded = String(season).padStart(2, '0');
                const episodePadded = String(episodeNum).padStart(2, '0');
                for (const profile of profiles) {
                    files[profile] = {
                        ...(files[profile] || {}),
                        status: 'synced',
                        localPath: files[profile]?.localPath || null,
                        remoteKey: `series/${directoryId}/season.${seasonPadded}/s${seasonPadded}e${episodePadded}/${profile}.mp4`
                    };
                }
                episodes[idx] = {
                    ...currentEp,
                    available: true,
                    storage: { location: 'remote', files }
                };
                next.seasons[season] = { ...seasonEntry, episodes };
            }
            return next;
        });
    }

    // ---------------------------------------------------------------
    // ORPHAN REPORT - bucket has content for a directoryId we never matched
    // to a local folder at all (renamed/deleted folder locally, etc).
    // ---------------------------------------------------------------
    const orphanMovies = [...moviesFound.keys()].filter((id) => !matchedMovieDirectoryIds.has(id));
    const orphanSeries = [...seriesFound.keys()].filter((id) => !matchedSeriesDirectoryIds.has(id));

    console.log('\n[rebuild-metadata] ==================== SUMMARY ====================');
    console.log(`[rebuild-metadata] Movies: ${moviesPatched} patched, ${moviesUpToDate} already up to date.`);
    console.log(`[rebuild-metadata] Series: ${episodesPatched} episode-profile(s) patched across ${seriesFoldersTouched} series, ${episodesUpToDate} episode(s) already up to date.`);
    if (orphanMovies.length) {
        console.log(`[rebuild-metadata] WARNING: ${orphanMovies.length} movie directoryId(s) in bucket with no matching local folder: ${orphanMovies.join(', ')}`);
    }
    if (orphanSeries.length) {
        console.log(`[rebuild-metadata] WARNING: ${orphanSeries.length} series directoryId(s) in bucket with no matching local folder: ${orphanSeries.join(', ')}`);
    }
    if (dryRun) {
        console.log('[rebuild-metadata] DRY RUN - no files were written. Re-run with --execute to apply.');
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[rebuild-metadata] Fatal error:', err.message || err);
        process.exit(1);
    });
