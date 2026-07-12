// src/routes/admin.routes.js
// Admin management interfaces, real-time log streaming, and manual profile sweeps.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { exec } = require('child_process'); // Restored explicit missing shell execution utility
const logger = require('../utils/logger');
//const logger = require('../services/logger'); 
const { getLibrary, connectDb } = require('../services/db'); // 🚨 NEW FIX: Import Redis engine utilities
// 🚨 NEW FIX: Require your unified pipeline background engine scanner
const LibraryScanner = require('../services/LibraryScanner'); 
const { buildHomeFeed, buildRecentFeed, saveHomeFeed, saveRecentFeed, loadHomeFeedWithFallback } = require('../services/HomeFeedService');
const { buildDefaultWorkerEndpoints, processToHealthUrl } = require('../services/WorkerEndpoints');

const WORKER_ENDPOINTS = buildDefaultWorkerEndpoints();
const WORKER_HEALTH = {
    sanitizer: processToHealthUrl(WORKER_ENDPOINTS.INGEST),
    metadata: processToHealthUrl(WORKER_ENDPOINTS.METADATA),
    subtitle: processToHealthUrl(WORKER_ENDPOINTS.SUBTITLES),
    transcoder: processToHealthUrl(WORKER_ENDPOINTS.TRANSCODE),
    cloudsync: processToHealthUrl(WORKER_ENDPOINTS.CLOUDSYNC)
};

const pipelineOrchestrator = require('../../Orchestrator');
const Orchestrator = require('../../Orchestrator'); // Adjust this path to point to your Orchestrator.js
const metadataService = require('../services/MetadataService');
const metadataProvider = require('../services/MetadataProvider');
const { rebuildSeriesManifest } = require('../services/SeriesIndexService');
const ProfileService = require('../services/ProfileService');
const {
    getPrimaryMovieRoot,
    getPrimarySeriesRoot,
    resolveMovieFolderPath: resolveMovieFolderPathFromResolver,
    resolveSeriesFolderPath: resolveSeriesFolderPathFromResolver,
    listSeriesFolders
} = require('../services/StoragePathResolver');
const {
    GROUP_ALL_MEDIA,
    GROUP_GLOBAL,
    normalizeGroups,
    mergeLibraryGroups,
    userGroup,
    normalizeUserKey
} = require('../services/LibraryAccessService');

const MOVIES_DIR = getPrimaryMovieRoot();
const SERIES_DIR = getPrimarySeriesRoot();

const ARCHIVE_DIR = process.env.ARCHIVE_DIR || '/app/archive';
const ARCHIVE_RETENTION_DAYS = Number(process.env.ARCHIVE_RETENTION_DAYS || 10);
const ARCHIVE_REMOTE_POLICY = String(process.env.ARCHIVE_REMOTE_POLICY || 'all_synced').trim().toLowerCase();
const ARCHIVE_SOURCE_PROFILE = String(process.env.ARCHIVE_SOURCE_PROFILE || '1080p').trim().toLowerCase();

const B2_ENDPOINT = process.env.B2_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com';
let archiveS3Client = null;

function getArchiveS3Client() {
    if (archiveS3Client) return archiveS3Client;
    archiveS3Client = new S3Client({
        endpoint: B2_ENDPOINT,
        region: process.env.B2_REGION || 'us-west-004',
        credentials: {
            accessKeyId: process.env.BBkeyID,
            secretAccessKey: process.env.BBapplicationKey
        }
    });
    return archiveS3Client;
}

function resolveMovieFolderPath(folderName) {
    return resolveMovieFolderPathFromResolver(folderName);
}

function resolveSeriesFolderPath(folderName) {
    return resolveSeriesFolderPathFromResolver(folderName);
}

function resolveContentFolderPath(contentType, folderName) {
    return String(contentType || '').toLowerCase() === 'series'
        ? resolveSeriesFolderPath(folderName)
        : resolveMovieFolderPath(folderName);
}

function sanitizeSeriesFolderName(folderName = '') {
    const clean = String(folderName || '').trim();
    if (!clean) return '';
    if (clean.includes('/') || clean.includes('\\') || clean.includes('..')) return '';
    return clean;
}

function toSeriesFolderName(value = '') {
    const raw = String(value || '')
        .replace(/\.[a-z0-9]{2,4}$/i, '')
        .replace(/\bMeGusta\b/gi, '')
        .replace(/\bingest\b/gi, '')
        .replace(/\bSeason[\s._-]?\d{1,3}\b/gi, '')
        .replace(/\bS\d{1,2}E\d{1,3}\b/gi, '')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!raw) return '';

    return raw
        .split(' ')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('.');
}

function removeEmptyDirectories(dirPath) {
    if (!fs.existsSync(dirPath)) return false;

    const stat = fs.lstatSync(dirPath);
    if (!stat.isDirectory()) return false;

    let empty = true;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            const childRemoved = removeEmptyDirectories(entryPath);
            if (!childRemoved) empty = false;
        } else {
            empty = false;
        }
    }

    if (empty) {
        try {
            fs.rmdirSync(dirPath);
            return true;
        } catch (_err) {
            return false;
        }
    }

    return false;
}

function mergeSeriesTreeContents(sourceDir, targetDir) {
    const summary = {
        movedFiles: 0,
        mergedDirectories: 0,
        skipped: 0,
        conflicts: []
    };

    if (!fs.existsSync(sourceDir) || !fs.existsSync(targetDir)) {
        return summary;
    }

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.name === 'metadata.json' || entry.name === 'series.json') {
            summary.skipped += 1;
            continue;
        }

        const sourceEntryPath = path.join(sourceDir, entry.name);
        const targetEntryPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            if (!fs.existsSync(targetEntryPath)) {
                fs.renameSync(sourceEntryPath, targetEntryPath);
                summary.mergedDirectories += 1;
                continue;
            }

            if (fs.lstatSync(targetEntryPath).isDirectory()) {
                const nested = mergeSeriesTreeContents(sourceEntryPath, targetEntryPath);
                summary.movedFiles += nested.movedFiles;
                summary.mergedDirectories += nested.mergedDirectories;
                summary.skipped += nested.skipped;
                summary.conflicts.push(...nested.conflicts);
                removeEmptyDirectories(sourceEntryPath);
                continue;
            }

            summary.skipped += 1;
            summary.conflicts.push({ path: entry.name, reason: 'target-file-exists' });
            continue;
        }

        if (!fs.existsSync(targetEntryPath)) {
            fs.renameSync(sourceEntryPath, targetEntryPath);
            summary.movedFiles += 1;
        } else {
            summary.skipped += 1;
            summary.conflicts.push({ path: entry.name, reason: 'target-file-exists' });
        }
    }

    removeEmptyDirectories(sourceDir);
    return summary;
}

function buildSeriesRenameMetadata(existingMetadata, folderPath, targetFolderName, imdbId, title) {
    return {
        ...existingMetadata,
        title: title || existingMetadata.title || targetFolderName.replace(/[._-]/g, ' '),
        contentType: 'series',
        folderName: targetFolderName,
        folderPath,
        imdbId: imdbId || existingMetadata.imdbId || existingMetadata.imdbID || null,
        imdb_id: imdbId || existingMetadata.imdb_id || existingMetadata.imdbId || existingMetadata.imdbID || null,
        pipelineState: {
            ...(existingMetadata.pipelineState || {}),
            currentStep: 'COMPLETED',
            lastUpdated: new Date().toISOString(),
            error: null
        }
    };
}

async function refreshLibraryFeeds() {
    const library = await getLibrary();
    const feed = buildHomeFeed(library);
    const recentFeed = buildRecentFeed(library);
    saveHomeFeed(feed);
    saveRecentFeed(recentFeed);
    return { feed, recentFeed };
}

function normalizeEpisodeToken(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/\.[a-z0-9]{2,4}$/i, '')
        .replace(/[._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
}

function parseSeasonEpisodeFromName(name = '') {
    const match = String(name || '').match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (!match) return null;
    return {
        season: parseInt(match[1], 10),
        episode: parseInt(match[2], 10)
    };
}

async function buildEpisodeLookupByImdb(imdbId) {
    const cleanImdb = String(imdbId || '').trim();
    if (!cleanImdb) return new Map();

    const lookupSeed = await metadataProvider.fetchMetadataWithFallback({
        imdbId: cleanImdb,
        contentType: 'series'
    });

    if (!lookupSeed.data || lookupSeed.data.Response !== 'True') {
        return new Map();
    }

    const totalSeasons = parseInt(lookupSeed.data.totalSeasons, 10) || 0;
    const lookup = new Map();

    for (let season = 1; season <= totalSeasons; season += 1) {
        try {
            const episodes = await metadataProvider.fetchSeasonEpisodesWithFallback({
                imdbId: cleanImdb,
                title: lookupSeed.data.Title || '',
                season,
                tmdbId: lookupSeed.data.tmdbId || null
            });
            episodes.forEach(ep => {
                const epNum = parseInt(ep.Episode, 10);
                if (!Number.isFinite(epNum) || epNum <= 0) return;

                const key = normalizeEpisodeToken(ep.Title || '');
                if (!key) return;

                const rec = {
                    season,
                    episode: epNum,
                    title: ep.Title || `Episode ${epNum}`
                };

                if (!lookup.has(key)) {
                    lookup.set(key, [rec]);
                } else {
                    lookup.get(key).push(rec);
                }
            });
        } catch (_err) {
            // Keep scan resilient if one season lookup fails.
        }
    }

    return lookup;
}

function findEpisodeMatchForFile(fileName, lookup) {
    const parsed = parseSeasonEpisodeFromName(fileName);
    if (parsed) {
        return {
            season: parsed.season,
            episode: parsed.episode,
            title: null,
            strategy: 'sxe'
        };
    }

    const stem = normalizeEpisodeToken(path.basename(fileName, path.extname(fileName)));
    if (!stem || !lookup || lookup.size === 0) return null;

    const exact = lookup.get(stem);
    if (exact && exact.length === 1) {
        return { ...exact[0], strategy: 'exact-title' };
    }

    const partialHits = [];
    lookup.forEach((records, key) => {
        if (stem.includes(key) || key.includes(stem)) {
            records.forEach(record => partialHits.push(record));
        }
    });

    if (partialHits.length === 1) {
        return { ...partialHits[0], strategy: 'partial-title' };
    }

    return null;
}

async function organizeRootEpisodesIntoSeasonFolders(showPath, showFolderName, imdbId) {
    const videoPattern = /\.(mp4|mkv|m4v|avi|mov)$/i;
    const entries = fs.readdirSync(showPath, { withFileTypes: true });
    const rootVideoFiles = entries
        .filter(entry => entry.isFile() && videoPattern.test(entry.name))
        .map(entry => entry.name);

    if (rootVideoFiles.length === 0) {
        return { moved: 0, skipped: 0, details: [] };
    }

    const episodeLookup = imdbId ? await buildEpisodeLookupByImdb(imdbId) : new Map();
    const details = [];
    let moved = 0;
    let skipped = 0;

    for (const fileName of rootVideoFiles) {
        const match = findEpisodeMatchForFile(fileName, episodeLookup);
        if (!match || !Number.isFinite(match.season) || !Number.isFinite(match.episode)) {
            skipped += 1;
            details.push({ fileName, moved: false, reason: 'No reliable season/episode match.' });
            continue;
        }

        const seasonFolder = `Season.${String(match.season).padStart(2, '0')}`;
        const seasonPath = path.join(showPath, seasonFolder);
        fs.mkdirSync(seasonPath, { recursive: true });

        const ext = path.extname(fileName).toLowerCase();
        const normalizedName = `${showFolderName}.S${String(match.season).padStart(2, '0')}E${String(match.episode).padStart(2, '0')}${ext}`;
        const sourcePath = path.join(showPath, fileName);
        const destinationPath = path.join(seasonPath, normalizedName);

        if (fs.existsSync(destinationPath)) {
            skipped += 1;
            details.push({ fileName, moved: false, reason: `Destination exists (${normalizedName}).` });
            continue;
        }

        await fsPromises.rename(sourcePath, destinationPath);
        moved += 1;
        details.push({
            fileName,
            moved: true,
            strategy: match.strategy,
            destination: path.join(seasonFolder, normalizedName)
        });
    }

    return { moved, skipped, details };
}

function normalizeTagList(value, fallback = []) {
    const source = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(',') : fallback);

    return [...new Set(source.map(tag => String(tag).trim()).filter(Boolean))].sort();
}

