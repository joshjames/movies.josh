// src/routes/torrent.routes.js
// YTS/EZTV directory lookup proxies, qBittorrent service links, and telemetry pipes.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');
const { getLibrary } = require('../services/db');
const { runLibraryScanSweep } = require('../services/LibraryScanner');
const { getActiveUser } = require('../middleware/auth');
const ProfileService = require('../services/ProfileService');
const AcquisitionQuotaService = require('../services/AcquisitionQuotaService');
const {
    userGroup,
    normalizeGroups,
    mergeLibraryGroups,
    normalizeUserKey
} = require('../services/LibraryAccessService');

const logger = require('../services/logger');
const TorrentService = require('../services/TorrentService');
const MetadataRegistry = require('../services/MetadataRegistry');
const { getSeriesByImdbId } = require('../services/TvSeriesIndexService');
const { getByImdbId: getMovieByImdbId } = require('../services/MovieTitleIndexService');
const { 
    createJob, 
    getAllJobs, 
    getFailedJobs, 
    getJob,
    updateJob,
    removeJob
} = require('../services/PipelineQueueService');

const MOVIES_DIR = process.env.MOVIES_DIR || (fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies');
const FALLBACK_COVER_DATA_URI =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="100%" height="100%" fill="#020617"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#475569">No Cover</text></svg>');

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDisplayTitle(value) {
    return String(value || '')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildQueueMediaTitle({ title = '', imdbId = null, contentType = 'movie', payload = {} } = {}) {
    const queueContext = (payload && typeof payload.queueContext === 'object') ? payload.queueContext : {};
    const cleanImdbId = normalizeImdbId(imdbId || payload.imdbId || queueContext.imdbId);
    const season = parseInt(queueContext.season, 10);
    const episode = parseInt(queueContext.episode, 10);
    const isSeries = String(contentType || '').toLowerCase() === 'series' || Boolean(Number.isFinite(season) && season > 0 || Number.isFinite(episode) && episode > 0);

    let baseTitle = normalizeDisplayTitle(payload.mediaTitle || queueContext.mediaTitle || title || payload.torrentName || 'Queue Item');

    if (cleanImdbId) {
        if (isSeries) {
            const series = getSeriesByImdbId(cleanImdbId);
            baseTitle = normalizeDisplayTitle(series?.title || series?.originalTitle || baseTitle);
        } else {
            const movie = getMovieByImdbId(cleanImdbId);
            baseTitle = normalizeDisplayTitle(movie?.title || baseTitle);
        }
    }

    if (isSeries && baseTitle) {
        const seasonPart = Number.isFinite(season) && season > 0 ? `S${String(season).padStart(2, '0')}` : '';
        const episodePart = Number.isFinite(episode) && episode > 0 ? `E${String(episode).padStart(2, '0')}` : '';
        if (seasonPart && episodePart) return `${baseTitle} ${seasonPart}${episodePart}`;
        if (seasonPart) return `${baseTitle} ${seasonPart}`;
    }

    return baseTitle;
}

function buildQueueRowTitle(jobOrItem = {}, fallback = 'Queue Item') {
    const payload = (jobOrItem && typeof jobOrItem.payload === 'object') ? jobOrItem.payload : {};
    return buildQueueMediaTitle({
        title: jobOrItem.title || fallback,
        imdbId: jobOrItem.imdbId || payload.imdbId || null,
        contentType: jobOrItem.contentType || payload.contentType || 'movie',
        payload
    });
}

function parseSeasonEpisodeFromTitle(title) {
    const raw = String(title || '');
    const sxeMatches = Array.from(raw.matchAll(/s(\d{1,2})\s*e(\d{1,2})/gi));
    const sxe = sxeMatches.length ? sxeMatches[sxeMatches.length - 1] : null;
    if (sxe) {
        return {
            season: parseInt(sxe[1], 10),
            episode: parseInt(sxe[2], 10)
        };
    }

    const seasonOnly = raw.match(/season\s*(\d{1,2})/i) || raw.match(/s(\d{1,2})(?!\d)/i);
    if (seasonOnly) {
        return {
            season: parseInt(seasonOnly[1], 10),
            episode: null
        };
    }

    return { season: null, episode: null };
}

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return null;
    return `tt${cleaned}`;
}

function looksLikeSeasonPack(title) {
    return /(season\s*pack|\bcomplete\b|s\d{1,2}\s*complete|seasons?\s*\d+\s*-\s*\d+|\[pack\]|\bpack\b)/i.test(String(title || ''));
}

function normalizeQueueContext(queueContext, magnetUrl) {
    const incoming = (queueContext && typeof queueContext === 'object') ? queueContext : {};
    let magnetName = '';
    try {
        magnetName = new URL(magnetUrl).searchParams.get('dn') || '';
    } catch (_err) {
        magnetName = '';
    }

    const parsedFromName = parseSeasonEpisodeFromTitle(magnetName);
    const seasonFromIncoming = parseInt(incoming.season, 10);
    const episodeFromIncoming = parseInt(incoming.episode, 10);

    const season = Number.isFinite(seasonFromIncoming) && seasonFromIncoming > 0
        ? seasonFromIncoming
        : (Number.isFinite(parsedFromName.season) && parsedFromName.season > 0 ? parsedFromName.season : null);
    const episode = Number.isFinite(episodeFromIncoming) && episodeFromIncoming > 0
        ? episodeFromIncoming
        : (Number.isFinite(parsedFromName.episode) && parsedFromName.episode > 0 ? parsedFromName.episode : null);

    const sourceType = String(incoming.sourceType || '').toLowerCase();
    const normalizedSourceType = sourceType === 'pack' || sourceType === 'episode'
        ? sourceType
        : (episode ? 'episode' : (season ? 'pack' : null));

    const incomingUser = normalizeUserKey(incoming.addedByUser || incoming.userKey || incoming.userId);
    const inferredGroup = userGroup(incomingUser);
    const requestedGroups = normalizeGroups(incoming.libraryGroups || [], { ensureAllMedia: false });

    return {
        imdbId: normalizeImdbId(incoming.imdbId) || null,
        season,
        episode,
        sourceType: normalizedSourceType,
        addedByUser: incomingUser || null,
        libraryGroups: mergeLibraryGroups(
            requestedGroups,
            inferredGroup ? [inferredGroup] : [],
            { addGlobalIfMissing: false }
        )
    };
}

function findLibraryItemByImdbId(library, imdbId) {
    const target = normalizeImdbId(imdbId);
    if (!target) return null;

    const allItems = [
        ...(Array.isArray(library?.movies) ? library.movies : []),
        ...(Array.isArray(library?.shows) ? library.shows : [])
    ];

    return allItems.find((item) => normalizeImdbId(item?.imdbId || item?.imdb_id) === target) || null;
}

function safelyReadJson(filePath, fallback = {}) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_err) {
        return fallback;
    }
}

function isPrivilegedUser(userKey) {
    const clean = normalizeUserKey(userKey);
    if (!clean) return false;
    return clean === 'josh' || clean.startsWith('josh@');
}

function getJobOwner(job) {
    const payload = (job && typeof job.payload === 'object') ? job.payload : {};
    const queueContext = (payload && typeof payload.queueContext === 'object') ? payload.queueContext : {};
    return normalizeUserKey(
        queueContext.addedByUser ||
        queueContext.userKey ||
        queueContext.userId ||
        payload.addedByUser
    );
}

function inferRetryStep(job) {
    const validSteps = new Set(['INGEST', 'METADATA', 'SUBTITLES', 'TRANSCODE', 'CLOUDSYNC']);
    const current = String(job?.currentStep || '').toUpperCase();
    if (validSteps.has(current)) return current;

    const history = Array.isArray(job?.history) ? job.history : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const step = String(history[i]?.step || '').toUpperCase();
        if (validSteps.has(step)) return step;
    }

    return 'INGEST';
}

function parseBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function getJobQueueOptions(job) {
    const options = (job?.payload && typeof job.payload.queueOptions === 'object') ? job.payload.queueOptions : {};
    return {
        notifyOnComplete: parseBoolean(options.notifyOnComplete, false),
        addToWatchLaterOnComplete: parseBoolean(options.addToWatchLaterOnComplete, false)
    };
}

function canManageJob(viewerUser, jobOwner) {
    if (!viewerUser) return false;
    if (isPrivilegedUser(viewerUser)) return true;
    return Boolean(jobOwner && jobOwner === viewerUser);
}

function canUseQueueAdminTools(viewerUser) {
    return Boolean(viewerUser && isPrivilegedUser(viewerUser));
}

async function hasQueueAdminAccess(userKey) {
    const cleanUser = normalizeUserKey(userKey);
    if (!cleanUser || cleanUser === 'guest') return false;
    if (isPrivilegedUser(cleanUser)) return true;

    try {
        const config = await ProfileService.readData(cleanUser, 'config', {});
        return config?.isAdmin === true;
    } catch (_err) {
        return false;
    }
}