function getLibraryGroupsFromMetadata(meta = {}) {
    return normalizeGroups(meta.libraryGroups || meta.metadata?.libraryGroups || [], { addGlobalIfMissing: true });
}

function readMetadataIfExists(metaPath) {
    if (!fs.existsSync(metaPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function getContentTypeBucket(contentTypeRaw = '') {
    return String(contentTypeRaw || '').toLowerCase() === 'series' ? 'shows' : 'movies';
}

function toAdminResultItem(row = {}) {
    const contentType = String(row.contentType || '').toLowerCase() === 'series' ? 'series' : 'movies';
    const folder = contentType === 'series'
        ? String(row.id || '').replace(/^series\//i, '')
        : decodeURIComponent(String(row.id || ''));

    return {
        folder,
        contentType,
        metadata: row,
        redisMetadata: row,
        diskMetadata: null,
        resolvedDiskPath: row.sourcePath || null,
        syncState: {
            inSync: true,
            redisAvailable: true,
            diskAvailable: Boolean(row.sourcePath),
            redisStorageLocation: row.storageLocation || row.storage?.location || 'local',
            diskStorageLocation: row.storageLocation || row.storage?.location || 'local',
            mismatchNote: ''
        }
    };
}

function applyLibrarySearchAndSort(items = [], { query = '', group = 'any', sort = 'updated_desc' } = {}) {
    const queryNorm = String(query || '').toLowerCase().trim();
    let rows = Array.isArray(items) ? [...items] : [];

    if (queryNorm) {
        rows = rows.filter((item) => {
            const haystack = [
                item.title,
                item.id,
                item.imdbId,
                item.imdb_id,
                item.genre,
                Array.isArray(item.tags) ? item.tags.join(' ') : item.tags
            ].map((v) => String(v || '').toLowerCase()).join(' ');
            return haystack.includes(queryNorm);
        });
    }

    const cleanGroup = String(group || 'any').trim().toLowerCase();
    if (cleanGroup && cleanGroup !== 'any') {
        rows = rows.filter((item) => {
            const groups = normalizeGroups(item.libraryGroups || [], { addGlobalIfMissing: true });
            return groups.includes(cleanGroup);
        });
    }

    const sorter = String(sort || 'updated_desc').toLowerCase();
    rows.sort((a, b) => {
        if (sorter === 'title_asc') return String(a.title || '').localeCompare(String(b.title || ''));
        if (sorter === 'title_desc') return String(b.title || '').localeCompare(String(a.title || ''));
        if (sorter === 'year_asc') return Number(a.year || 0) - Number(b.year || 0);
        if (sorter === 'year_desc') return Number(b.year || 0) - Number(a.year || 0);

        const aTime = new Date(a.updatedAt || a.addedAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.addedAt || 0).getTime();
        if (sorter === 'updated_asc') return aTime - bTime;
        return bTime - aTime;
    });

    return rows;
}

function normalizeScalar(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';

    const lowered = raw.toLowerCase();
    if (lowered === 'n/a' || lowered === 'na' || lowered === 'unknown' || lowered === 'null' || lowered === 'undefined') {
        return '';
    }
    return raw;
}

function normalizeEnrichment(meta = {}) {
    const rootTags = normalizeTagList(meta.tags || meta.enrichment?.tags || meta.metadata?.tags || meta.genre || meta.metadata?.genre);
    return {
        genre: normalizeScalar(meta.genre || meta.enrichment?.genre || meta.metadata?.genre || ''),
        tags: rootTags,
        imdbScore: normalizeScalar(meta.imdbScore || meta.imdbRating || meta.rating || meta.enrichment?.imdbScore || meta.metadata?.imdbScore || meta.metadata?.imdbRating || meta.metadata?.rating || ''),
        parentalRating: normalizeScalar(meta.parentalRating || meta.rated || meta.enrichment?.parentalRating || meta.metadata?.parentalRating || meta.metadata?.rated || ''),
        popularity: normalizeScalar(meta.popularity || meta.enrichment?.popularity || meta.metadata?.popularity || ''),
        popularitySource: normalizeScalar(meta.enrichment?.popularitySource || meta.metadata?.enrichment?.popularitySource || '')
    };
}

function cleanRemoteKey(key = '') {
    return String(key || '').replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\//, '').trim();
}

function repairStorageProfiles(storage = {}, contentType = 'movie', folder = '', imdbId = '') {
    const nextStorage = {
        ...(storage || {}),
        files: {
            ...((storage && storage.files) || {})
        }
    };

    const files = nextStorage.files || {};
    const normalizedContentType = String(contentType || '').toLowerCase() === 'series' ? 'series' : 'movie';
    const directoryId = String(imdbId || '').trim() && String(imdbId || '').trim().toLowerCase() !== 'n/a'
        ? String(imdbId || '').trim()
        : String(folder || '').trim();

    let changed = false;
    Object.keys(files).forEach((profile) => {
        const block = files[profile] || {};
        const localPath = String(block.localPath || '').trim();
        const cleanedRemoteKey = cleanRemoteKey(block.remoteKey || '');
        const normalizedProfile = String(profile || '').trim().toLowerCase();

        let derivedRemoteKey = cleanedRemoteKey;
        if (!derivedRemoteKey && localPath && directoryId) {
            const base = normalizedContentType === 'series' ? 'series' : 'movies';
            if (normalizedProfile === '1080p' || normalizedProfile === '720p' || normalizedProfile === '480p') {
                derivedRemoteKey = `${base}/${directoryId}/${normalizedProfile}.mp4`;
            } else {
                derivedRemoteKey = `${base}/${directoryId}/${localPath}`;
            }
        }

        let nextStatus = block.status;
        if (block.status === 'synced' && !derivedRemoteKey) {
            nextStatus = localPath ? 'pending' : 'waiting';
        }

        if (derivedRemoteKey !== cleanedRemoteKey || nextStatus !== block.status) {
            files[profile] = {
                ...block,
                status: nextStatus,
                remoteKey: derivedRemoteKey || null
            };
            changed = true;
        }
    });

    nextStorage.files = files;
    return { storage: nextStorage, changed };
}

function sanitizeArchiveName(name = '') {
    return String(name || '')
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 180) || 'unknown_item';
}

function ensurePathInside(parentDir, targetPath) {
    const normalizedParent = path.resolve(parentDir);
    const normalizedTarget = path.resolve(targetPath);
    const relative = path.relative(normalizedParent, normalizedTarget);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function gatherArchiveCandidates(folderPath, metadata) {
    const sourceVideoExts = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv']);
    const subtitleExts = new Set(['.srt', '.vtt']);
    const filesOnDisk = fs.existsSync(folderPath) ? fs.readdirSync(folderPath) : [];

    const candidates = [];

    Object.values(metadata?.storage?.files || {}).forEach((block) => {
        const localPath = String(block?.localPath || '').trim();
        if (!localPath) return;
        if (!filesOnDisk.includes(localPath)) return;

        candidates.push({ fileName: localPath, fileType: 'delivery' });
    });

    filesOnDisk.forEach((fileName) => {
        const ext = path.extname(fileName).toLowerCase();
        const lower = fileName.toLowerCase();

        if (lower === 'metadata.json' || lower === 'cover.jpg') return;

        if (sourceVideoExts.has(ext)) {
            const fileType = ext === '.mp4' && (lower.includes('.web.') || lower.includes('1080') || lower.includes('720') || lower.includes('480'))
                ? 'delivery'
                : (ext === '.mp4' ? 'delivery' : 'source');
            candidates.push({ fileName, fileType });
            return;
        }

        if (subtitleExts.has(ext) || /\.sub\.\d+\.[a-z]{2,3}\.(srt|vtt)$/i.test(fileName)) {
            candidates.push({ fileName, fileType: 'subtitle' });
        }
    });

    const seen = new Set();
    return candidates.filter((item) => {
        if (seen.has(item.fileName)) return false;
        seen.add(item.fileName);
        return true;
    });
}

function sanitizeArchivePolicy(value = '') {
    const policy = String(value || '').trim().toLowerCase();
    if (policy === 'source_synced' || policy === 'any_synced' || policy === 'all_synced') return policy;
    return 'all_synced';
}

function listStorageProfiles(storageFiles = {}) {
    return Object.keys(storageFiles || {})
        .map((profile) => String(profile || '').trim())
        .filter(Boolean);
}

function getProfileBlock(storageFiles = {}, profileName = '') {
    const target = String(profileName || '').trim().toLowerCase();
    if (!target) return null;
    const profile = Object.keys(storageFiles || {}).find((name) => String(name || '').trim().toLowerCase() === target);
    if (!profile) return null;
    return { profile, block: storageFiles[profile] || {} };
}

function getPendingProfiles(storageFiles = {}) {
    return listStorageProfiles(storageFiles).filter((profile) => {
        const block = storageFiles[profile] || {};
        const remoteKey = cleanRemoteKey(block.remoteKey || '');
        return block.status !== 'synced' || !remoteKey;
    });
}

async function verifyRemoteCloudCopy(metadata, options = {}) {
    const storage = metadata?.storage || {};
    const files = storage.files || {};
    const requiredProfiles = listStorageProfiles(files);
    const policy = sanitizeArchivePolicy(options.policy || ARCHIVE_REMOTE_POLICY);
    const sourceProfile = String(options.sourceProfile || ARCHIVE_SOURCE_PROFILE || '1080p').trim().toLowerCase();

    if (storage.location !== 'remote') {
        return { ok: false, reason: 'Storage location is not set to remote.', policy, sourceProfile };
    }

    if (requiredProfiles.length === 0) {
        return { ok: false, reason: 'No storage profiles available to verify.', policy, sourceProfile };
    }

    if (!process.env.BBkeyID || !process.env.BBapplicationKey) {
        return { ok: false, reason: 'Cloud credentials are not available in environment.', policy, sourceProfile };
    }

    const bucket = storage.bucket || process.env.B2_BUCKET || 'joshflixmedia';
    const s3Client = getArchiveS3Client();
    const verified = [];

    const verifyProfile = async (profile, block) => {
        const remoteKey = cleanRemoteKey(block.remoteKey || '');
        if (!remoteKey) return { ok: false, reason: `Profile ${profile} is missing remote key.` };
        try {
            await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: remoteKey }));
            verified.push({ profile, remoteKey });
            return { ok: true };
        } catch (err) {
            return {
                ok: false,
                reason: `Cloud object check failed for ${profile} (${remoteKey}): ${err.name || err.message}`
            };
        }
    };

    if (policy === 'source_synced') {
        const preferredProfiles = [sourceProfile, '1080p', ...requiredProfiles].filter(Boolean);
        const candidate = preferredProfiles
            .map((profile) => getProfileBlock(files, profile))
            .find((entry) => entry && entry.block && entry.block.status === 'synced' && cleanRemoteKey(entry.block.remoteKey || ''));

        if (!candidate) {
            return {
                ok: false,
                reason: `No synced source profile found (looked for ${sourceProfile}).`,
                policy,
                sourceProfile,
                pendingProfiles: getPendingProfiles(files)
            };
        }

        const verifiedSource = await verifyProfile(candidate.profile, candidate.block);
        if (!verifiedSource.ok) {
            return {
                ok: false,
                reason: verifiedSource.reason,
                policy,
                sourceProfile,
                pendingProfiles: getPendingProfiles(files)
            };
        }

        return {
            ok: true,
            bucket,
            policy,
            sourceProfile: candidate.profile,
            verified,
            pendingProfiles: getPendingProfiles(files)
        };
    }

    if (policy === 'any_synced') {
        const syncedProfiles = requiredProfiles
            .map((profile) => ({ profile, block: files[profile] || {} }))
            .filter(({ block }) => block.status === 'synced' && cleanRemoteKey(block.remoteKey || ''));

        if (syncedProfiles.length === 0) {
            return {
                ok: false,
                reason: 'No synced profiles available for cloud verification.',
                policy,
                sourceProfile,
                pendingProfiles: getPendingProfiles(files)
            };
        }

        const verifiedAny = await verifyProfile(syncedProfiles[0].profile, syncedProfiles[0].block);
        if (!verifiedAny.ok) {
            return {
                ok: false,
                reason: verifiedAny.reason,
                policy,
                sourceProfile,
                pendingProfiles: getPendingProfiles(files)
            };
        }

        return {
            ok: true,
            bucket,
            policy,
            sourceProfile,
            verified,
            pendingProfiles: getPendingProfiles(files)
        };
    }

    for (const profile of requiredProfiles) {
        const block = files[profile] || {};
        if (block.status !== 'synced') {
            return {
                ok: false,
                reason: `Profile ${profile} is not confirmed synced with remote key.`,
                policy,
                sourceProfile,
                pendingProfiles: getPendingProfiles(files)
            };
        }

        const verifiedProfile = await verifyProfile(profile, block);
        if (!verifiedProfile.ok) {
            return {
                ok: false,
                reason: verifiedProfile.reason,
                policy,
                sourceProfile,
                pendingProfiles: getPendingProfiles(files)
            };
        }
    }

    return {
        ok: true,
        bucket,
        policy,
        sourceProfile,
        verified,
        pendingProfiles: getPendingProfiles(files)
    };
}

async function persistMetadataFile(metaPath, metadata) {
    await fsPromises.writeFile(metaPath, JSON.stringify(metadata, null, 4), 'utf-8');
}

router.get('/log-stream', (req, res) => {
    // Ensure only authorized admin access configurations proceed here
    res.setHeader('X-Accel-Buffering', 'no'); 
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Tell Node to establish the channel link immediately

    // Determine the current active log file name matching our DailyRotate setup
    const todayStr = new Date().toISOString().split('T')[0];
    const currentLogFile = path.join(logger.LOG_DIR, `anymovie-${todayStr}.log`);

    // Stream existing historical context data from today's log first
    if (fs.existsSync(currentLogFile)) {
        const stats = fs.statSync(currentLogFile);
        // Read the last 50KB of historical logs so the screen isn't blank on open
        const startBytes = Math.max(0, stats.size - 50000); 
        const stream = fs.createReadStream(currentLogFile, { start: startBytes, encoding: 'utf8' });
        
        stream.on('data', (chunk) => {
            res.write(`data: ${chunk.replace(/\n/g, '\ndata: ')}\n\n`);
        });
    }

    // Watch today's log file for real-time appends
    let watcher;
    if (fs.existsSync(currentLogFile)) {
        let fileSize = fs.statSync(currentLogFile).size;
        
        watcher = fs.watch(currentLogFile, (eventType) => {
            if (eventType === 'change') {
                const stats = fs.statSync(currentLogFile);
                if (stats.size > fileSize) {
                    const stream = fs.createReadStream(currentLogFile, {
                        start: fileSize,
                        end: stats.size,
                        encoding: 'utf8'
                    });
                    stream.on('data', (chunk) => {
                        res.write(`data: ${chunk.replace(/\n/g, '\ndata: ')}\n\n`);
                    });
                    fileSize = stats.size;
                }
            }
        });
    }

    // Clean up connections if the admin closes the tab
    req.on('close', () => {
        if (watcher) watcher.close();
        res.end();
    });
});



// =========================================================================
// 🛡️ ADMIN VERIFICATION INTERCEPTOR LAYER
// =========================================================================
async function requireAdmin(req, res, next) {
    const activeUser = req.cookies?.user_profile;

    const cleanUser = String(activeUser || '').toLowerCase().trim();
    const allowByIdentity = cleanUser === 'josh' || cleanUser.startsWith('josh@');
    if (allowByIdentity) {
        return next();
    }

    if (cleanUser) {
        try {
            const config = await ProfileService.readData(cleanUser, 'config', {});
            if (config?.isAdmin === true) {
                return next();
            }
        } catch (_err) {
            // Continue to deny path below.
        }
    }
    
    if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
        return res.status(403).json({ success: false, error: "Access denied. Administrator clearance required." });
    }
    res.redirect('/login.html');
}