async function attachExistingMediaToUserLibrary({ imdbId, activeUser }) {
    const cleanUser = normalizeUserKey(activeUser);
    if (!cleanUser || cleanUser === 'guest') {
        return { attached: false, reason: 'guest-user' };
    }

    const library = await getLibrary();
    const existingItem = findLibraryItemByImdbId(library, imdbId);
    if (!existingItem?.sourcePath) {
        return { attached: false, reason: 'missing-existing-item' };
    }

    const metadataPath = path.join(existingItem.sourcePath, 'metadata.json');
    const folderName = path.basename(existingItem.sourcePath);
    const metadata = await MetadataRegistry.read(metadataPath, folderName);
    const targetGroup = userGroup(cleanUser);

    metadata.libraryGroups = mergeLibraryGroups(
        metadata.libraryGroups || existingItem.libraryGroups || [],
        [targetGroup],
        { addGlobalIfMissing: true }
    );

    metadata.addedByUsers = Array.from(new Set([
        ...(Array.isArray(metadata.addedByUsers) ? metadata.addedByUsers : []),
        cleanUser
    ])).sort();

    await MetadataRegistry.writeAndCommit(metadataPath, folderName, metadata);
    await runLibraryScanSweep();

    return {
        attached: true,
        itemId: existingItem.id,
        title: existingItem.title || existingItem.id,
        metadataPath
    };
}

function isMovieAcquisitionCategory(category = '') {
    return !String(category || '').trim().toLowerCase().includes('series');
}

async function reserveMovieAcquisitionQuota({ userKey, targetCategory }) {
    if (!isMovieAcquisitionCategory(targetCategory)) {
        return { allowed: true, skipped: true };
    }

    const config = await ProfileService.readData(userKey, 'config', {});
    return AcquisitionQuotaService.reserveDailyAcquisition(userKey, config);
}

function simplifyEztvTorrents(rawTorrents, targetImdbId, cover, packsOnly) {
    const all = rawTorrents || [];
    const deduped = [];
    const seen = new Set();
    for (const t of all) {
        const titleNorm = normalizeText(t.filename || t.title);
        const key = [String(t.hash || '').toLowerCase(), titleNorm].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(t);
    }

    const normalized = deduped
        .map(t => {
            const title = String(t.title || t.filename || '').trim();
            const parsed = parseSeasonEpisodeFromTitle(title);
            const seasonRaw = parseInt(t.season, 10);
            const episodeRaw = parseInt(t.episode, 10);
            const season = Number.isFinite(seasonRaw) ? seasonRaw : parsed.season;
            const episode = Number.isFinite(episodeRaw) ? episodeRaw : parsed.episode;
            if (!Number.isFinite(season) || season <= 0) return null;

            const seeds = parseInt(t.seeds, 10) || 0;
            const peers = parseInt(t.peers, 10) || 0;
            const released = parseInt(t.date_released_unix, 10) || 0;
            const isPack = looksLikeSeasonPack(title);

            return {
                title,
                season,
                episode: Number.isFinite(episode) ? episode : null,
                seeds,
                peers,
                released,
                isPack,
                sizeBytes: parseFloat(t.size_bytes) || 0,
                magnet: t.magnet_url || `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(title)}`,
                imdbId: targetImdbId,
                cover
            };
        })
        .filter(Boolean);

    const packCandidates = normalized.filter(t => t.isPack);
    const seededPackCandidates = packCandidates.filter(t => t.seeds > 0);
    const seededAll = normalized.filter(t => t.seeds > 0);

    const pickBest = (items, scoreFn) => {
        if (!items.length) return null;
        return items.reduce((best, cur) => (scoreFn(cur) > scoreFn(best) ? cur : best));
    };

    const scorePack = (t) => (t.seeds * 100) + t.peers + (t.released / 1000000);
    const scoreEpisode = (t) => ((t.episode || 0) * 100000) + (t.seeds * 100) + t.peers + (t.released / 1000000);

    const seasons = Array.from(new Set(normalized.map(t => t.season))).sort((a, b) => a - b);
    const selected = [];

    if (packsOnly) {
        // Strictly show real season packs. If none are seeded, allow unseeded packs as a fallback.
        const source = seededPackCandidates.length ? seededPackCandidates : packCandidates;
        for (const season of seasons) {
            const perSeason = source.filter(t => t.season === season);
            const best = pickBest(perSeason, scorePack);
            if (best) {
                selected.push({ ...best, sourceType: 'pack' });
            }
        }
    } else {
        // Prefer complete season packs per season; otherwise use best available representative episode.
        for (const season of seasons) {
            const seasonPackSeeded = seededPackCandidates.filter(t => t.season === season);
            const seasonPackAny = packCandidates.filter(t => t.season === season);
            const packPick = pickBest(seasonPackSeeded, scorePack) || pickBest(seasonPackAny, scorePack);

            if (packPick) {
                selected.push({ ...packPick, sourceType: 'pack' });
                continue;
            }

            const seasonEpisodes = seededAll.filter(t => t.season === season && !t.isPack);
            const episodePick = pickBest(seasonEpisodes, scoreEpisode);
            if (episodePick) {
                selected.push({ ...episodePick, sourceType: 'episode' });
            }
        }
    }

    const items = selected
        .sort((a, b) => a.season - b.season)
        .map(item => ({
            title: item.sourceType === 'pack'
                ? `Season ${item.season} complete`
                : `S${String(item.season).padStart(2, '0')}E${String(item.episode || 1).padStart(2, '0')} best available`,
            originalTitle: item.title,
            sourceType: item.sourceType,
            size: item.sizeBytes > 0 ? `${(item.sizeBytes / (1024 ** 3)).toFixed(2)} GB` : 'N/A',
            seeds: item.seeds,
            peers: item.peers,
            magnet: item.magnet,
            imdbId: item.imdbId,
            season: item.season,
            episode: item.episode || '',
            cover: item.cover
        }));

    return {
        items,
        packsFallbackUsed: packsOnly && seededPackCandidates.length === 0 && packCandidates.length > 0,
        packRows: items.filter(i => i.sourceType === 'pack').length,
        episodeRows: items.filter(i => i.sourceType === 'episode').length
    };
}

function mapRawEztvRows(rawTorrents, targetImdbId, cover, packsOnly, limit = 100) {
    const all = rawTorrents || [];
    const deduped = [];
    const seen = new Set();

    for (const t of all) {
        const titleNorm = normalizeText(t.filename || t.title);
        const key = [String(t.hash || '').toLowerCase(), titleNorm].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(t);
    }

    const parsed = deduped
        .map(t => {
            const title = String(t.title || t.filename || '').trim();
            const parsedTitle = parseSeasonEpisodeFromTitle(title);
            const seasonRaw = parseInt(t.season, 10);
            const episodeRaw = parseInt(t.episode, 10);
            const season = Number.isFinite(seasonRaw) ? seasonRaw : parsedTitle.season;
            const episode = Number.isFinite(episodeRaw) ? episodeRaw : parsedTitle.episode;

            if (!Number.isFinite(season) || season <= 0) return null;

            const seeds = parseInt(t.seeds, 10) || 0;
            const peers = parseInt(t.peers, 10) || 0;
            const released = parseInt(t.date_released_unix, 10) || 0;
            const isPack = looksLikeSeasonPack(title);

            return {
                title,
                originalTitle: title,
                sourceType: isPack ? 'pack' : 'episode',
                season,
                episode: Number.isFinite(episode) ? episode : '',
                seeds,
                peers,
                released,
                sizeBytes: parseFloat(t.size_bytes) || 0,
                magnet: t.magnet_url || `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(title)}`,
                imdbId: targetImdbId,
                cover
            };
        })
        .filter(Boolean);

    const filteredByType = packsOnly ? parsed.filter(t => t.sourceType === 'pack') : parsed;
    const packs = filteredByType.filter(t => t.sourceType === 'pack');
    const episodes = filteredByType.filter(t => t.sourceType === 'episode' && Number.isFinite(t.episode) && t.episode > 0);

    const scoreRelease = (row) => {
        return (row.seeds * 1000) + (row.peers * 10) + Math.floor((row.released || 0) / 1000);
    };

    const bestByEpisode = new Map();
    for (const row of episodes) {
        const key = `${row.season}-${row.episode}`;
        const current = bestByEpisode.get(key);

        if (!current) {
            bestByEpisode.set(key, {
                bestAny: row,
                bestSeeded: row.seeds > 0 ? row : null
            });
            continue;
        }

        if (scoreRelease(row) > scoreRelease(current.bestAny)) {
            current.bestAny = row;
        }

        if (row.seeds > 0) {
            if (!current.bestSeeded || scoreRelease(row) > scoreRelease(current.bestSeeded)) {
                current.bestSeeded = row;
            }
        }
    }

    const selectedEpisodes = Array.from(bestByEpisode.values())
        .map(entry => entry.bestSeeded || entry.bestAny)
        .filter(Boolean);

    const selectedPacks = (() => {
        if (!packsOnly) return packs;
        const seededPacks = packs.filter(p => p.seeds > 0);
        return seededPacks.length ? seededPacks : packs;
    })();

    const merged = [...selectedPacks, ...selectedEpisodes]
        .sort((a, b) => {
            if (a.season !== b.season) return a.season - b.season;
            const ae = Number.isFinite(a.episode) ? a.episode : 0;
            const be = Number.isFinite(b.episode) ? b.episode : 0;
            if (ae !== be) return ae - be;
            return scoreRelease(b) - scoreRelease(a);
        })
        .slice(0, limit);

    const items = merged.map(item => ({
        title: item.sourceType === 'pack'
            ? `Season ${item.season} complete`
            : `S${String(item.season).padStart(2, '0')}E${String(item.episode || 1).padStart(2, '0')} release`,
        originalTitle: item.originalTitle,
        sourceType: item.sourceType,
        size: item.sizeBytes > 0 ? `${(item.sizeBytes / (1024 ** 3)).toFixed(2)} GB` : 'N/A',
        seeds: item.seeds,
        peers: item.peers,
        magnet: item.magnet,
        imdbId: item.imdbId,
        season: item.season,
        episode: item.episode,
        cover: item.cover
    }));

    return {
        items,
        packRows: items.filter(i => i.sourceType === 'pack').length,
        episodeRows: items.filter(i => i.sourceType === 'episode').length,
        nonZeroSeedRows: filteredByType.filter(t => t.seeds > 0).length,
        totalParsedRows: parsed.length,
        totalEpisodeCandidates: episodes.length,
        uniqueEpisodeCandidates: bestByEpisode.size
    };
}

async function fetchEztvPages(imdbId, maxPages = 5) {
    const endpointCandidates = [
        'https://eztv.wf/api/get-torrents',
        'https://eztv.re/api/get-torrents'
    ];

    const collected = [];
    const upstreamWarnings = [];
    let scannedPages = 0;

    for (let page = 1; page <= maxPages; page++) {
        scannedPages += 1;
        let pageData = null;
        let lastError = null;

        for (const endpoint of endpointCandidates) {
            try {
                const response = await axios.get(`${endpoint}?imdb_id=${imdbId}&limit=100&page=${page}`, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (MovieStreamer/1.0)',
                        'Accept': 'application/json,text/plain,*/*'
                    }
                });

                if (Array.isArray(response.data?.torrents)) {
                    pageData = response.data.torrents;
                    break;
                }
                lastError = new Error(`Invalid payload from ${endpoint}`);
            } catch (err) {
                lastError = err;
            }
        }

        if (!pageData) {
            upstreamWarnings.push(`Page ${page} unavailable: ${lastError ? lastError.message : 'unknown upstream error'}`);
            break;
        }

        collected.push(...pageData);
        if (pageData.length < 100) break;
    }

    return {
        torrents: collected,
        scannedPages,
        upstreamWarnings
    };
}

function parseIntSafe(value, fallback = 0) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatSafe(value, fallback = 0) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function inferQualityLabel(title) {
    const name = String(title || '').toLowerCase();
    if (/\b(2160p|4k|uhd)\b/.test(name)) return '2160p';
    if (/\b1080p\b/.test(name)) return '1080p';
    if (/\b720p\b/.test(name)) return '720p';
    if (/\b480p\b/.test(name)) return '480p';
    return 'unknown';
}

function formatSizeLabel(sizeBytes) {
    const bytes = Number(sizeBytes);
    if (!Number.isFinite(bytes) || bytes <= 0) return 'N/A';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 ** 2);
    return `${mb.toFixed(1)} MB`;
}

function normalizeSearchResultRow(row) {
    const title = String(
        row?.fileName || row?.name || row?.title || row?.filename || ''
    ).trim();
    const sizeBytes = parseFloatSafe(row?.fileSize ?? row?.size ?? row?.size_bytes, 0);
    const seeds = parseIntSafe(row?.nbSeeders ?? row?.seeds ?? row?.seeders, 0);
    const peers = parseIntSafe(row?.nbLeechers ?? row?.peers ?? row?.leechers, 0);
    const fileUrl = String(row?.fileUrl || row?.url || row?.magnet || '').trim();
    const siteUrl = String(row?.siteUrl || row?.site || '').trim();
    const descrLink = String(row?.descrLink || row?.description || '').trim();
    const pubDate = String(row?.pubDate || row?.date || '').trim();
    const parsed = parseSeasonEpisodeFromTitle(title);

    return {
        title,
        sizeBytes,
        sizeLabel: formatSizeLabel(sizeBytes),
        seeds,
        peers,
        quality: inferQualityLabel(title),
        season: parsed.season,
        episode: parsed.episode,
        source: siteUrl || 'unknown',
        fileUrl,
        magnetUrl: fileUrl,
        descrLink,
        pubDate,
        raw: row
    };
}

function buildFilterObject(query = {}) {
    const text = String(query.text || '').trim();
    const imdbId = normalizeImdbId(query.imdbId) || null;
    const season = parseIntSafe(query.season, null);
    const episode = parseIntSafe(query.episode, null);
    const minSeeds = Math.max(0, parseIntSafe(query.minSeeds, 0));
    const minSizeMb = Math.max(0, parseFloatSafe(query.minSizeMb, 0));
    const maxSizeMb = Math.max(0, parseFloatSafe(query.maxSizeMb, 0));
    const quality = String(query.quality || '').trim().toLowerCase();
    const source = String(query.source || '').trim().toLowerCase();
    const mustContain = String(query.mustContain || '').trim().toLowerCase();
    const excludeWords = String(query.excludeWords || '').trim().toLowerCase();

    return {
        text,
        imdbId,
        season: Number.isFinite(season) && season > 0 ? season : null,
        episode: Number.isFinite(episode) && episode > 0 ? episode : null,
        minSeeds,
        minSizeBytes: minSizeMb > 0 ? minSizeMb * 1024 * 1024 : 0,
        maxSizeBytes: maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : 0,
        quality: ['2160p', '1080p', '720p', '480p', 'unknown'].includes(quality) ? quality : '',
        source,
        mustContain,
        excludeWords
    };
}

function applySearchFilters(rows, filters) {
    const tokens = normalizeText(filters.text).split(' ').filter(Boolean);
    const mustTokens = normalizeText(filters.mustContain).split(' ').filter(Boolean);
    const excludeTokens = normalizeText(filters.excludeWords).split(' ').filter(Boolean);
    const imdbToken = filters.imdbId ? filters.imdbId.toLowerCase().replace(/^tt/, '') : '';

    return rows.filter((row) => {
        const haystack = normalizeText(`${row.title} ${row.source} ${row.descrLink}`);

        if (tokens.length && !tokens.every(t => haystack.includes(t))) return false;
        if (mustTokens.length && !mustTokens.every(t => haystack.includes(t))) return false;
        if (excludeTokens.length && excludeTokens.some(t => haystack.includes(t))) return false;

        if (imdbToken) {
            const imdbHaystack = `${haystack} ${String(row.fileUrl || '').toLowerCase()} ${String(row.descrLink || '').toLowerCase()}`;
            if (!imdbHaystack.includes(imdbToken)) return false;
        }

        if (filters.season && row.season !== filters.season) return false;
        if (filters.episode && row.episode !== filters.episode) return false;
        if (filters.minSeeds && row.seeds < filters.minSeeds) return false;
        if (filters.minSizeBytes && row.sizeBytes < filters.minSizeBytes) return false;
        if (filters.maxSizeBytes && row.sizeBytes > filters.maxSizeBytes) return false;
        if (filters.quality && row.quality !== filters.quality) return false;
        if (filters.source && !String(row.source || '').toLowerCase().includes(filters.source)) return false;

        return true;
    });
}

function rankSearchRows(rows, filters) {
    const textTokens = normalizeText(filters.text).split(' ').filter(Boolean);

    return [...rows].sort((a, b) => {
        const score = (row) => {
            const haystack = normalizeText(row.title || '');
            const textMatches = textTokens.reduce((acc, token) => acc + (haystack.includes(token) ? 1 : 0), 0);
            const seasonBonus = (filters.season && row.season === filters.season) ? 60 : 0;
            const episodeBonus = (filters.episode && row.episode === filters.episode) ? 50 : 0;
            const qualityBonus = row.quality === '2160p' ? 18 : (row.quality === '1080p' ? 10 : 0);
            return (row.seeds * 10) + (row.peers * 4) + (textMatches * 20) + seasonBonus + episodeBonus + qualityBonus;
        };

        const delta = score(b) - score(a);
        if (delta !== 0) return delta;
        return a.title.localeCompare(b.title);
    });
}