router.use(requireAdmin);

router.get('/health-check/:service', async (req, res) => {
    const serviceName = req.params.service;

    if (serviceName === 'orchestrator') {
        return res.json({ alive: true });
    }

    const healthUrl = WORKER_HEALTH[serviceName];

    if (!healthUrl) return res.status(404).json({ alive: false });
    
    try {
        await axios.get(healthUrl, { timeout: 1000 });
        return res.json({ alive: true });
    } catch (e) {
        if (e.code !== 'ECONNREFUSED') {
            return res.json({ alive: true });
        }
        return res.status(503).json({ alive: false, error: 'ECONNREFUSED' });
    }
});

router.post('/sync-item', async (req, res) => {
    try {
        const { folder, contentType } = req.body || {};
        const summary = await LibraryScanner.runLibraryScanSweep();
        await refreshLibraryFeeds();

        let itemFound = null;
        if (folder) {
            const library = await getLibrary();
            if (contentType === 'series') {
                const expectedId = `series/${encodeURIComponent(folder)}`;
                itemFound = (library.shows || []).some(s => s.id === expectedId || s.id === `series/${folder}`);
            } else {
                const expectedId = encodeURIComponent(folder);
                itemFound = (library.movies || []).some(m => m.id === expectedId);
            }
        }

        return res.json({ success: true, message: 'Library snapshot refreshed from disk.', summary, itemFound });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/series/manual-scan', async (req, res) => {
    try {
        const { folder = null, rebuildManifests = true } = req.body || {};
        const targetFolder = sanitizeSeriesFolderName(folder || '');

        const showFolders = [];
        if (targetFolder) {
            const showPath = resolveSeriesFolderPath(targetFolder);
            if (!fs.existsSync(showPath) || !fs.lstatSync(showPath).isDirectory()) {
                return res.status(404).json({ success: false, error: 'Series folder not found.' });
            }
            showFolders.push({ name: targetFolder, path: showPath });
        } else {
            listSeriesFolders().forEach(entry => {
                showFolders.push({ name: entry.name, path: entry.path });
            });
        }

        let rebuiltCount = 0;
        const rebuildErrors = [];

        if (rebuildManifests) {
            for (const show of showFolders) {
                try {
                    rebuildSeriesManifest(show.path, { showFolderName: show.name, write: true });
                    rebuiltCount += 1;
                } catch (err) {
                    rebuildErrors.push({ folder: show.name, error: err.message });
                }
            }
        }

        const summary = await LibraryScanner.runLibraryScanSweep();
        await refreshLibraryFeeds();
        return res.json({
            success: true,
            message: 'TV library scan complete.',
            targetFolder: targetFolder || null,
            scannedShows: showFolders.length,
            rebuiltCount,
            rebuildErrors,
            summary
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/series/manual-add', async (req, res) => {
    try {
        const { folder, imdbId, attemptEpisodeReorg = true, ensureGlobal = true } = req.body || {};
        const cleanFolder = sanitizeSeriesFolderName(folder || '');
        const cleanImdbId = String(imdbId || '').trim();

        if (!cleanFolder) {
            return res.status(400).json({ success: false, error: 'Missing or invalid series folder name.' });
        }
        if (!cleanImdbId) {
            return res.status(400).json({ success: false, error: 'IMDb ID is required.' });
        }

        const showPath = resolveSeriesFolderPath(cleanFolder);
        if (!fs.existsSync(showPath) || !fs.lstatSync(showPath).isDirectory()) {
            return res.status(404).json({ success: false, error: 'Series folder not found.' });
        }

        let metadata = {};
        const metadataPath = path.join(showPath, 'metadata.json');
        if (fs.existsSync(metadataPath)) {
            try {
                metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            } catch (_err) {
                metadata = {};
            }
        }

        const metadataLookup = await metadataProvider.fetchMetadataWithFallback({
            imdbId: cleanImdbId,
            contentType: 'series'
        });
        const omdbData = metadataLookup.data;

        const mergedMeta = {
            ...metadata,
            title: omdbData?.Title || metadata.title || cleanFolder.replace(/[._-]/g, ' '),
            year: omdbData?.Year || metadata.year || '',
            plot: omdbData?.Plot || metadata.plot || '',
            genre: omdbData?.Genre || metadata.genre || '',
            imdbId: cleanImdbId,
            imdb_id: cleanImdbId,
            contentType: 'series',
            folderName: cleanFolder,
            folderPath: showPath,
            pipelineState: {
                ...(metadata.pipelineState || {}),
                currentStep: 'COMPLETED',
                lastUpdated: new Date().toISOString(),
                error: null
            }
        };

        if (ensureGlobal) {
            mergedMeta.libraryGroups = mergeLibraryGroups(
                mergedMeta.libraryGroups || metadata.libraryGroups || [],
                [GROUP_GLOBAL],
                { addGlobalIfMissing: true }
            );
        }

        await fsPromises.writeFile(metadataPath, JSON.stringify(mergedMeta, null, 4), 'utf-8');

        let reorgSummary = { moved: 0, skipped: 0, details: [] };
        if (attemptEpisodeReorg) {
            reorgSummary = await organizeRootEpisodesIntoSeasonFolders(showPath, cleanFolder, cleanImdbId);
        }

        const seriesManifest = rebuildSeriesManifest(showPath, {
            showFolderName: cleanFolder,
            write: true
        });

        const scanSummary = await LibraryScanner.runLibraryScanSweep();

        return res.json({
            success: true,
            folder: cleanFolder,
            imdbId: cleanImdbId,
            metadataUpdated: true,
            reorgSummary,
            totalSeasons: seriesManifest.totalSeasons,
            scanSummary
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/series/normalize-folder', async (req, res) => {
    try {
        const { folder, imdbId, title, targetFolderName, attemptEpisodeReorg = true } = req.body || {};
        const cleanFolder = sanitizeSeriesFolderName(folder || '');
        const cleanImdbId = String(imdbId || '').trim();
        const cleanTitle = String(title || '').trim();

        if (!cleanFolder) {
            return res.status(400).json({ success: false, error: 'Missing or invalid series folder name.' });
        }

        const showPath = resolveSeriesFolderPath(cleanFolder);
        if (!fs.existsSync(showPath) || !fs.lstatSync(showPath).isDirectory()) {
            return res.status(404).json({ success: false, error: 'Series folder not found.' });
        }

        const metadataPath = path.join(showPath, 'metadata.json');
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
            try {
                metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            } catch (_err) {
                metadata = {};
            }
        }

        const metadataTitle = cleanTitle || metadata.title || metadata.name || cleanFolder;
        const derivedFolderName = sanitizeSeriesFolderName(targetFolderName || toSeriesFolderName(metadataTitle));

        if (!derivedFolderName) {
            return res.status(400).json({ success: false, error: 'Could not derive a valid target folder name.' });
        }

        let finalPath = showPath;
        let finalFolderName = cleanFolder;
        let renameMode = 'metadata-only';
        let mergeSummary = { movedFiles: 0, mergedDirectories: 0, skipped: 0, conflicts: [] };

        if (derivedFolderName !== cleanFolder) {
            const targetPath = resolveSeriesFolderPath(derivedFolderName);

            if (fs.existsSync(targetPath) && path.resolve(targetPath) !== path.resolve(showPath)) {
                renameMode = 'merge-into-existing';
                mergeSummary = mergeSeriesTreeContents(showPath, targetPath);
                finalPath = targetPath;
                finalFolderName = derivedFolderName;
            } else {
                renameMode = 'rename-root';
                await fsPromises.rename(showPath, targetPath);
                finalPath = targetPath;
                finalFolderName = derivedFolderName;
            }
        }

        const finalMetadataPath = path.join(finalPath, 'metadata.json');
        let finalBaseMetadata = metadata;
        if (finalPath !== showPath && fs.existsSync(finalMetadataPath)) {
            try {
                finalBaseMetadata = {
                    ...JSON.parse(fs.readFileSync(finalMetadataPath, 'utf-8')),
                    ...metadata
                };
            } catch (_err) {
                finalBaseMetadata = metadata;
            }
        }

        const nextMetadata = buildSeriesRenameMetadata(
            finalBaseMetadata,
            finalPath,
            finalFolderName,
            cleanImdbId || metadata.imdbId || metadata.imdbID || '',
            metadataTitle
        );

        await fsPromises.writeFile(finalMetadataPath, JSON.stringify(nextMetadata, null, 4), 'utf-8');

        let reorgSummary = { moved: 0, skipped: 0, details: [] };
        if (attemptEpisodeReorg) {
            reorgSummary = await organizeRootEpisodesIntoSeasonFolders(finalPath, finalFolderName, nextMetadata.imdbId || cleanImdbId);
        }

        const seriesManifest = rebuildSeriesManifest(finalPath, {
            showFolderName: finalFolderName,
            write: true
        });

        const scanSummary = await LibraryScanner.runLibraryScanSweep();
        await refreshLibraryFeeds();

        return res.json({
            success: true,
            folder: finalFolderName,
            sourceFolder: cleanFolder,
            targetFolder: finalFolderName,
            renameMode,
            mergeSummary,
            reorgSummary,
            totalSeasons: seriesManifest.totalSeasons,
            scanSummary
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/regenerate-home-feed', async (req, res) => {
    try {
        const { refreshLibrary = false } = req.body || {};

        if (refreshLibrary) {
            await LibraryScanner.runLibraryScanSweep();
        }

        const library = await getLibrary();
        const feed = buildHomeFeed(library);
        const recentFeed = buildRecentFeed(library);
        const feedPath = saveHomeFeed(feed);
        const recentFeedPath = saveRecentFeed(recentFeed);

        return res.json({
            success: true,
            feedPath,
            recentFeedPath,
            generatedAt: feed.generatedAt,
            totalItems: feed.totalItems,
            collections: feed.collections.length
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/feed-diagnostics', async (req, res) => {
    try {
        const library = await getLibrary();
        const feed = loadHomeFeedWithFallback();

        const allLibrary = [...(library.movies || []), ...(library.shows || [])];
        const libraryMap = new Map();
        allLibrary.forEach(item => {
            const id = String(item?.id || '');
            if (id) libraryMap.set(id, item);
        });

        const feedIds = new Set();
        const collections = Array.isArray(feed?.collections) ? feed.collections : [];
        collections.forEach(collection => {
            (collection.cards || []).forEach(card => {
                const id = String(card?.id || '');
                if (id) feedIds.add(id);
            });
        });

        const missing = [];
        libraryMap.forEach((item, id) => {
            if (!feedIds.has(id)) {
                missing.push({
                    id,
                    title: item.title || id,
                    contentType: item.contentType || (String(id).startsWith('series/') ? 'series' : 'movie'),
                    storageLocation: item.storageLocation || item.storage?.location || 'unknown',
                    sourcePath: item.sourcePath || ''
                });
            }
        });

        missing.sort((a, b) => a.title.localeCompare(b.title));

        return res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            libraryCounts: {
                movies: (library.movies || []).length,
                shows: (library.shows || []).length,
                total: libraryMap.size
            },
            feedCounts: {
                collections: collections.length,
                uniqueItems: feedIds.size
            },
            missingCount: missing.length,
            missing,
            collectionSummary: collections.map(c => ({ id: c.id, title: c.title, cards: (c.cards || []).length }))
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Master Server Endpoint
router.get('/v1/connector/bootstrap-bundle', async (req, res) => {
    // Verify tokens here using verifySecureToken...

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=media-assets.zip');

    const archiver = require('archiver'); // Lightweight streaming zip engine
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.pipe(res);
    
    // Only compress tracking configurations, artwork, and text targets
    archive.directory('/app/storage/movies/', false, (entry) => {
        const ext = path.extname(entry.name).toLowerCase();
        // 🛑 ABSOLUTE GATING CRITERIA: Completely skip video rendering tracks
        if (ext === '.mp4' || ext === '.mkv') return false;
        return entry;
    });

    await archive.finalize();
});

router.post('/repair-metadata', async (req, res) => {
    try {
        const { folder, contentType, runCloudSync = true } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const folderPath = resolveContentFolderPath(contentType, folder);
        const metaFilePath = path.join(folderPath, 'metadata.json');

        if (!fs.existsSync(folderPath)) {
            return res.status(404).json({ success: false, error: 'Target folder not found.' });
        }
        if (!fs.existsSync(metaFilePath)) {
            return res.status(404).json({ success: false, error: 'metadata.json not found.' });
        }

        let metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
        if (!metadata.storage) {
            metadata.storage = { location: 'local', files: {} };
        }
        if (!metadata.storage.files) {
            metadata.storage.files = {};
        }

        const filesOnDisk = fs.readdirSync(folderPath);
        metadata.folderPath = folderPath;
        metadata.folderName = folder;
        const profileMatcher = {
            '1080p': (f) => /\.web\.mp4$/i.test(f) || /1080p/i.test(f),
            '720p': (f) => /720p/i.test(f),
            '480p': (f) => /480p/i.test(f)
        };

        const resolveLocalPath = (profile, existingLocalPath) => {
            if (existingLocalPath && fs.existsSync(path.join(folderPath, existingLocalPath))) {
                return existingLocalPath;
            }

            const preferred = filesOnDisk.find(f => /\.(mp4|mkv|m4v)$/i.test(f) && profileMatcher[profile](f));
            if (preferred) return preferred;

            if (profile === '1080p') {
                const source = filesOnDisk.find(f => f.endsWith('.mp4') && !f.includes('.720p') && !f.includes('.480p'));
                return source || null;
            }

            return null;
        };

        const profiles = ['1080p', '720p', '480p'];
        profiles.forEach(profile => {
            const block = metadata.storage.files[profile] || {};
            const localPath = resolveLocalPath(profile, block.localPath || null);
            const remoteKey = block.remoteKey || null;

            let status = block.status || 'waiting';
            if (remoteKey) {
                status = 'synced';
            } else if (localPath) {
                status = metadata.storage.location === 'remote' ? 'pending' : 'synced';
            } else {
                status = 'waiting';
            }

            metadata.storage.files[profile] = {
                ...block,
                status,
                localPath,
                remoteKey
            };
        });

        fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');

        let cloudSyncTriggered = false;
        if (runCloudSync && metadata.storage.location === 'remote') {
            const hasPendingUpload = profiles.some(profile => metadata.storage.files[profile]?.status === 'pending');
            if (hasPendingUpload) {
                const cloudSyncRes = await axios.post(WORKER_ENDPOINTS.CLOUDSYNC, {
                    folderPath,
                    folderName: folder,
                    contentType: contentType || metadata.contentType || 'movie',
                    forceActualUpload: true
                }, { timeout: 1800000 });

                const patchData = cloudSyncRes.data?.patchData || {};
                metadata = {
                    ...metadata,
                    ...patchData,
                    storage: {
                        ...(metadata.storage || {}),
                        ...(patchData.storage || {}),
                        files: {
                            ...(metadata.storage?.files || {}),
                            ...(patchData.storage?.files || {})
                        }
                    },
                    pipelineState: patchData.pipelineState || metadata.pipelineState
                };

                fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
                cloudSyncTriggered = true;
            }
        }

        await LibraryScanner.runLibraryScanSweep();
        return res.json({
            success: true,
            folder,
            cloudSyncTriggered,
            storage: metadata.storage
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.response?.data?.error || err.message });
    }
});

router.post('/manual-worker-run', async (req, res) => {
    try {
        const { folder, contentType, worker } = req.body || {};
        const forceReprocess = req.body?.forceReprocess === true || String(req.body?.forceReprocess || '').toLowerCase() === 'true';
        if (!folder || !worker) {
            return res.status(400).json({ success: false, error: 'Missing folder or worker.' });
        }

        const cleanWorker = String(worker).toUpperCase();
        const workerMap = {
            INGEST: WORKER_ENDPOINTS.INGEST,
            METADATA: WORKER_ENDPOINTS.METADATA,
            SUBTITLES: WORKER_ENDPOINTS.SUBTITLES,
            TRANSCODE: WORKER_ENDPOINTS.TRANSCODE,
            CLOUDSYNC: WORKER_ENDPOINTS.CLOUDSYNC
        };

        const workerUrl = workerMap[cleanWorker];
        if (!workerUrl) {
            return res.status(400).json({ success: false, error: `Unsupported worker: ${worker}` });
        }

        const folderPath = resolveContentFolderPath(contentType, folder);
        if (!fs.existsSync(folderPath)) {
            return res.status(404).json({ success: false, error: 'Target folder not found.' });
        }

        let metadata = {};
        const metaFilePath = path.join(folderPath, 'metadata.json');
        if (fs.existsSync(metaFilePath)) {
            try {
                metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
            } catch (_err) {
                metadata = {};
            }
        }

        const payload = {
            folderPath,
            folderName: folder,
            contentType: contentType || metadata.contentType || (folderPath.includes('/series') ? 'series' : 'movie'),
            imdbId: metadata.imdbId || null,
            manualImdbId: metadata.imdbId || null,
            forceActualUpload: cleanWorker === 'CLOUDSYNC',
            forceReprocess: cleanWorker === 'TRANSCODE' ? forceReprocess : undefined
        };

        const workerResponse = await axios.post(workerUrl, payload, { timeout: 1800000 });

        if (workerResponse?.data?.success === false) {
            return res.status(422).json({
                success: false,
                error: workerResponse.data.error || `${cleanWorker} returned unsuccessful result.`,
                worker: cleanWorker,
                response: workerResponse.data
            });
        }

        await LibraryScanner.runLibraryScanSweep();

        return res.json({
            success: true,
            worker: cleanWorker,
            response: workerResponse.data
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.response?.data?.error || err.message });
    }
});

router.post('/generate-streaming-profiles', async (req, res) => {
    try {
        const { folder, contentType } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const folderPath = contentType === 'series'
            ? resolveSeriesFolderPath(folder)
            : resolveMovieFolderPath(folder);
        if (!fs.existsSync(folderPath)) {
            return res.status(404).json({ success: false, error: 'Target folder not found.' });
        }

        const metaFilePath = path.join(folderPath, 'metadata.json');
        let metadata = {};
        if (fs.existsSync(metaFilePath)) {
            try {
                metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
            } catch (_err) {
                metadata = {};
            }
        }

        const filesOnDisk = fs.readdirSync(folderPath);
        const hasWeb1080 = filesOnDisk.some(file => file.endsWith('.web.mp4'));

        // Ensure the 1080p master exists first; low-res worker requires it.
        if (!hasWeb1080) {
            const baseResponse = await axios.post(WORKER_ENDPOINTS.TRANSCODE, {
                folderPath,
                folderName: folder
            }, { timeout: 1800000 });

            if (baseResponse?.data?.success === false) {
                return res.status(422).json({
                    success: false,
                    error: baseResponse.data.error || 'Base transcoding failed before profile generation.'
                });
            }
        }

        const lowResResponse = await axios.post(`${String(WORKER_ENDPOINTS.TRANSCODE).replace(/\/process$/, '')}/process-low-res`, {
            folderPath,
            folderName: folder
        }, { timeout: 1800000 });

        if (lowResResponse?.data?.success === false) {
            return res.status(422).json({
                success: false,
                error: lowResResponse.data.error || 'Low-resolution profile generation failed.'
            });
        }

        const refreshedFiles = fs.readdirSync(folderPath);
        const profile720 = refreshedFiles.find(file => /\.720p\.mp4$/i.test(file)) || null;
        const profile480 = refreshedFiles.find(file => /\.480p\.mp4$/i.test(file)) || null;
        const profile1080 = refreshedFiles.find(file => /\.web\.mp4$/i.test(file)) || null;

        metadata.storage = metadata.storage || { location: 'local', files: {} };
        metadata.storage.files = metadata.storage.files || {};

        if (profile1080) {
            metadata.storage.files['1080p'] = {
                ...(metadata.storage.files['1080p'] || {}),
                status: metadata.storage.files['1080p']?.status || 'synced',
                localPath: profile1080,
                remoteKey: metadata.storage.files['1080p']?.remoteKey || null
            };
        }
        if (profile720) {
            metadata.storage.files['720p'] = {
                ...(metadata.storage.files['720p'] || {}),
                status: 'pending',
                localPath: profile720,
                remoteKey: null
            };
        }
        if (profile480) {
            metadata.storage.files['480p'] = {
                ...(metadata.storage.files['480p'] || {}),
                status: 'pending',
                localPath: profile480,
                remoteKey: null
            };
        }

        metadata.pipelineState = {
            ...(metadata.pipelineState || {}),
            lastUpdated: new Date().toISOString(),
            currentStep: metadata.pipelineState?.currentStep || 'COMPLETED',
            error: null
        };

        fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
        await LibraryScanner.runLibraryScanSweep();

        return res.json({
            success: true,
            folder,
            generated: {
                profile1080,
                profile720,
                profile480
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.response?.data?.error || err.message });
    }
});

router.post('/sync-item', async (req, res) => {
    try {
        const { folder, contentType } = req.body || {};
        const summary = await LibraryScanner.runLibraryScanSweep();
        await refreshLibraryFeeds();

        let itemFound = null;
        if (folder) {
            const library = await getLibrary();
            if (contentType === 'series') {
                const expectedId = `series/${encodeURIComponent(folder)}`;
                itemFound = (library.shows || []).some(s => s.id === expectedId || s.id === `series/${folder}`);
            } else {
                const expectedId = encodeURIComponent(folder);
                itemFound = (library.movies || []).some(m => m.id === expectedId);
            }
        }

        return res.json({ success: true, message: 'Library snapshot refreshed from disk.', summary, itemFound });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/rename-media', async (req, res) => {
    try {
        const { folder, contentType, newFolderName, newFileName } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const hasUnsafePath = (val) => String(val || '').includes('/') || String(val || '').includes('\\');
        if (hasUnsafePath(newFolderName) || hasUnsafePath(newFileName)) {
            return res.status(400).json({ success: false, error: 'Invalid rename value.' });
        }

        let baseDir = contentType === 'series' ? SERIES_DIR : MOVIES_DIR;
        let currentFolderName = folder;
        let currentPath = resolveContentFolderPath(contentType, currentFolderName);
        baseDir = path.dirname(currentPath);

        if (!fs.existsSync(currentPath)) {
            return res.status(404).json({ success: false, error: 'Target folder not found.' });
        }

        if (newFolderName && newFolderName.trim() && newFolderName.trim() !== currentFolderName) {
            const nextFolderName = newFolderName.trim();
            const nextPath = path.join(baseDir, nextFolderName);
            if (fs.existsSync(nextPath)) {
                return res.status(409).json({ success: false, error: 'Destination folder already exists.' });
            }
            await fsPromises.rename(currentPath, nextPath);
            currentFolderName = nextFolderName;
            currentPath = nextPath;
        }

        if (newFileName && newFileName.trim()) {
            const files = fs.readdirSync(currentPath);
            const videoExts = ['.web.mp4', '.mp4', '.mkv', '.m4v', '.avi', '.mov'];

            const sourceFile =
                files.find(f => f.endsWith('.web.mp4')) ||
                files.find(f => videoExts.some(ext => f.toLowerCase().endsWith(ext)));

            if (sourceFile) {
                const sourceExt = path.extname(sourceFile);
                const rawTarget = newFileName.trim();
                const targetFileName = path.extname(rawTarget) ? rawTarget : `${rawTarget}${sourceExt}`;

                if (targetFileName !== sourceFile) {
                    const sourcePath = path.join(currentPath, sourceFile);
                    const targetPath = path.join(currentPath, targetFileName);
                    if (fs.existsSync(targetPath)) {
                        return res.status(409).json({ success: false, error: 'Destination file already exists.' });
                    }
                    await fsPromises.rename(sourcePath, targetPath);
                }
            }
        }

        const metaFilePath = path.join(currentPath, 'metadata.json');
        if (fs.existsSync(metaFilePath)) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
                metadata.folderName = currentFolderName;
                metadata.folderPath = currentPath;
                metadata.pipelineState = metadata.pipelineState || {};
                metadata.pipelineState.lastUpdated = new Date().toISOString();
                fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
            } catch (_err) {
                // Best-effort metadata patch only.
            }
        }

        await LibraryScanner.runLibraryScanSweep();
        await refreshLibraryFeeds();
        return res.json({ success: true, folder: currentFolderName });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});


router.post('/archive-local-media', async (req, res) => {
    try {
        const {
            folder,
            contentType,
            retentionDays = ARCHIVE_RETENTION_DAYS,
            archivePolicy,
            sourceProfile
        } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const folderPath = contentType === 'series'
            ? resolveSeriesFolderPath(folder)
            : resolveMovieFolderPath(folder);
        const metaPath = path.join(folderPath, 'metadata.json');

        if (!fs.existsSync(folderPath) || !fs.existsSync(metaPath)) {
            return res.status(404).json({ success: false, error: 'Target metadata folder not found.' });
        }

        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if ((metadata.localArchive?.state || '') === 'quarantined') {
            return res.status(409).json({ success: false, error: 'Item is already quarantined in archive.' });
        }

        const remoteCheck = await verifyRemoteCloudCopy(metadata, {
            policy: archivePolicy,
            sourceProfile
        });
        if (!remoteCheck.ok) {
            return res.status(409).json({ success: false, error: remoteCheck.reason });
        }

        const candidates = gatherArchiveCandidates(folderPath, metadata);
        if (candidates.length === 0) {
            return res.status(409).json({ success: false, error: 'No local media files found to archive.' });
        }

        const safeFolder = sanitizeArchiveName(folder);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveRoot = path.join(ARCHIVE_DIR, contentType === 'series' ? 'series' : 'movies', `${safeFolder}_${stamp}`);

        await fsPromises.mkdir(archiveRoot, { recursive: true });

        const movedFiles = [];
        let reclaimedBytes = 0;
        for (const candidate of candidates) {
            const fileName = candidate.fileName;
            const sourcePath = path.join(folderPath, fileName);
            if (!fs.existsSync(sourcePath)) continue;

            const destPath = path.join(archiveRoot, fileName);
            if (!ensurePathInside(archiveRoot, destPath)) {
                return res.status(400).json({ success: false, error: `Unsafe archive target blocked for ${fileName}` });
            }

            const stat = fs.statSync(sourcePath);
            reclaimedBytes += stat.size;

            // =========================================================================
            // 🔄 EXDEV CROSS-DEVICE MOVE FALLBACK
            // =========================================================================
            try {
                // Try fast atomic filesystem rename
                await fsPromises.rename(sourcePath, destPath);
            } catch (renameErr) {
                if (renameErr.code === 'EXDEV') {
                    // Fall back to multi-device stream copy and delete
                    await fsPromises.copyFile(sourcePath, destPath);
                    await fsPromises.unlink(sourcePath);
                } else {
                    throw renameErr; // Bubble up true permission or disk space issues
                }
            }
            // =========================================================================

            movedFiles.push({
                fileName,
                fileType: candidate.fileType || 'other',
                size: stat.size,
                archivedPath: destPath
            });

            Object.keys(metadata.storage?.files || {}).forEach(profile => {
                const profileBlock = metadata.storage.files[profile] || {};
                if (profileBlock.localPath === fileName) {
                    metadata.storage.files[profile] = {
                        ...profileBlock,
                        localPath: null
                    };
                }
            });
        }

        const archivedAt = new Date().toISOString();
        const purgeAfter = new Date(Date.now() + Math.max(1, Number(retentionDays)) * 86400000).toISOString();
        metadata.localArchive = {
            state: 'quarantined',
            archivedAt,
            purgeAfter,
            archiveRoot,
            files: movedFiles,
            cloudVerifiedAt: archivedAt,
            cloudVerification: {
                bucket: remoteCheck.bucket,
                policy: remoteCheck.policy,
                sourceProfile: remoteCheck.sourceProfile,
                verified: remoteCheck.verified,
                pendingProfiles: remoteCheck.pendingProfiles || []
            }
        };

        await persistMetadataFile(metaPath, metadata);
        await LibraryScanner.runLibraryScanSweep();

        return res.json({
            success: true,
            folder,
            archiveRoot,
            movedCount: movedFiles.length,
            reclaimedBytes,
            purgeAfter,
            cloudVerification: metadata.localArchive.cloudVerification
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/archive-readiness', async (req, res) => {
    try {
        const { folder, contentType, archivePolicy, sourceProfile } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const folderPath = contentType === 'series'
            ? resolveSeriesFolderPath(folder)
            : resolveMovieFolderPath(folder);
        const metaPath = path.join(folderPath, 'metadata.json');

        if (!fs.existsSync(folderPath) || !fs.existsSync(metaPath)) {
            return res.status(404).json({ success: false, error: 'Target metadata folder not found.' });
        }

        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const candidates = gatherArchiveCandidates(folderPath, metadata);
        const reclaimableBytes = candidates.reduce((sum, item) => {
            const sourcePath = path.join(folderPath, item.fileName);
            if (!fs.existsSync(sourcePath)) return sum;
            try {
                return sum + fs.statSync(sourcePath).size;
            } catch (_err) {
                return sum;
            }
        }, 0);

        const cloudCheck = await verifyRemoteCloudCopy(metadata, {
            policy: archivePolicy,
            sourceProfile
        });

        const storageFiles = metadata?.storage?.files || {};
        const storageProfiles = listStorageProfiles(storageFiles).map((profile) => {
            const block = storageFiles[profile] || {};
            return {
                profile,
                status: block.status || 'unknown',
                hasRemoteKey: Boolean(cleanRemoteKey(block.remoteKey || '')),
                hasLocalPath: Boolean(String(block.localPath || '').trim())
            };
        });

        return res.json({
            success: true,
            folder,
            contentType: contentType === 'series' ? 'series' : 'movie',
            readyToArchive: cloudCheck.ok && candidates.length > 0,
            cloudCheck,
            localCandidates: {
                count: candidates.length,
                reclaimableBytes,
                files: candidates
            },
            storage: {
                location: metadata?.storage?.location || 'local',
                profiles: storageProfiles
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/restore-local-media', async (req, res) => {
    try {
        const { folder, contentType } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const folderPath = contentType === 'series'
            ? resolveSeriesFolderPath(folder)
            : resolveMovieFolderPath(folder);
        const metaPath = path.join(folderPath, 'metadata.json');
        if (!fs.existsSync(folderPath) || !fs.existsSync(metaPath)) {
            return res.status(404).json({ success: false, error: 'Target metadata folder not found.' });
        }

        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const localArchive = metadata.localArchive || {};
        if (localArchive.state !== 'quarantined' || !localArchive.archiveRoot) {
            return res.status(409).json({ success: false, error: 'No quarantined archive state found for this item.' });
        }
        if (!fs.existsSync(localArchive.archiveRoot)) {
            return res.status(404).json({ success: false, error: 'Archive directory missing for restore.' });
        }

        const restored = [];
        for (const fileRec of localArchive.files || []) {
            const fileName = fileRec.fileName;
            const sourcePath = path.join(localArchive.archiveRoot, fileName);
            const targetPath = path.join(folderPath, fileName);
            if (!fs.existsSync(sourcePath)) continue;
            if (fs.existsSync(targetPath)) {
                return res.status(409).json({ success: false, error: `Target file already exists: ${fileName}` });
            }

            await fsPromises.rename(sourcePath, targetPath);
            restored.push(fileName);

            Object.keys(metadata.storage?.files || {}).forEach(profile => {
                const block = metadata.storage.files[profile] || {};
                const profileName = String(profile || '').toLowerCase();
                const lowerFile = fileName.toLowerCase();
                if (block.localPath || !lowerFile.endsWith('.mp4')) return;
                if (profileName === '1080p' && (lowerFile.includes('1080') || lowerFile.includes('.web.'))) {
                    metadata.storage.files[profile] = { ...block, localPath: fileName };
                } else if (profileName === '720p' && lowerFile.includes('720')) {
                    metadata.storage.files[profile] = { ...block, localPath: fileName };
                } else if (profileName === '480p' && lowerFile.includes('480')) {
                    metadata.storage.files[profile] = { ...block, localPath: fileName };
                }
            });
        }

        metadata.localArchive = {
            ...localArchive,
            state: 'restored',
            restoredAt: new Date().toISOString()
        };

        try {
            const left = fs.readdirSync(localArchive.archiveRoot);
            if (left.length === 0) {
                await fsPromises.rmdir(localArchive.archiveRoot);
            }
        } catch (_err) {
            // keep best-effort cleanup non-fatal
        }

        await persistMetadataFile(metaPath, metadata);
        await LibraryScanner.runLibraryScanSweep();

        return res.json({ success: true, folder, restoredCount: restored.length });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/purge-archived-media', async (req, res) => {
    try {
        const { folder, contentType, force = false } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const folderPath = contentType === 'series'
            ? resolveSeriesFolderPath(folder)
            : resolveMovieFolderPath(folder);
        const metaPath = path.join(folderPath, 'metadata.json');
        if (!fs.existsSync(metaPath)) {
            return res.status(404).json({ success: false, error: 'metadata.json not found for purge target.' });
        }

        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const localArchive = metadata.localArchive || {};
        if (!localArchive.archiveRoot || localArchive.state !== 'quarantined') {
            return res.status(409).json({ success: false, error: 'No quarantined archive exists to purge.' });
        }

        const purgeAfter = Date.parse(localArchive.purgeAfter || '');
        const eligible = Number.isFinite(purgeAfter) ? Date.now() >= purgeAfter : false;
        if (!force && !eligible) {
            return res.status(409).json({
                success: false,
                error: `Archive retention window still active until ${localArchive.purgeAfter || 'unknown date'}.`
            });
        }

        if (fs.existsSync(localArchive.archiveRoot)) {
            await fsPromises.rm(localArchive.archiveRoot, { recursive: true, force: true });
        }

        metadata.localArchive = {
            ...localArchive,
            state: 'purged',
            purgedAt: new Date().toISOString()
        };

        await persistMetadataFile(metaPath, metadata);
        await LibraryScanner.runLibraryScanSweep();

        return res.json({ success: true, folder, purged: true });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/admin/sanitizer/run
router.post('/sanitizer/run', (req, res) => {
    res.json({ success: true, message: "Sanitizer execution sequence triggered." });
    
    pipelineOrchestrator.runFullAutomationPipeline("admin_manual_ui")
        .catch(err => logger.error(`Critical background processing fault: ${err.message}`));
});




// POST: /api/admin/upload-poster
router.post('/upload-poster', async (req, res) => {
    try {
        const { folder, image, contentType } = req.body;
        if (!folder || !image) {
            return res.status(400).json({ success: false, error: 'Missing parameters.' });
        }

        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        // 🚨 FIX 3: Point poster uploads to correct directory mount if it is a show
        const targetDir = resolveContentFolderPath(contentType, folder);

        try {
            await fsPromises.access(targetDir);
        } catch {
            return res.status(404).json({ success: false, error: 'Target directory not found.' });
        }

        await fsPromises.writeFile(path.join(targetDir, 'cover.jpg'), buffer);
        logger.info(`🎨 [ASSET OVERRIDE] Fresh poster artwork written directly to disk for: ${folder}`);
        
        // 🚨 FIX 4: Fire background db refresh instead of relying on broken global function hooks
        LibraryScanner.runLibraryScanSweep()
            .catch(err => logger.error(`Error running library sweep: ${err.message}`));
        
        res.json({ success: true, message: 'Poster written to disk.' });
    } catch (err) {
        logger.error(`Asset upload exception: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/library-metadata
router.get('/library-metadata', async (req, res) => {
    try {
        const library = await getLibrary();

        const normalizeStorageFiles = (files = {}) => {
            const out = {};
            Object.keys(files || {}).sort().forEach(profile => {
                const block = files[profile] || {};
                out[profile] = {
                    status: block.status || '',
                    localPath: block.localPath || '',
                    remoteKey: block.remoteKey || ''
                };
            });
            return out;
        };

        const normalizeComparable = (meta = {}) => ({
            title: meta.title || '',
            year: meta.year || '',
            imdbId: meta.imdbId || meta.imdb_id || '',
            plot: meta.plot || '',
            genre: meta.genre || '',
            enrichment: normalizeEnrichment(meta),
            storageLocation: meta.storage?.location || 'local',
            storageFiles: normalizeStorageFiles(meta.storage?.files || {})
        });

        const buildItem = (folder, redisMeta, type) => {
            const resolvedFolderPath = type === 'series'
                ? resolveSeriesFolderPath(folder)
                : resolveMovieFolderPath(folder);
            const diskMetaPath = path.join(resolvedFolderPath, 'metadata.json');

            let diskMeta = null;
            if (fs.existsSync(diskMetaPath)) {
                try {
                    diskMeta = JSON.parse(fs.readFileSync(diskMetaPath, 'utf-8'));
                } catch (_err) {
                    diskMeta = null;
                }
            }

            const redisComparable = normalizeComparable(redisMeta || {});
            const diskComparable = normalizeComparable(diskMeta || {});
            const inSync = JSON.stringify(redisComparable) === JSON.stringify(diskComparable);

            return {
                folder,
                metadata: diskMeta || redisMeta,
                redisMetadata: redisMeta,
                diskMetadata: diskMeta,
                resolvedDiskPath: fs.existsSync(resolvedFolderPath) ? resolvedFolderPath : null,
                syncState: {
                    inSync,
                    redisAvailable: Boolean(redisMeta),
                    diskAvailable: Boolean(diskMeta),
                    redisStorageLocation: redisComparable.storageLocation,
                    diskStorageLocation: diskComparable.storageLocation,
                    mismatchNote: diskMeta ? '' : `Disk metadata not found at ${diskMetaPath}`
                }
            };
        };
        
        const results = {
            movies: (library.movies || []).map(m => buildItem(decodeURIComponent(m.id), m, 'movie')),
            shows: (library.shows || []).map(s => buildItem(s.id.replace('series/', ''), s, 'series'))
        };

        res.json({ success: true, library: results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// QB_TORRENT / UI PANEL AUTOMATION TRIGGER ENDPOINT
// =========================================================================

router.post('/trigger-automation', async (req, res) => {
    // Instantly return a clean status code to the qBittorrent client agent
    res.status(202).send('Automation trigger received. Processing pool in background.');
    console.log(`\n⚡ qBittorrent completion trigger received! Invoking unified Orchestrator loop...`);

    try {
        // Run the real, modern pipeline with managed concurrency bounds safely
        await pipelineOrchestrator.runFullAutomationPipeline("qbittorrent_webhook");
        console.log(`✅ Automated background library sync completed flawlessly.`);
    } catch (err) {
        console.error(`❌ Automated orchestration cycle block exception:`, err.message);
    }
});

// =========================================================================
// ✍️ ENDPOINT 1: OVERRIDE METADATA (DASHBOARD PANEL SAVES)
// =========================================================================
router.post('/override-metadata', async (req, res) => {
    const {
        folder,
        contentType,
        title,
        year,
        imdbId,
        plot,
        genre,
        storage,
        tags,
        imdbScore,
        parentalRating,
        popularity,
        enrichment,
        groupMode,
        targetUser,
        libraryGroups,
        replaceGroups,
        deferCloudSync,
        forceCloudSync
    } = req.body;
    
    // Ensure custom dashboard panel modifications write metadata out to the true folder mounts
    const folderPath = resolveContentFolderPath(contentType, folder);
    const metaFilePath = path.join(folderPath, 'metadata.json');

    try {
        if (!fs.existsSync(metaFilePath)) {
            return res.status(404).json({ success: false, error: "metadata.json manifest missing on disk." });
        }

        let metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));

        // Handle both raw metadata blocks and standard flattened mappings gracefully
        if (!metadata.metadata) {
            metadata.title = title;
            metadata.year = year;
            metadata.imdbId = imdbId;
            metadata.plot = plot;
            metadata.genre = genre || metadata.genre || '';
        } else {
            metadata.metadata = { ...metadata.metadata, title, year, imdbId, plot, genre: genre || metadata.metadata.genre || '' };
            // Mirror back to root level to avoid background component blindness
            metadata.title = title;
            metadata.year = year;
            metadata.imdbId = imdbId;
            metadata.plot = plot;
            metadata.genre = genre || metadata.genre || metadata.metadata.genre || '';
        }

        const nextEnrichment = {
            ...normalizeEnrichment(metadata),
            ...normalizeEnrichment(enrichment || {}),
            tags: normalizeTagList(
                tags !== undefined ? tags : (enrichment?.tags !== undefined ? enrichment.tags : metadata.tags || metadata.enrichment?.tags)
            ),
            genre: enrichment?.genre || metadata.genre || metadata.metadata?.genre || metadata.enrichment?.genre || '',
            imdbScore: imdbScore || enrichment?.imdbScore || metadata.imdbScore || metadata.rating || metadata.enrichment?.imdbScore || 'N/A',
            parentalRating: parentalRating || enrichment?.parentalRating || metadata.parentalRating || metadata.enrichment?.parentalRating || 'N/A',
            popularity: popularity || enrichment?.popularity || metadata.popularity || metadata.enrichment?.popularity || 'N/A'
        };

        metadata.tags = nextEnrichment.tags;
        metadata.genre = nextEnrichment.genre || metadata.genre || '';
        metadata.imdbScore = nextEnrichment.imdbScore;
        metadata.parentalRating = nextEnrichment.parentalRating;
        metadata.popularity = nextEnrichment.popularity;
        metadata.enrichment = nextEnrichment;
        if (metadata.metadata) {
            metadata.metadata.genre = nextEnrichment.genre || metadata.metadata.genre || '';
            metadata.metadata.tags = nextEnrichment.tags;
            metadata.metadata.imdbScore = nextEnrichment.imdbScore;
            metadata.metadata.parentalRating = nextEnrichment.parentalRating;
            metadata.metadata.popularity = nextEnrichment.popularity;
            metadata.metadata.enrichment = nextEnrichment;
        }

        const normalizedTargetUser = normalizeUserKey(targetUser || '');
        const explicitGroups = normalizeGroups(libraryGroups || [], { ensureAllMedia: false });
        const requestedMode = String(groupMode || '').toLowerCase();

        if (explicitGroups.length > 0) {
            metadata.libraryGroups = mergeLibraryGroups(
                replaceGroups ? [] : (metadata.libraryGroups || []),
                explicitGroups,
                { addGlobalIfMissing: false }
            );
        } else if (requestedMode === 'user' && normalizedTargetUser) {
            const targetGroup = userGroup(normalizedTargetUser);
            metadata.libraryGroups = mergeLibraryGroups(
                replaceGroups ? [GROUP_ALL_MEDIA] : (metadata.libraryGroups || []),
                [targetGroup],
                { addGlobalIfMissing: false }
            );

            if (replaceGroups) {
                metadata.libraryGroups = normalizeGroups([GROUP_ALL_MEDIA, targetGroup], { addGlobalIfMissing: false });
            }

            metadata.addedByUsers = Array.from(new Set([
                ...(Array.isArray(metadata.addedByUsers) ? metadata.addedByUsers : []),
                normalizedTargetUser
            ])).sort();
        } else {
            // Admin edits default to globally visible assets unless explicitly moved to user-only mode.
            metadata.libraryGroups = mergeLibraryGroups(metadata.libraryGroups || [], [GROUP_GLOBAL], { addGlobalIfMissing: true });
        }

        let triggerCloudSync = false;
        const mergeStorage = (existingStorage = {}, incomingStorage = {}) => ({
            ...existingStorage,
            ...incomingStorage,
            files: {
                ...(existingStorage.files || {}),
                ...(incomingStorage.files || {})
            }
        });

        const filesOnDisk = fs.existsSync(folderPath) ? fs.readdirSync(folderPath) : [];
        const findLocalProfileFile = (profile) => {
            const suffix = profile === '1080p' ? '.web.mp4' : `.${profile}.mp4`;
            return filesOnDisk.find(f => f.endsWith(suffix)) || null;
        };

        if (storage && storage.location === 'remote') {
            if (!metadata.storage) {
                metadata.storage = { location: 'local', files: {} };
            }

            metadata.storage.location = 'remote';

            const profiles = ['1080p', '720p', '480p'];
            if (!metadata.storage.files) metadata.storage.files = {};

            profiles.forEach(profile => {
                const existingBlock = metadata.storage.files[profile] || {};
                const existingLocalPath = existingBlock.localPath && fs.existsSync(path.join(folderPath, existingBlock.localPath))
                    ? existingBlock.localPath
                    : null;
                const inferredLocalPath = existingLocalPath || findLocalProfileFile(profile);
                const shouldForcePending = forceCloudSync === true && Boolean(inferredLocalPath);

                if ((existingBlock.status !== 'synced' && inferredLocalPath) || shouldForcePending) {
                    metadata.storage.files[profile] = {
                        ...existingBlock,
                        status: 'pending',
                        localPath: inferredLocalPath,
                        remoteKey: existingBlock.remoteKey || null
                    };
                    triggerCloudSync = true;
                } else if (existingBlock.status !== 'synced') {
                    metadata.storage.files[profile] = {
                        ...existingBlock,
                        status: 'waiting',
                        localPath: inferredLocalPath || null,
                        remoteKey: existingBlock.remoteKey || null
                    };
                }
            });
        } else if (storage) {
            // Local storage option chosen (NVMe Local)
            metadata.storage = { location: 'local', files: {} };

            // 🎯 THE FIX: Force short-circuiting out of the pipeline processing loop
            if (!metadata.pipelineState) metadata.pipelineState = {};
            if (metadata.pipelineState.currentStep === 'UPLOAD') {
                logger.info(`💾 [Admin Override] Local NVMe allocation set for [${folder}]. Short-circuiting UPLOAD state to COMPLETED.`);
                metadata.pipelineState.currentStep = 'COMPLETED';
                metadata.pipelineState.lastUpdated = new Date().toISOString();
                metadata.pipelineState.error = null;
            }
        }

        if (metadata.storage && metadata.storage.files) {
            const repaired = repairStorageProfiles(
                metadata.storage,
                contentType,
                folder,
                metadata.imdbId || metadata.imdb_id || ''
            );
            metadata.storage = repaired.storage;
        }

        fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');

        if (triggerCloudSync) {
            logger.info(`📡 [Orchestrator Bridge] Allocation changed to Cloud for [${folder}]. Triggering CloudSync Worker on port 5004...`);

            if (deferCloudSync === true) {
                axios.post(WORKER_ENDPOINTS.CLOUDSYNC, {
                    folderPath: folderPath,
                    folderName: folder,
                    forceActualUpload: true
                }, { timeout: 1800000 })
                    .then(async (cloudSyncRes) => {
                        const patchData = cloudSyncRes.data?.patchData || {};
                        const nextMeta = {
                            ...metadata,
                            ...patchData,
                            storage: mergeStorage(metadata.storage, patchData.storage || {}),
                            pipelineState: patchData.pipelineState || metadata.pipelineState
                        };
                        fs.writeFileSync(metaFilePath, JSON.stringify(nextMeta, null, 4), 'utf-8');
                        await LibraryScanner.runLibraryScanSweep();
                    })
                    .catch((err) => {
                        logger.error(`❌ [Orchestrator Bridge] Deferred CloudSync failed for [${folder}]: ${err.message}`);
                    });
            } else {
                const cloudSyncRes = await axios.post(WORKER_ENDPOINTS.CLOUDSYNC, {
                    folderPath: folderPath,
                    folderName: folder,
                    forceActualUpload: true
                }, { timeout: 1800000 }).catch(err => {
                    logger.error(`❌ [Orchestrator Bridge] Failed to wake CloudSync Worker at endpoint: ${err.message}`);
                    throw err;
                });

                const patchData = cloudSyncRes.data?.patchData || {};
                metadata = {
                    ...metadata,
                    ...patchData,
                    storage: mergeStorage(metadata.storage, patchData.storage || {}),
                    pipelineState: patchData.pipelineState || metadata.pipelineState
                };

                fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
            }
        }

        // Refresh database record tracking arrays automatically
        await LibraryScanner.runLibraryScanSweep();

        return res.json({
            success: true,
            libraryLocation: metadata.storage.location,
            cloudSyncTriggered: triggerCloudSync,
            cloudSyncDeferred: triggerCloudSync && deferCloudSync === true,
            cloudSyncReason: triggerCloudSync
                ? 'pending_profiles_queued'
                : 'no_pending_profiles_or_local_files'
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/repair-storage-profiles', async (req, res) => {
    try {
        const { folder, contentType } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const normalizedType = String(contentType || '').toLowerCase() === 'series' ? 'series' : 'movie';
        const folderPath = normalizedType === 'series'
            ? resolveSeriesFolderPath(folder)
            : resolveMovieFolderPath(folder);
        const metaPath = path.join(folderPath, 'metadata.json');

        if (!fs.existsSync(metaPath)) {
            return res.status(404).json({ success: false, error: 'metadata.json not found for target.' });
        }

        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const repaired = repairStorageProfiles(
            metadata.storage || {},
            normalizedType,
            folder,
            metadata.imdbId || metadata.imdb_id || ''
        );

        metadata.storage = repaired.storage;
        await persistMetadataFile(metaPath, metadata);
        await LibraryScanner.runLibraryScanSweep();

        return res.json({
            success: true,
            folder,
            contentType: normalizedType,
            changed: repaired.changed,
            storage: metadata.storage
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/library-browser
// Lightweight paged/searchable view so admin UI can avoid loading full metadata for every item.
router.get('/library-browser', async (req, res) => {
    try {
        const contentType = String(req.query.contentType || 'movies').toLowerCase() === 'series' ? 'series' : 'movies';
        const query = String(req.query.query || '').trim();
        const group = String(req.query.group || 'any').trim();
        const sort = String(req.query.sort || 'updated_desc').trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));

        const library = await getLibrary();
        const bucket = getContentTypeBucket(contentType);
        const baseRows = Array.isArray(library[bucket]) ? library[bucket] : [];
        const normalizedRows = baseRows.map((row) => ({
            ...row,
            libraryGroups: normalizeGroups(row.libraryGroups || [], { addGlobalIfMissing: true })
        }));

        const filtered = applyLibrarySearchAndSort(normalizedRows, { query, group, sort });
        const totalItems = filtered.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / limit));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * limit;
        const slice = filtered.slice(start, start + limit);

        const items = slice.map((row) => {
            const lite = toAdminResultItem(row);
            const folderPath = contentType === 'series'
                ? resolveSeriesFolderPath(lite.folder)
                : resolveMovieFolderPath(lite.folder);
            const metaPath = path.join(folderPath, 'metadata.json');
            const diskMeta = readMetadataIfExists(metaPath);

            return {
                ...lite,
                metadata: diskMeta || lite.metadata,
                diskMetadata: diskMeta,
                resolvedDiskPath: fs.existsSync(folderPath) ? folderPath : null,
                syncState: {
                    ...lite.syncState,
                    diskAvailable: Boolean(diskMeta),
                    inSync: Boolean(diskMeta)
                }
            };
        });

        const groupsSeen = new Set(['any', GROUP_GLOBAL, GROUP_ALL_MEDIA]);
        normalizedRows.forEach((row) => {
            normalizeGroups(row.libraryGroups || [], { addGlobalIfMissing: true }).forEach((groupName) => groupsSeen.add(groupName));
        });

        return res.json({
            success: true,
            contentType,
            query,
            group,
            sort,
            page: safePage,
            limit,
            totalItems,
            totalPages,
            availableGroups: Array.from(groupsSeen).sort(),
            items
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/admin/library-groups/backfill
// Ensures all existing metadata manifests carry all-media + global unless already explicitly user-scoped.
router.post('/library-groups/backfill', async (_req, res) => {
    try {
        const library = await getLibrary();
        const buckets = [
            ...(Array.isArray(library.movies) ? library.movies : []),
            ...(Array.isArray(library.shows) ? library.shows : [])
        ];

        let updated = 0;
        let scanned = 0;
        for (const row of buckets) {
            const contentType = String(row.contentType || '').toLowerCase() === 'series' ? 'series' : 'movies';
            const folder = contentType === 'series'
                ? String(row.id || '').replace(/^series\//i, '')
                : decodeURIComponent(String(row.id || ''));
            const folderPath = contentType === 'series'
                ? resolveSeriesFolderPath(folder)
                : resolveMovieFolderPath(folder);
            const metaPath = path.join(folderPath, 'metadata.json');
            if (!fs.existsSync(metaPath)) continue;
            scanned += 1;

            const metadata = readMetadataIfExists(metaPath);
            if (!metadata) continue;

            const before = normalizeGroups(metadata.libraryGroups || [], { addGlobalIfMissing: false });
            const after = mergeLibraryGroups(before, [GROUP_GLOBAL], { addGlobalIfMissing: true });
            if (JSON.stringify(before.sort()) === JSON.stringify(after.sort())) continue;

            metadata.libraryGroups = after;
            fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 4), 'utf-8');
            updated += 1;
        }

        const summary = await LibraryScanner.runLibraryScanSweep();
        await refreshLibraryFeeds();
        return res.json({ success: true, scanned, updated, summary });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/admin/library-groups/update
// Add/remove global or user group tags for a specific media item.
router.post('/library-groups/update', async (req, res) => {
    try {
        const folder = String(req.body?.folder || '').trim();
        const contentType = String(req.body?.contentType || '').toLowerCase() === 'series' ? 'series' : 'movies';
        const action = String(req.body?.action || '').toLowerCase();
        const targetUser = normalizeUserKey(req.body?.targetUser || '');
        const explicitGroup = String(req.body?.group || '').trim().toLowerCase();

        if (!folder || !action) {
            return res.status(400).json({ success: false, error: 'Missing folder or action.' });
        }

        const folderPath = contentType === 'series' ? resolveSeriesFolderPath(folder) : resolveMovieFolderPath(folder);
        const metaPath = path.join(folderPath, 'metadata.json');
        if (!fs.existsSync(metaPath)) {
            return res.status(404).json({ success: false, error: 'metadata.json not found.' });
        }

        const metadata = readMetadataIfExists(metaPath) || {};
        const current = normalizeGroups(metadata.libraryGroups || [], { addGlobalIfMissing: true });
        const targetGroup = explicitGroup || (targetUser ? userGroup(targetUser) : '');

        let next = [...current];
        if (action === 'add-global') {
            next = mergeLibraryGroups(current, [GROUP_GLOBAL], { addGlobalIfMissing: true });
        } else if (action === 'remove-global') {
            next = normalizeGroups(current.filter((groupName) => groupName !== GROUP_GLOBAL), { addGlobalIfMissing: false });
            if (!next.includes(GROUP_ALL_MEDIA)) next.unshift(GROUP_ALL_MEDIA);
            next = Array.from(new Set(next)).sort();
        } else if (action === 'add-user') {
            if (!targetGroup) return res.status(400).json({ success: false, error: 'Missing target user/group.' });
            next = mergeLibraryGroups(current, [targetGroup], { addGlobalIfMissing: false });
        } else if (action === 'remove-user') {
            if (!targetGroup) return res.status(400).json({ success: false, error: 'Missing target user/group.' });
            next = normalizeGroups(current.filter((groupName) => groupName !== targetGroup), { addGlobalIfMissing: false });
            if (!next.includes(GROUP_ALL_MEDIA)) next.unshift(GROUP_ALL_MEDIA);
            next = Array.from(new Set(next)).sort();
        } else if (action === 'set-user-only') {
            if (!targetGroup) return res.status(400).json({ success: false, error: 'Missing target user/group.' });
            next = normalizeGroups([GROUP_ALL_MEDIA, targetGroup], { addGlobalIfMissing: false });
        } else {
            return res.status(400).json({ success: false, error: `Unsupported action: ${action}` });
        }

        metadata.libraryGroups = next;
        if (targetUser) {
            metadata.addedByUsers = Array.from(new Set([
                ...(Array.isArray(metadata.addedByUsers) ? metadata.addedByUsers : []),
                targetUser
            ])).sort();
        }

        fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 4), 'utf-8');
        await LibraryScanner.runLibraryScanSweep();
        await refreshLibraryFeeds();

        return res.json({
            success: true,
            folder,
            contentType,
            libraryGroups: metadata.libraryGroups,
            addedByUsers: metadata.addedByUsers || []
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// 🔄 ENDPOINT 2: REFETCH METADATA (OMDb + TMDb FALLBACK SYNCHRONIZATION)
// =========================================================================
router.post('/refetch-metadata', async (req, res) => {
    try {
        const { folder, contentType, imdbId, title } = req.body;
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Target directory not supplied.' });
        }

        const targetDir = resolveContentFolderPath(contentType, folder);

        const metaFilePath = path.join(targetDir, 'metadata.json');

        const requestedImdbId = imdbId && String(imdbId).trim().startsWith('tt')
            ? String(imdbId).trim()
            : '';
        const titleHint = title ? String(title).trim() : folder.replace(/[-_.]/g, ' ');

        const metadataLookup = await metadataProvider.fetchMetadataWithFallback({
            imdbId: requestedImdbId,
            title: titleHint,
            contentType
        });
        const data = metadataLookup.data;

        if (!data || data.Response === "False") {
            return res.status(404).json({ success: false, error: 'No matching metadata found from configured providers.' });
        }

        // Read the file context if it already exists to avoid smashing your storage sync metrics
        let existingMeta = {};
        if (fs.existsSync(metaFilePath)) {
            try {
                existingMeta = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
            } catch (pErr) {
                existingMeta = {};
            }
        }

        // Ensure both camelCase and snake_case variations are stored identically
        const finalImdbId = data.imdbID || imdbId || '';
        const cleanTitle = data.Title || folder.replace(/[-_.]/g, ' ');

        // Construct baseline flat map fields securely
        const normalizedMetadata = {
            ...existingMeta, // Retain underlying storage/file status states safely
            title: cleanTitle,
            year: data.Year || '',
            genre: data.Genre || 'N/A',
            tags: normalizeTagList(data.Genre || 'N/A'),
            imdbScore: data.imdbRating || 'N/A',
            parentalRating: data.Rated || 'N/A',
            popularity: data.imdbVotes || 'N/A',
            imdbId: finalImdbId,
            imdb_id: finalImdbId, // ✨ Map snake_case to preserve frontend input bindings
            plot: data.Plot || '',
            contentType: contentType
        };

        // 🎯 THE FIX: Keep nested structure perfectly mirrored so UI views and background processes are completely unified
        normalizedMetadata.metadata = {
            ...(existingMeta.metadata || {}),
            title: cleanTitle,
            year: data.Year || '',
            genre: data.Genre || 'N/A',
            tags: normalizeTagList(data.Genre || 'N/A'),
            imdbScore: data.imdbRating || 'N/A',
            parentalRating: data.Rated || 'N/A',
            popularity: data.imdbVotes || 'N/A',
            imdbId: finalImdbId,
            imdb_id: finalImdbId,
            plot: data.Plot || '',
            enrichment: {
                genre: data.Genre || 'N/A',
                tags: normalizeTagList(data.Genre || 'N/A'),
                imdbScore: data.imdbRating || 'N/A',
                parentalRating: data.Rated || 'N/A',
                popularity: data.imdbVotes || 'N/A',
                popularitySource: data.imdbVotes ? 'imdbVotes' : 'unknown'
            }
        };

        // Prevent structural dropouts on pipeline state properties
        if (!normalizedMetadata.pipelineState) {
            normalizedMetadata.pipelineState = existingMeta.pipelineState || { 
                currentStep: 'COMPLETED', 
                lastUpdated: new Date().toISOString(), 
                error: null 
            };
        }

        await fsPromises.writeFile(metaFilePath, JSON.stringify(normalizedMetadata, null, 4), 'utf-8');

        if (data.Poster && data.Poster !== "N/A") {
            try {
                await metadataService.downloadCover(data.Poster, path.join(targetDir, 'cover.jpg'));
                logger.info(`📥 [METADATA REFETCH] Cover artwork downloaded successfully for: ${folder}`);
            } catch (imgErr) {
                logger.warn(`⚠️ [METADATA WARN] Failed retrieving art asset: ${imgErr.message}`);
            }
        }

        // Fire background DB sync loop cleanly
        await LibraryScanner.runLibraryScanSweep();

        res.json({ success: true, metadata: normalizedMetadata });
    } catch (err) {
        logger.error(`❌ [REFETCH FAILURE] Exception dropped: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/users
router.get('/users', (req, res) => {
    try {
        const userMetaDir = path.join(__dirname, '../../metadata', 'users');
        if (!fs.existsSync(userMetaDir)) return res.json({ success: true, users: [] });

        const profiles = fs.readdirSync(userMetaDir).map(folder => {
            const userPath = path.join(userMetaDir, folder);
            if (!fs.lstatSync(userPath).isDirectory()) return null;

            const hasHistory = fs.existsSync(path.join(userPath, 'history.json'));
            const hasPlayback = fs.existsSync(path.join(userPath, 'playback.json'));
            const configPath = path.join(userPath, 'config.json');
            let config = {};

            if (fs.existsSync(configPath)) {
                try {
                    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) || {};
                } catch (_err) {
                    config = {};
                }
            }

            const subscriptionStatus = String(config.subscriptionStatus || '').toUpperCase();
            const hasPremium = ['ACTIVE', 'TRIALING', 'PENDING', 'PAUSED', 'GRACE'].includes(subscriptionStatus)
                || Boolean(config.squareSubscriptionId)
                || Boolean(config.freeAccessActive);
            
            return {
                username: folder,
                email: config.email || folder,
                displayName: config.displayName || config.name || config.username || folder,
                hasHistory,
                hasPlayback,
                hasPremium,
                subscriptionStatus: subscriptionStatus || 'NONE',
                billingTier: config.billingTier || null,
                nextBillingDate: config.nextBillingDate || null,
                trialEndsAt: config.trialEndsAt || null,
                squareCustomerId: config.squareCustomerId || null,
                squareSubscriptionId: config.squareSubscriptionId || null,
                updatedAt: config.updatedAt || null
            };
        }).filter(Boolean);

        res.json({ success: true, users: profiles });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/admin/users/reset-subscriptions
// Bulk reset billing/subscription state for all users (intended for sandbox -> production cutover cleanup).
router.post('/users/reset-subscriptions', async (req, res) => {
    try {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const resetTrial = body.resetTrial !== false;

        const users = await ProfileService.listUsers();
        if (!Array.isArray(users) || users.length === 0) {
            return res.json({ success: true, updated: 0, users: [], message: 'No users found.' });
        }

        const updatedUsers = [];
        const errors = [];

        for (const userKey of users) {
            try {
                const config = await ProfileService.readData(userKey, 'config', {});

                const nextConfig = {
                    ...config,
                    subscriptionStatus: 'GUEST',
                    billingTier: null,
                    cancelAtPeriodEnd: false,
                    nextBillingDate: null,
                    subscribedAt: null,
                    squareCustomerId: null,
                    squareSubscriptionId: null,
                    squarePlanVariationId: null,
                    lastSquareWebhookType: null,
                    lastSquareWebhookAt: null,
                    hasDonated: false,
                    freeAccessActive: false,
                    gracePeriodEndsAt: null,
                    updatedAt: Date.now()
                };

                if (resetTrial) {
                    nextConfig.trialDays = 0;
                    nextConfig.trialEndsAt = null;
                }

                await ProfileService.writeData(userKey, 'config', nextConfig);
                updatedUsers.push(userKey);
            } catch (err) {
                errors.push({ userKey, error: err.message });
            }
        }

        return res.json({
            success: errors.length === 0,
            updated: updatedUsers.length,
            users: updatedUsers,
            errors,
            resetTrial
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/users/:userKey/watch-history
router.get('/users/:userKey/watch-history', async (req, res) => {
    try {
        const userKey = String(req.params.userKey || '').trim().toLowerCase();
        const limit = parseInt(req.query.limit, 10) || 200;
        if (!userKey) {
            return res.status(400).json({ success: false, error: 'Missing user key.' });
        }

        const history = await ProfileService.getWatchHistory(userKey, { limit });
        return res.json({
            success: true,
            userKey,
            count: history.length,
            history
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/media/:contentType/:folder/subtitles', async (req, res) => {
    try {
        const contentType = String(req.params.contentType || '').toLowerCase();
        const folder = String(req.params.folder || '').trim();
        const folderPath = contentType === 'series'
            ? resolveSeriesFolderPath(folder)
            : resolveMovieFolderPath(folder);
        const metaPath = path.join(folderPath, 'metadata.json');

        if (!folder || !fs.existsSync(folderPath) || !fs.existsSync(metaPath)) {
            return res.status(404).json({ success: false, error: 'Metadata folder not found.' });
        }

        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const subtitles = Array.isArray(metadata.subtitleCatalog)
            ? metadata.subtitleCatalog
            : (Array.isArray(metadata.subtitles) ? metadata.subtitles : []);

        return res.json({
            success: true,
            folder,
            contentType,
            subtitleSelection: metadata.subtitleSelection || null,
            subtitles
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/media/:contentType/:folder/subtitles/default', async (req, res) => {
    try {
        const contentType = String(req.params.contentType || '').toLowerCase();
        const folder = String(req.params.folder || '').trim();
        const relativePath = String(req.body?.relativePath || '').trim();
        const folderPath = contentType === 'series'
            ? resolveSeriesFolderPath(folder)
            : resolveMovieFolderPath(folder);
        const metaPath = path.join(folderPath, 'metadata.json');

        if (!folder || !relativePath) {
            return res.status(400).json({ success: false, error: 'Missing folder or relative subtitle path.' });
        }

        if (!fs.existsSync(folderPath) || !fs.existsSync(metaPath)) {
            return res.status(404).json({ success: false, error: 'Metadata folder not found.' });
        }

        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const subtitles = Array.isArray(metadata.subtitleCatalog)
            ? metadata.subtitleCatalog
            : (Array.isArray(metadata.subtitles) ? metadata.subtitles : []);

        const selected = subtitles.find(item => String(item.relativePath || '').trim() === relativePath);
        if (!selected) {
            return res.status(404).json({ success: false, error: 'Subtitle track not found in catalog.' });
        }

        metadata.subtitleSelection = {
            defaultRelativePath: selected.relativePath,
            defaultLanguage: selected.language || null,
            defaultLabel: selected.label || selected.fileName || selected.relativePath,
            source: selected.source || null,
            updatedAt: new Date().toISOString()
        };
        metadata.subtitleDefault = selected.relativePath;
        metadata.subtitleCatalog = subtitles;
        metadata.subtitles = subtitles;
        metadata.pipelineState = metadata.pipelineState || {};
        metadata.pipelineState.lastUpdated = new Date().toISOString();

        await persistMetadataFile(metaPath, metadata);
        await LibraryScanner.runLibraryScanSweep();

        return res.json({
            success: true,
            folder,
            contentType,
            subtitleSelection: metadata.subtitleSelection
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;