function resolveQbitApiUrl() {
    let raw = String(process.env.QBIT_SEARCH_URL || process.env.QBIT_API_URL || process.env.QBIT_URL || 'http://qbittorrent:8080').trim();
    raw = raw.replace(/\/+$/, '');
    if (raw.endsWith('/api/v2')) return raw;
    if (raw.endsWith('/search')) raw = raw.slice(0, -('/search'.length));
    return `${raw}/api/v2`;
}

function isQbitUpstreamError(err) {
    const code = String(err?.code || '').toUpperCase();
    const message = String(err?.message || '').toLowerCase();
    return (
        code === 'EAI_AGAIN' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNREFUSED' ||
        message.includes('eai_again') ||
        message.includes('enotfound') ||
        message.includes('econnrefused')
    );
}

function searchErrorResponse(err) {
    const upstreamStatus = parseIntSafe(err?.upstreamStatus, 0);
    const upstreamAction = String(err?.upstreamAction || '');

    if (upstreamStatus === 404 && (upstreamAction === 'search/status' || upstreamAction === 'search/results')) {
        return {
            status: 502,
            payload: {
                success: false,
                error: 'qBittorrent started a search id but does not track it (status/results return 404).',
                code: 'QBIT_SEARCH_JOB_NOT_TRACKED',
                upstreamStatus,
                upstreamAction,
                qbitApiUrl: resolveQbitApiUrl(),
                upstreamMessage: String(err?.message || ''),
                hint: 'Check qBittorrent Execution Log for search engine/plugin failures. Search plugins can be installed/enabled but still fail at runtime and jobs may disappear immediately.'
            }
        };
    }

    if (isQbitUpstreamError(err)) {
        return {
            status: 503,
            payload: {
                success: false,
                error: 'qBittorrent API unreachable from this runtime.',
                code: String(err?.code || 'UPSTREAM_UNAVAILABLE'),
                qbitApiUrl: resolveQbitApiUrl(),
                upstreamStatus: err?.upstreamStatus || null,
                upstreamAction: err?.upstreamAction || null,
                upstreamMessage: String(err?.message || '')
            }
        };
    }

    return {
        status: 500,
        payload: {
            success: false,
            error: err.message
        }
    };
}

// GET: /api/torrent/search/plugins
router.get('/search/plugins', async (_req, res) => {
    try {
        const plugins = await TorrentService.getSearchPlugins();
        return res.json({ success: true, count: plugins.length, plugins });
    } catch (err) {
        logger.error(`[Torrent Search] Plugin query failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

// POST: /api/torrent/search/start
router.post('/search/start', async (req, res) => {
    try {
        const query = String(req.body?.query || '').trim();
        const category = String(req.body?.category || 'all').trim();
        const plugins = String(req.body?.plugins || 'enabled').trim();

        if (!query) {
            return res.status(400).json({ success: false, error: 'query is required.' });
        }

        const started = await TorrentService.startSearch({ query, category, plugins });
        return res.json({
            success: true,
            searchId: started.id,
            query,
            category,
            plugins,
            raw: started.raw
        });
    } catch (err) {
        logger.error(`[Torrent Search] Start failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

// GET: /api/torrent/search/status?id=1
router.get('/search/status', async (req, res) => {
    try {
        const id = req.query?.id;
        const statuses = await TorrentService.getSearchStatus(id);
        return res.json({ success: true, statuses });
    } catch (err) {
        logger.error(`[Torrent Search] Status failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

// GET: /api/torrent/search/results?id=1&limit=200&offset=0&minSeeds=5
router.get('/search/results', async (req, res) => {
    try {
        const id = parseIntSafe(req.query?.id, null);
        if (id === null) {
            return res.status(400).json({ success: false, error: 'id is required.' });
        }

        const limit = Math.max(1, Math.min(500, parseIntSafe(req.query?.limit, 200)));
        const offset = Math.max(0, parseIntSafe(req.query?.offset, 0));
        const filters = buildFilterObject(req.query || {});

        const result = await TorrentService.getSearchResults(id, { limit, offset });
        const normalizedRaw = result.results.map(normalizeSearchResultRow);
        const filtered = applySearchFilters(normalizedRaw, filters);
        const rankedFiltered = rankSearchRows(filtered, filters);

        return res.json({
            success: true,
            searchId: id,
            status: result.status,
            total: result.total,
            page: { limit, offset },
            filters,
            counts: {
                raw: normalizedRaw.length,
                filtered: rankedFiltered.length
            },
            raw: normalizedRaw,
            filtered: rankedFiltered
        });
    } catch (err) {
        logger.error(`[Torrent Search] Results failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

// POST: /api/torrent/search/delete
router.post('/search/delete', async (req, res) => {
    try {
        const id = req.body?.id !== undefined ? req.body.id : 'all';
        const deleted = await TorrentService.deleteSearch(id);
        return res.json({ success: true, deleted });
    } catch (err) {
        logger.error(`[Torrent Search] Delete failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

// =========================================================================
// 🔍 FIXED YTS BROWSE PROXY ENDPOINT
// =========================================================================
router.get('/yts/browse', async (req, res) => {
    try {
        // Collect the incoming variables sent from the frontend template
        const { query_term, page, genre, minimum_rating, sort_by } = req.query;
        const ytsUrl = `https://movies-api.accel.li/api/v2/list_movies.json`;
        
        // Build an explicit clean object containing only valid API arguments
        const apiParams = {
            page: page || 1,
            limit: 24,
            order_by: 'desc'
        };

        // Rule 1: Only append query_term if the string is populated and not '0'
        if (query_term && query_term.trim() !== '' && query_term !== '0') {
            apiParams.query_term = query_term.trim();
        }

        // Rule 2: Pass genre ONLY if it's explicitly chosen and not generic 'All'
        if (genre && genre.toLowerCase() !== 'all') {
            apiParams.genre = genre.toLowerCase();
        }

        // Rule 3: Pass rating constraints cleanly if higher than baseline zero
        if (minimum_rating && minimum_rating !== '0') {
            apiParams.minimum_rating = minimum_rating;
        }

        // Rule 4: Map your dynamic frontend sort option directly down to the payload
        if (sort_by) {
            apiParams.sort_by = sort_by;
        } else {
            apiParams.sort_by = 'date_added'; // Safe fallback baseline
        }

        console.log(`📡 Relaying sanitized query params to YTS:`, apiParams);

        const response = await axios.get(ytsUrl, { params: apiParams });

        res.json(response.data);
    } catch (err) {
        console.error("❌ YTS directory route communication failure:", err.message);
        res.status(500).json({ error: "Failed to fetch media data source indices." });
    }
});



// GET: /api/eztv/browse
router.get('/eztv/browse', async (req, res) => {
    try {
        const queryTerm = req.query.query ? req.query.query.trim() : '';
        const directImdbId = req.query.imdbId ? String(req.query.imdbId).trim() : '';
        const packsOnly = req.query.packsOnly === 'true';
        const consolidated = req.query.consolidated !== 'false';
        let targetImdbId = directImdbId ? directImdbId.replace(/^tt/i, '') : '';
        let omdbMeta = null;

        if (!queryTerm && !targetImdbId) return res.json({ success: true, torrents: [] });

        if (!targetImdbId) {
            const omdbRes = await axios.get(`http://www.omdbapi.com/?apikey=84196d01&s=${encodeURIComponent(queryTerm)}&type=series`);
            
            if (omdbRes.data?.Search?.length > 0) {
                const match = omdbRes.data.Search[0];
                targetImdbId = match.imdbID.replace(/^tt/i, '');
                const detailRes = await axios.get(`http://www.omdbapi.com/?apikey=84196d01&i=${match.imdbID}`);
                omdbMeta = detailRes.data;
            } else {
                targetImdbId = queryTerm.startsWith('tt') ? queryTerm.replace('tt', '') : '';
            }
        }

        if (!targetImdbId) return res.json({ success: true, torrents: [] });

        const normalizedImdbId = normalizeImdbId(targetImdbId);
        if (!normalizedImdbId) return res.json({ success: true, torrents: [] });

        const eztvFetch = await fetchEztvPages(targetImdbId, 5);
        const allTorrents = eztvFetch.torrents;

        const posterUrl = typeof omdbMeta?.Poster === 'string' ? omdbMeta.Poster.trim() : '';
        const cover = posterUrl && posterUrl !== 'N/A' ? posterUrl : FALLBACK_COVER_DATA_URI;
        const reduced = consolidated
            ? simplifyEztvTorrents(allTorrents, normalizedImdbId, cover, packsOnly)
            : mapRawEztvRows(allTorrents, normalizedImdbId, cover, packsOnly);

        logger.debug(`[EZTV] imdb=${normalizedImdbId} packsOnly=${packsOnly} consolidated=${consolidated} raw=${allTorrents.length} out=${reduced.items.length} packRows=${reduced.packRows || 0} episodeRows=${reduced.episodeRows || 0}`);

        return res.json({
            success: true,
            torrents: reduced.items,
            packsOnlyRequested: packsOnly,
            consolidated,
            packsFallbackUsed: Boolean(reduced.packsFallbackUsed),
            packRows: reduced.packRows || 0,
            episodeRows: reduced.episodeRows || 0,
            nonZeroSeedRows: reduced.nonZeroSeedRows,
            totalParsedRows: reduced.totalParsedRows,
            totalEpisodeCandidates: reduced.totalEpisodeCandidates,
            uniqueEpisodeCandidates: reduced.uniqueEpisodeCandidates,
            upstreamWarnings: eztvFetch.upstreamWarnings,
            scannedPages: eztvFetch.scannedPages,
            rawCount: allTorrents.length
        });
    } catch (err) {
        logger.error(`EZTV proxy route failure: ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// 📥 QB_TORRENT INTERNAL INGESTION ROUTING MATCHES
// =========================================================================

// POST: /api/downloader/add
router.post('/downloader/add', async (req, res) => {
    const { magnetUrl, category, imdbId, queueContext } = req.body; 

    if (!magnetUrl) {
        return res.status(400).json({ error: "Missing target magnet payload." });
    }

    try {
        const activeUser = normalizeUserKey(getActiveUser(req));
        const normalizedCategory = String(category || 'series-streamer').trim().toLowerCase();
        const normalizedQueueContext = normalizeQueueContext({
            ...(queueContext || {}),
            addedByUser: activeUser || null
        }, magnetUrl);
        const hasSeriesQueueHints = Boolean(
            normalizedQueueContext?.season ||
            normalizedQueueContext?.episode ||
            normalizedQueueContext?.sourceType === 'pack' ||
            normalizedQueueContext?.sourceType === 'episode'
        );
        const isSeriesRequest = normalizedCategory === 'series' || normalizedCategory === 'series-streamer' || hasSeriesQueueHints;
        const targetCategory = isSeriesRequest ? 'series-streamer' : 'movie-streamer';
        const effectiveImdbId = normalizeImdbId(imdbId || normalizedQueueContext.imdbId);

        // Only short-circuit already-available requests for movies.
        // TV requests should still enqueue magnets so missing episodes/seasons can be acquired.
        if (effectiveImdbId && !isSeriesRequest) {
            const attached = await attachExistingMediaToUserLibrary({ imdbId: effectiveImdbId, activeUser });
            if (attached.attached) {
                return res.status(200).json({
                    success: true,
                    alreadyAvailable: true,
                    message: 'Already in storage. Added to your My Library shelf.',
                    itemId: attached.itemId,
                    title: attached.title
                });
            }
        }

        const quotaReservation = await reserveMovieAcquisitionQuota({ userKey: activeUser, targetCategory });
        if (!quotaReservation.allowed) {
            return res.status(quotaReservation.reason === 'missing_user' ? 401 : 429).json({
                success: false,
                error: quotaReservation.reason === 'missing_user'
                    ? 'Authentication required.'
                    : 'Daily acquisition limit reached.',
                quota: quotaReservation
            });
        }

        const effectiveQueueContext = {
            ...normalizedQueueContext,
            imdbId: effectiveImdbId || normalizedQueueContext.imdbId || null
        };
        try {
            await TorrentService.addMagnet(magnetUrl, targetCategory, effectiveImdbId, {
                addedByUser: effectiveQueueContext.addedByUser || activeUser || null,
                queueContext: effectiveQueueContext
            });
        } catch (err) {
            if (quotaReservation.token) {
                await AcquisitionQuotaService.releaseDailyAcquisition(activeUser, quotaReservation.token);
            }
            throw err;
        }
        
        // Create a placeholder queue job to track intent while download is in progress.
        const torrentName = new URL(magnetUrl).searchParams.get('dn') || 'Unknown';
        const infoHash = (() => {
            try {
                const xt = new URL(magnetUrl).searchParams.get('xt') || '';
                return xt.includes('btih:') ? xt.split('btih:')[1] : null;
            } catch (_e) {
                return null;
            }
        })();
        const mediaTitle = buildQueueMediaTitle({
            title: torrentName,
            imdbId: effectiveImdbId,
            contentType: targetCategory === 'series-streamer' ? 'series' : 'movie',
            payload: {
                torrentName,
                queueContext: effectiveQueueContext
            }
        });

        createJob({
            status: 'WAITING_DOWNLOAD',
            currentStep: 'INGEST',
            imdbId: effectiveImdbId || null,
            contentType: targetCategory === 'series-streamer' ? 'series' : 'movie',
            payload: {
                torrentHash: infoHash,
                torrentName,
                rawPath: null,
                cleanPath: null,
                videoFile: null,
                magnetUrl,
                imdbId: effectiveImdbId || null,
                mediaTitle,
                addedByUser: effectiveQueueContext.addedByUser || activeUser || null,
                queueContext: effectiveQueueContext
            }
        });
        
        return res.status(200).json({ success: true, message: "Queued layout allocation pipeline records." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// POST: /api/yts/add (Legacy alias layout router mapping)
router.post('/yts/add', async (req, res) => {
    const { magnetUrl, imdbId, queueContext } = req.body;
    if (!magnetUrl) return res.status(400).json({ error: "Missing target magnet payload." });

    try {
        const activeUser = normalizeUserKey(getActiveUser(req));
        const normalizedQueueContext = normalizeQueueContext({
            ...(queueContext || {}),
            addedByUser: activeUser || null
        }, magnetUrl);
        const effectiveImdbId = normalizeImdbId(imdbId || normalizedQueueContext.imdbId);

        if (effectiveImdbId) {
            const attached = await attachExistingMediaToUserLibrary({ imdbId: effectiveImdbId, activeUser });
            if (attached.attached) {
                return res.status(200).json({
                    success: true,
                    alreadyAvailable: true,
                    message: 'Already in storage. Added to your My Library shelf.',
                    itemId: attached.itemId,
                    title: attached.title
                });
            }
        }

        const quotaReservation = await reserveMovieAcquisitionQuota({ userKey: activeUser, targetCategory: 'movie-streamer' });
        if (!quotaReservation.allowed) {
            return res.status(quotaReservation.reason === 'missing_user' ? 401 : 429).json({
                success: false,
                error: quotaReservation.reason === 'missing_user'
                    ? 'Authentication required.'
                    : 'Daily acquisition limit reached.',
                quota: quotaReservation
            });
        }

        const effectiveQueueContext = {
            ...normalizedQueueContext,
            imdbId: effectiveImdbId || normalizedQueueContext.imdbId || null
        };
        try {
            await TorrentService.addMagnet(magnetUrl, 'movie-streamer', effectiveImdbId, {
                addedByUser: effectiveQueueContext.addedByUser || activeUser || null,
                queueContext: effectiveQueueContext
            });
        } catch (err) {
            if (quotaReservation.token) {
                await AcquisitionQuotaService.releaseDailyAcquisition(activeUser, quotaReservation.token);
            }
            throw err;
        }
        
        // Create a placeholder queue job to track intent while download is in progress.
        const torrentName = new URL(magnetUrl).searchParams.get('dn') || 'Unknown';
        const infoHash = (() => {
            try {
                const xt = new URL(magnetUrl).searchParams.get('xt') || '';
                return xt.includes('btih:') ? xt.split('btih:')[1] : null;
            } catch (_e) {
                return null;
            }
        })();
        const mediaTitle = buildQueueMediaTitle({
            title: torrentName,
            imdbId: effectiveImdbId,
            contentType: 'movie',
            payload: {
                torrentName,
                queueContext: effectiveQueueContext
            }
        });

        createJob({
            status: 'WAITING_DOWNLOAD',
            currentStep: 'INGEST',
            imdbId: effectiveImdbId || null,
            contentType: 'movie',
            payload: {
                torrentHash: infoHash,
                torrentName,
                rawPath: null,
                cleanPath: null,
                videoFile: null,
                magnetUrl,
                imdbId: effectiveImdbId || null,
                mediaTitle,
                addedByUser: effectiveQueueContext.addedByUser || activeUser || null,
                queueContext: effectiveQueueContext
            }
        });
        
        return res.status(200).json({ success: true, message: "Successfully queued layout allocation pipeline records." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 📊 TELEMETRY & WORKFLOW DATA MONITOR
// =========================================================================

// GET: /api/pipeline/status - Returns active downloads and queue jobs with stage info
router.get('/pipeline/status', async (req, res) => {
    try {
        const activeUser = normalizeUserKey(getActiveUser(req));
        const requestScope = String(req.query.scope || '').trim().toLowerCase();
        const includeAll = requestScope === 'all' && await hasQueueAdminAccess(activeUser);
        const viewerUser = includeAll ? null : activeUser;

        let pipeline = [];
        let failedJobs = [];

        const allJobs = getAllJobs();

        // Build a full pipeline hash index from qBittorrent so stale placeholders can be reconciled.
        let knownPipelineHashes = new Set();
        let activePipelineHashes = new Set();
        let reconciliationReady = false;
        try {
            const rawQbitBase = String(process.env.QBIT_API_URL || process.env.QBIT_URL || 'http://qbittorrent:8080').trim();
            const qbitBase = rawQbitBase.endsWith('/api/v2')
                ? rawQbitBase
                : `${rawQbitBase.replace(/\/+$/, '')}/api/v2`;
            const qbitSnapshot = await axios.get(`${qbitBase}/torrents/info`, { timeout: 3500 });
            const pipelineTorrents = (qbitSnapshot.data || []).filter((torrent) => {
                const tags = String(torrent?.tags || '');
                return tags.includes('movie-streamer') || tags.includes('series-streamer');
            });

            knownPipelineHashes = new Set(
                pipelineTorrents
                    .map(torrent => String(torrent?.hash || '').trim().toLowerCase())
                    .filter(Boolean)
            );

            activePipelineHashes = new Set(
                pipelineTorrents
                    .filter((torrent) => !String(torrent?.tags || '').includes('-processed'))
                    .map(torrent => String(torrent?.hash || '').trim().toLowerCase())
                    .filter(Boolean)
            );
            reconciliationReady = true;
        } catch (snapshotErr) {
            logger.warn(`[Queue API] qBittorrent reconciliation skipped: ${snapshotErr.message}`);
        }

        const waitingByHash = new Map();
        allJobs.forEach((job) => {
            const hash = String(job?.payload?.torrentHash || '').trim().toLowerCase();
            if (!hash) return;
            if (job.status !== 'WAITING_DOWNLOAD' && job.status !== 'PAUSED_DOWNLOAD') return;
            if (!waitingByHash.has(hash)) {
                waitingByHash.set(hash, job);
                return;
            }

            const existing = waitingByHash.get(hash);
            const existingTs = new Date(existing?.updatedAt || existing?.createdAt || 0).getTime();
            const incomingTs = new Date(job?.updatedAt || job?.createdAt || 0).getTime();
            if (incomingTs >= existingTs) waitingByHash.set(hash, job);
        });

        // Remove orphaned waiting placeholders that no longer exist in qBittorrent.
        if (reconciliationReady) {
            for (const [hash, waitingJob] of waitingByHash.entries()) {
                const isWaiting = waitingJob.status === 'WAITING_DOWNLOAD' || waitingJob.status === 'PAUSED_DOWNLOAD';
                if (!isWaiting) continue;
                if (knownPipelineHashes.has(hash)) continue;

                // If qBittorrent is reachable and this hash is absent from the full snapshot,
                // prune the stale placeholder to avoid ghost rows in queue UI.
                removeJob(waitingJob.id);
                waitingByHash.delete(hash);
                logger.info(`[Queue API] Pruned stale waiting job ${waitingJob.id} (hash ${hash.slice(0, 8)} not found in qBittorrent).`);
            }
        }

        const displayJobs = reconciliationReady ? getAllJobs() : allJobs;

        // 1. Get active downloads from qBittorrent
        const torrents = await TorrentService.getActivePipelineTorrents(
            viewerUser ? { addedByUser: viewerUser } : {}
        );
        for (const torrent of torrents) {
            let displayStatus = 'Downloading';
            if (torrent.progress === 1) displayStatus = 'Finalizing...';
            if (torrent.state.includes('paused') || torrent.state.includes('queued')) displayStatus = 'Queued';

            let torrentOwner =
                TorrentService.extractAddedByUserFromTags(torrent.tags) ||
                await TorrentService.getAddedByUserByHash(torrent.hash) ||
                null;

            if (viewerUser && !torrentOwner) {
                // In user-scoped mode, TorrentService already filtered by user tag.
                torrentOwner = viewerUser;
            }

            const linkedJob = waitingByHash.get(String(torrent.hash || '').toLowerCase()) || null;
            const queueOptions = linkedJob ? getJobQueueOptions(linkedJob) : {
                notifyOnComplete: false,
                addToWatchLaterOnComplete: false
            };

            pipeline.push({
                title: linkedJob ? buildQueueRowTitle(linkedJob, torrent.name) : normalizeDisplayTitle(torrent.name),
                mediaTitle: linkedJob ? buildQueueRowTitle(linkedJob, torrent.name) : normalizeDisplayTitle(torrent.name),
                progress: (torrent.progress * 100).toFixed(1),
                status: displayStatus,
                eta: torrent.eta, 
                size: (torrent.size / (1024 ** 3)).toFixed(2) + ' GB',
                stage: 'downloading',
                addedByUser: torrentOwner,
                torrentHash: torrent.hash,
                state: torrent.state,
                jobId: linkedJob?.id || null,
                queueOptions,
                canPause: Boolean(linkedJob?.id),
                canResume: linkedJob?.status === 'PAUSED_DOWNLOAD',
                canCancel: Boolean(linkedJob?.id)
            });
        }

        // 2. Get active jobs from queue system
        displayJobs.forEach(job => {
            const jobOwner = getJobOwner(job);
            if (viewerUser && (!jobOwner || jobOwner !== viewerUser)) {
                return;
            }

            const queueOptions = getJobQueueOptions(job);

            // Collect failed jobs separately
            if (job.status === 'FAILED') {
                failedJobs.push({
                    title: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                    mediaTitle: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                    status: 'Failed at ' + job.currentStep,
                    error: job.error || 'Unknown error',
                    jobId: job.id,
                    stage: job.currentStep,
                    imdbId: job.imdbId,
                    failedAt: job.updatedAt,
                    addedByUser: jobOwner,
                    queueOptions,
                    canRetry: canManageJob(activeUser, jobOwner)
                });
                return;
            }

            if (job.status === 'PAUSED_DOWNLOAD') {
                const hash = String(job?.payload?.torrentHash || '').trim().toLowerCase();
                if (hash && activePipelineHashes.has(hash)) {
                    return;
                }
                pipeline.push({
                    title: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                    mediaTitle: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                    progress: 0,
                    status: 'Paused in Acquisition Queue',
                    eta: 'Paused',
                    size: 'Awaiting resume',
                    stage: 'downloading',
                    imdbId: job.imdbId,
                    jobId: job.id,
                    addedByUser: jobOwner,
                    queueOptions,
                    canPause: false,
                    canResume: canManageJob(activeUser, jobOwner),
                    canCancel: canManageJob(activeUser, jobOwner)
                });
                return;
            }

            if (job.status === 'PAUSED') {
                pipeline.push({
                    title: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                    mediaTitle: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                    progress: 0,
                    status: 'Paused in Processing Queue',
                    eta: 'Paused',
                    size: 'Awaiting resume',
                    stage: 'queued',
                    imdbId: job.imdbId,
                    jobId: job.id,
                    addedByUser: jobOwner,
                    queueOptions,
                    canPause: false,
                    canResume: canManageJob(activeUser, jobOwner),
                    canCancel: canManageJob(activeUser, jobOwner)
                });
                return;
            }

            // Skip completed jobs from active pipeline display
            if (job.status === 'COMPLETE' || job.currentStep === 'COMPLETE' || job.currentStep === 'COMPLETED') return;

            // Map job step to human-friendly status
            const stepStatusMap = {
                'INGEST': { display: 'Ingesting (Organizing Files)', stage: 'ingest', progress: 15 },
                'METADATA': { display: 'Fetching Metadata & Artwork', stage: 'metadata', progress: 30 },
                'SUBTITLES': { display: 'Finding Subtitles', stage: 'subtitles', progress: 45 },
                'TRANSCODE': { display: 'Optimizing Video', stage: 'transcode', progress: 75 },
                'COMPLETE': { display: 'Finalizing', stage: 'complete', progress: 100 }
            };

            if (job.status === 'WAITING_DOWNLOAD') {
                const hash = String(job?.payload?.torrentHash || '').trim().toLowerCase();
                if (hash && activePipelineHashes.has(hash)) {
                    // qBittorrent row already represents this in-progress download.
                    return;
                }
                pipeline.push({
                    title: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                    mediaTitle: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                    progress: 0,
                    status: 'Waiting For Download Completion',
                    eta: 'Pending...',
                    size: 'Awaiting qBittorrent completion',
                    stage: 'downloading',
                    imdbId: job.imdbId,
                    jobId: job.id,
                    addedByUser: jobOwner,
                    queueOptions,
                    canPause: canManageJob(activeUser, jobOwner),
                    canResume: false,
                    canCancel: canManageJob(activeUser, jobOwner)
                });
                return;
            }

            const stepInfo = stepStatusMap[job.currentStep] || {
                display: 'Processing (' + job.currentStep + ')',
                stage: 'processing',
                progress: 50
            };

            pipeline.push({
                title: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                mediaTitle: buildQueueRowTitle(job, 'Job ' + job.id.substring(0, 8)),
                progress: stepInfo.progress,
                status: stepInfo.display,
                eta: 'Calculating...',
                size: 'In Pipeline',
                stage: stepInfo.stage,
                imdbId: job.imdbId,
                jobId: job.id,
                addedByUser: jobOwner,
                queueOptions,
                canPause: canManageJob(activeUser, jobOwner),
                canResume: false,
                canCancel: canManageJob(activeUser, jobOwner)
            });
        });

        return res.json({
            success: true,
            scope: includeAll ? 'all' : 'user',
            viewer: viewerUser,
            pipeline,
            failures: failedJobs
        });
    } catch (err) {
        logger.error('Pipeline Status Error: ' + err.message);
        return res.status(500).json({ error: "Failed to assemble pipeline matrix state structures." });
    }
});

// PATCH: /api/job/:jobId/options - Save per-job completion options
router.patch('/job/:jobId/options', async (req, res) => {
    try {
        const viewerUser = normalizeUserKey(getActiveUser(req));
        if (!viewerUser || viewerUser === 'guest') {
            return res.status(401).json({ success: false, error: 'Authentication required.' });
        }

        const job = getJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found.' });
        }

        const jobOwner = getJobOwner(job);
        const canAdmin = await hasQueueAdminAccess(viewerUser);
        if (!canAdmin && !canManageJob(viewerUser, jobOwner)) {
            return res.status(403).json({ success: false, error: 'You cannot edit this queue item.' });
        }

        const current = getJobQueueOptions(job);
        const payload = req.body || {};
        const nextOptions = {
            notifyOnComplete: parseBoolean(payload.notifyOnComplete, current.notifyOnComplete),
            addToWatchLaterOnComplete: parseBoolean(payload.addToWatchLaterOnComplete, current.addToWatchLaterOnComplete)
        };

        const updated = updateJob(job, {
            payload: {
                ...job.payload,
                queueOptions: nextOptions
            }
        });

        return res.json({ success: true, jobId: updated.id, queueOptions: nextOptions });
    } catch (err) {
        logger.error('[Queue API] Update options error: ' + err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/job/:jobId/pause - Pause a queued job
router.post('/job/:jobId/pause', async (req, res) => {
    try {
        const viewerUser = normalizeUserKey(getActiveUser(req));
        if (!viewerUser || viewerUser === 'guest') {
            return res.status(401).json({ success: false, error: 'Authentication required.' });
        }

        const job = getJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found.' });
        }

        const jobOwner = getJobOwner(job);
        const canAdmin = await hasQueueAdminAccess(viewerUser);
        if (!canAdmin && !canManageJob(viewerUser, jobOwner)) {
            return res.status(403).json({ success: false, error: 'You cannot pause this queue item.' });
        }

        if (job.status === 'WAITING_DOWNLOAD') {
            const hash = String(job.payload?.torrentHash || '').trim();
            if (!hash) {
                return res.status(400).json({ success: false, error: 'Missing torrent hash for this item.' });
            }

            const paused = await TorrentService.pauseTorrentByHash(hash);
            if (!paused.success) {
                return res.status(502).json({ success: false, error: paused.error || 'Failed to pause torrent.' });
            }

            const updated = updateJob(job, { status: 'PAUSED_DOWNLOAD' });
            return res.json({ success: true, jobId: updated.id, status: updated.status });
        }

        if (job.status === 'QUEUED') {
            const updated = updateJob(job, { status: 'PAUSED' });
            return res.json({ success: true, jobId: updated.id, status: updated.status });
        }

        return res.status(409).json({ success: false, error: `Cannot pause item in status ${job.status}.` });
    } catch (err) {
        logger.error('[Queue API] Pause job error: ' + err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/job/:jobId/resume - Resume a paused job
router.post('/job/:jobId/resume', async (req, res) => {
    try {
        const viewerUser = normalizeUserKey(getActiveUser(req));
        if (!viewerUser || viewerUser === 'guest') {
            return res.status(401).json({ success: false, error: 'Authentication required.' });
        }

        const job = getJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found.' });
        }

        const jobOwner = getJobOwner(job);
        const canAdmin = await hasQueueAdminAccess(viewerUser);
        if (!canAdmin && !canManageJob(viewerUser, jobOwner)) {
            return res.status(403).json({ success: false, error: 'You cannot resume this queue item.' });
        }

        if (job.status === 'PAUSED_DOWNLOAD') {
            const hash = String(job.payload?.torrentHash || '').trim();
            if (!hash) {
                return res.status(400).json({ success: false, error: 'Missing torrent hash for this item.' });
            }

            const resumed = await TorrentService.resumeTorrentByHash(hash);
            if (!resumed.success) {
                return res.status(502).json({ success: false, error: resumed.error || 'Failed to resume torrent.' });
            }

            const updated = updateJob(job, { status: 'WAITING_DOWNLOAD' });
            return res.json({ success: true, jobId: updated.id, status: updated.status });
        }

        if (job.status === 'PAUSED') {
            const updated = updateJob(job, { status: 'QUEUED' });
            return res.json({ success: true, jobId: updated.id, status: updated.status });
        }

        return res.status(409).json({ success: false, error: `Cannot resume item in status ${job.status}.` });
    } catch (err) {
        logger.error('[Queue API] Resume job error: ' + err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/job/:jobId/cancel - Cancel and remove a queue item
router.post('/job/:jobId/cancel', async (req, res) => {
    try {
        const viewerUser = normalizeUserKey(getActiveUser(req));
        if (!viewerUser || viewerUser === 'guest') {
            return res.status(401).json({ success: false, error: 'Authentication required.' });
        }

        const job = getJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found.' });
        }

        const jobOwner = getJobOwner(job);
        const canAdmin = await hasQueueAdminAccess(viewerUser);
        if (!canAdmin && !canManageJob(viewerUser, jobOwner)) {
            return res.status(403).json({ success: false, error: 'You cannot cancel this queue item.' });
        }

        const torrentHash = String(job.payload?.torrentHash || '').trim();
        if (torrentHash) {
            const paused = await TorrentService.pauseTorrentByHash(torrentHash);
            if (!paused.success) {
                logger.warn(`[Queue API] Could not pause torrent prior to cancel for job ${job.id}: ${paused.error}`);
            }
            const removed = await TorrentService.deleteTorrentByHash(torrentHash, { deleteFiles: false });
            if (!removed.success) {
                logger.warn(`[Queue API] Could not remove torrent for job ${job.id}: ${removed.error}`);
            }
        }

        removeJob(job.id);
        return res.json({ success: true, jobId: job.id, status: 'CANCELLED' });
    } catch (err) {
        logger.error('[Queue API] Cancel job error: ' + err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// PATCH: /api/admin/queue/job/:jobId - Admin-only queue item patching for manual fixes
router.patch('/admin/queue/job/:jobId', async (req, res) => {
    try {
        const viewerUser = normalizeUserKey(getActiveUser(req));
        if (!await hasQueueAdminAccess(viewerUser)) {
            return res.status(403).json({ success: false, error: 'Admin queue tools require privileged access.' });
        }

        const job = getJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found.' });
        }

        const body = req.body || {};
        const nextPayload = { ...(job.payload || {}) };
        const nextQueueContext = { ...(nextPayload.queueContext || {}) };

        if (body.title !== undefined) {
            const cleanTitle = String(body.title || '').trim();
            if (cleanTitle) {
                nextPayload.torrentName = cleanTitle;
            }
        }

        if (body.imdbId !== undefined) {
            const cleanImdb = normalizeImdbId(body.imdbId);
            nextPayload.imdbId = cleanImdb || null;
            nextQueueContext.imdbId = cleanImdb || null;
        }

        if (body.torrentHash !== undefined) {
            const cleanHash = String(body.torrentHash || '').trim().toLowerCase();
            nextPayload.torrentHash = cleanHash || null;
        }

        if (body.addedByUser !== undefined) {
            const cleanOwner = normalizeUserKey(body.addedByUser);
            nextPayload.addedByUser = cleanOwner || null;
            nextQueueContext.addedByUser = cleanOwner || null;
        }

        const validStatus = new Set(['WAITING_DOWNLOAD', 'QUEUED', 'PAUSED', 'PAUSED_DOWNLOAD', 'FAILED', 'COMPLETE']);
        const validSteps = new Set(['INGEST', 'METADATA', 'SUBTITLES', 'TRANSCODE', 'CLOUDSYNC', 'COMPLETE', 'FAILED']);

        const nextStatus = body.status !== undefined
            ? String(body.status || '').trim().toUpperCase()
            : job.status;
        const nextStep = body.currentStep !== undefined
            ? String(body.currentStep || '').trim().toUpperCase()
            : job.currentStep;

        if (!validStatus.has(String(nextStatus || '').toUpperCase())) {
            return res.status(400).json({ success: false, error: `Invalid status: ${nextStatus}` });
        }
        if (!validSteps.has(String(nextStep || '').toUpperCase())) {
            return res.status(400).json({ success: false, error: `Invalid currentStep: ${nextStep}` });
        }

        if (body.queueOptions && typeof body.queueOptions === 'object') {
            nextPayload.queueOptions = {
                notifyOnComplete: parseBoolean(body.queueOptions.notifyOnComplete, false),
                addToWatchLaterOnComplete: parseBoolean(body.queueOptions.addToWatchLaterOnComplete, false)
            };
        }

        nextPayload.queueContext = nextQueueContext;
        const updated = updateJob(job, {
            status: nextStatus,
            currentStep: nextStep,
            error: body.error !== undefined ? String(body.error || '').trim() || null : job.error,
            imdbId: nextPayload.imdbId || job.imdbId || null,
            payload: nextPayload,
            history: [
                ...(job.history || []),
                { step: 'ADMIN_PATCH', timestamp: new Date().toISOString() }
            ]
        });

        return res.json({ success: true, job: updated });
    } catch (err) {
        logger.error('[Queue API] Admin patch job error: ' + err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

async function enqueueAlternateSourceReplacement(req, res, { requireAdmin = false } = {}) {
    const viewerUser = normalizeUserKey(getActiveUser(req));
    const job = getJob(req.params.jobId);

    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found.' });
    }

    const jobOwner = getJobOwner(job);
    if (requireAdmin && !await hasQueueAdminAccess(viewerUser)) {
        return res.status(403).json({ success: false, error: 'Admin queue tools require privileged access.' });
    }
    if (!canManageJob(viewerUser, jobOwner)) {
        return res.status(403).json({ success: false, error: 'You do not have access to replace this queue item.' });
    }

    const magnetUrl = String(req.body?.magnetUrl || '').trim();
    if (!magnetUrl) {
        return res.status(400).json({ success: false, error: 'Missing magnetUrl.' });
    }

    let parsedMagnet;
    try {
        parsedMagnet = new URL(magnetUrl);
    } catch (_err) {
        return res.status(400).json({ success: false, error: 'Invalid magnet URL.' });
    }

    const contentType = String(req.body?.contentType || job.contentType || 'movie').toLowerCase() === 'series' ? 'series' : 'movie';
    const category = contentType === 'series' ? 'series-streamer' : 'movie-streamer';
    const replacementImdbId = normalizeImdbId(req.body?.imdbId || job.imdbId || job.payload?.imdbId || job.payload?.queueContext?.imdbId);
    const owner = normalizeUserKey(req.body?.addedByUser || jobOwner || job.payload?.addedByUser || viewerUser);
    const replaceExisting = parseBoolean(req.body?.replaceExisting, false);

    await TorrentService.addMagnet(magnetUrl, category, replacementImdbId, {
        addedByUser: owner || viewerUser || null
    });

    const torrentName = parsedMagnet.searchParams.get('dn') || job.payload?.torrentName || 'Alternate source';
    const infoHash = (() => {
        const xt = parsedMagnet.searchParams.get('xt') || '';
        return xt.includes('btih:') ? xt.split('btih:')[1].trim().toLowerCase() : null;
    })();

    const derivedQueueContext = {
        ...(job.payload?.queueContext || {}),
        imdbId: replacementImdbId || null,
        addedByUser: owner || null
    };

    const replacementJob = createJob({
        status: 'WAITING_DOWNLOAD',
        currentStep: 'INGEST',
        imdbId: replacementImdbId || null,
        contentType,
        title: buildQueueMediaTitle({
            title: job.title || job.payload?.torrentName || 'Replacement source',
            imdbId: replacementImdbId || null,
            contentType,
            payload: {
                ...(job.payload || {}),
                queueContext: derivedQueueContext,
                mediaTitle: job.payload?.mediaTitle || job.title || job.payload?.torrentName || 'Replacement source'
            }
        }),
        payload: {
            torrentHash: infoHash,
            torrentName,
            rawPath: null,
            cleanPath: null,
            videoFile: null,
            magnetUrl,
            imdbId: replacementImdbId || null,
            mediaTitle: buildQueueMediaTitle({
                title: job.title || job.payload?.torrentName || 'Replacement source',
                imdbId: replacementImdbId || null,
                contentType,
                payload: {
                    ...(job.payload || {}),
                    queueContext: derivedQueueContext,
                    mediaTitle: job.payload?.mediaTitle || job.title || job.payload?.torrentName || 'Replacement source'
                }
            }),
            addedByUser: owner || null,
            queueContext: derivedQueueContext,
            queueOptions: {
                ...getJobQueueOptions(job)
            }
        }
    });

    if (replaceExisting) {
        const hash = String(job.payload?.torrentHash || '').trim();
        if (hash) {
            const paused = await TorrentService.pauseTorrentByHash(hash);
            if (!paused.success) {
                logger.warn(`[Queue API] Could not pause old torrent during alternate source swap for ${job.id}: ${paused.error}`);
            }
            const removed = await TorrentService.deleteTorrentByHash(hash, { deleteFiles: false });
            if (!removed.success) {
                logger.warn(`[Queue API] Could not remove old torrent during alternate source swap for ${job.id}: ${removed.error}`);
            }
        }
        removeJob(job.id);
    } else {
        updateJob(job, {
            history: [
                ...(job.history || []),
                { step: 'ALT_SOURCE_ADDED', timestamp: new Date().toISOString() }
            ]
        });
    }

    return res.json({
        success: true,
        message: replaceExisting
            ? 'Alternate source queued and original item replaced.'
            : 'Alternate source queued alongside current item.',
        replacementJob
    });
}

// POST: /api/admin/queue/job/:jobId/alternate-source - admin-capable alternate source replacement
router.post('/admin/queue/job/:jobId/alternate-source', async (req, res) => {
    try {
        return await enqueueAlternateSourceReplacement(req, res, { requireAdmin: false });
    } catch (err) {
        logger.error('[Queue API] Alternate source enqueue error: ' + err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/job/:jobId/alternate-source - job-owner friendly replacement path
router.post('/job/:jobId/alternate-source', async (req, res) => {
    try {
        return await enqueueAlternateSourceReplacement(req, res, { requireAdmin: false });
    } catch (err) {
        logger.error('[Queue API] Alternate source route error: ' + err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/job/:jobId - Get detailed job information
router.get('/job/:jobId', async (req, res) => {
    try {
        const job = getJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        return res.json({ success: true, job });
    } catch (err) {
        logger.error('Get job error: ' + err.message);
        return res.status(500).json({ error: err.message });
    }
});

// GET: /api/jobs/failed - Get all failed jobs
router.get('/jobs/failed', async (req, res) => {
    try {
        const failed = getFailedJobs();
        logger.debug(`[Queue API] Failed jobs requested. Count=${failed.length}`);
        return res.json({ 
            success: true, 
            count: failed.length,
            jobs: failed.map(job => ({
                jobId: job.id,
                title: (job.payload && job.payload.torrentName) ? job.payload.torrentName : 'Unknown',
                stage: job.currentStep,
                error: job.error,
                failedAt: job.updatedAt,
                imdbId: job.imdbId,
                contentType: job.contentType
            }))
        });
    } catch (err) {
        logger.error('Get failed jobs error: ' + err.message);
        return res.status(500).json({ error: err.message });
    }
});

// POST: /api/job/:jobId/retry - Retry a failed job
router.post('/job/:jobId/retry', async (req, res) => {
    try {
        logger.debug(`[Queue API] Retry request received for jobId=${req.params.jobId}`);
        const job = getJob(req.params.jobId);
        if (!job) {
            logger.warn(`[Queue API] Retry failed. Job not found: ${req.params.jobId}`);
            return res.status(404).json({ error: 'Job not found' });
        }
        
        if (job.status !== 'FAILED') {
            logger.warn(`[Queue API] Retry rejected. Job ${job.id} status is ${job.status}, not FAILED.`);
            return res.status(400).json({ error: 'Only failed jobs can be retried' });
        }

        const retryStep = inferRetryStep(job);
        const fallbackImdbId = normalizeImdbId(
            job.imdbId ||
            job.payload?.imdbId ||
            job.payload?.queueContext?.imdbId
        ) || null;

        // Reset job to QUEUED state at the last actionable step.
        const retried = updateJob(job, {
            status: 'QUEUED',
            currentStep: retryStep,
            imdbId: fallbackImdbId,
            payload: {
                ...job.payload,
                imdbId: fallbackImdbId,
                queueContext: {
                    ...(job.payload?.queueContext || {}),
                    imdbId: fallbackImdbId || job.payload?.queueContext?.imdbId || null
                }
            },
            error: null,
            history: [
                ...(job.history || []),
                { step: `RETRY:${retryStep}`, timestamp: new Date().toISOString() }
            ]
        });

        logger.info(`🔄 [Queue] Job ${job.id} retrying from step ${retryStep} (imdbId=${fallbackImdbId || 'unknown'})`);
        return res.json({ success: true, message: 'Job queued for retry', job: retried });
    } catch (err) {
        logger.error('[Queue API] Retry job error: ' + err.message);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;