// src/routes/torrent.routes.js
// YTS/EZTV directory lookup proxies, qBittorrent service links, and telemetry pipes.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');

const logger = require('../services/logger');
const TorrentService = require('../services/TorrentService');
const { 
    createJob, 
    getAllJobs, 
    getFailedJobs, 
    getJob,
    updateJob
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

function parseSeasonEpisodeFromTitle(title) {
    const raw = String(title || '');
    const sxe = raw.match(/s(\d{1,2})\s*e(\d{1,2})/i);
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

    return {
        imdbId: incoming.imdbId || null,
        season,
        episode,
        sourceType: normalizedSourceType
    };
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
                targetImdbId = match.imdbID.replace('tt', ''); 
                const detailRes = await axios.get(`http://www.omdbapi.com/?apikey=84196d01&i=${match.imdbID}`);
                omdbMeta = detailRes.data;
            } else {
                targetImdbId = queryTerm.startsWith('tt') ? queryTerm.replace('tt', '') : '';
            }
        }

        if (!targetImdbId) return res.json({ success: true, torrents: [] });

        const eztvFetch = await fetchEztvPages(targetImdbId, 5);
        const allTorrents = eztvFetch.torrents;

        const posterUrl = typeof omdbMeta?.Poster === 'string' ? omdbMeta.Poster.trim() : '';
        const cover = posterUrl && posterUrl !== 'N/A' ? posterUrl : FALLBACK_COVER_DATA_URI;
        const reduced = consolidated
            ? simplifyEztvTorrents(allTorrents, targetImdbId, cover, packsOnly)
            : mapRawEztvRows(allTorrents, targetImdbId, cover, packsOnly);

        logger.debug(`[EZTV] imdb=${targetImdbId} packsOnly=${packsOnly} consolidated=${consolidated} raw=${allTorrents.length} out=${reduced.items.length} packRows=${reduced.packRows || 0} episodeRows=${reduced.episodeRows || 0}`);

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
        const targetCategory = category || 'series-streamer';
        const normalizedQueueContext = normalizeQueueContext(queueContext, magnetUrl);
        await TorrentService.addMagnet(magnetUrl, targetCategory, imdbId);
        
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

        createJob({
            status: 'WAITING_DOWNLOAD',
            currentStep: 'INGEST',
            imdbId: imdbId || null,
            contentType: targetCategory === 'series-streamer' ? 'series' : 'movie',
            payload: {
                torrentHash: infoHash,
                torrentName,
                rawPath: null,
                cleanPath: null,
                videoFile: null,
                magnetUrl,
                imdbId: imdbId || null,
                queueContext: normalizedQueueContext
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
        const normalizedQueueContext = normalizeQueueContext(queueContext, magnetUrl);
        await TorrentService.addMagnet(magnetUrl, 'movie-streamer', imdbId);
        
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

        createJob({
            status: 'WAITING_DOWNLOAD',
            currentStep: 'INGEST',
            imdbId: imdbId || null,
            contentType: 'movie',
            payload: {
                torrentHash: infoHash,
                torrentName,
                rawPath: null,
                cleanPath: null,
                videoFile: null,
                magnetUrl,
                imdbId: imdbId || null,
                queueContext: normalizedQueueContext
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
        let pipeline = [];
        let failedJobs = [];

        // 1. Get active downloads from qBittorrent
        const torrents = await TorrentService.getActivePipelineTorrents();
        torrents.forEach(torrent => {
            let displayStatus = 'Downloading';
            if (torrent.progress === 1) displayStatus = 'Finalizing...';
            if (torrent.state.includes('paused') || torrent.state.includes('queued')) displayStatus = 'Queued';

            pipeline.push({
                title: torrent.name.replace(/[._-]/g, ' '),
                progress: (torrent.progress * 100).toFixed(1),
                status: displayStatus,
                eta: torrent.eta, 
                size: (torrent.size / (1024 ** 3)).toFixed(2) + ' GB',
                stage: 'downloading'
            });
        });

        // 2. Get active jobs from queue system
        const allJobs = getAllJobs();
        allJobs.forEach(job => {
            // Collect failed jobs separately
            if (job.status === 'FAILED') {
                failedJobs.push({
                    title: (job.payload && job.payload.torrentName) ? job.payload.torrentName.replace(/[._-]/g, ' ') : 'Job ' + job.id.substring(0, 8),
                    status: 'Failed at ' + job.currentStep,
                    error: job.error || 'Unknown error',
                    jobId: job.id,
                    stage: job.currentStep,
                    imdbId: job.imdbId,
                    failedAt: job.updatedAt
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
                pipeline.push({
                    title: (job.payload && job.payload.torrentName) ? job.payload.torrentName.replace(/[._-]/g, ' ') : 'Job ' + job.id.substring(0, 8),
                    progress: 0,
                    status: 'Waiting For Download Completion',
                    eta: 'Pending...',
                    size: 'Awaiting qBittorrent completion',
                    stage: 'downloading',
                    imdbId: job.imdbId,
                    jobId: job.id
                });
                return;
            }

            const stepInfo = stepStatusMap[job.currentStep] || {
                display: 'Processing (' + job.currentStep + ')',
                stage: 'processing',
                progress: 50
            };

            pipeline.push({
                title: (job.payload && job.payload.torrentName) ? job.payload.torrentName.replace(/[._-]/g, ' ') : 'Job ' + job.id.substring(0, 8),
                progress: stepInfo.progress,
                status: stepInfo.display,
                eta: 'Calculating...',
                size: 'In Pipeline',
                stage: stepInfo.stage,
                imdbId: job.imdbId,
                jobId: job.id
            });
        });

        return res.json({ success: true, pipeline, failures: failedJobs });
    } catch (err) {
        logger.error('Pipeline Status Error: ' + err.message);
        return res.status(500).json({ error: "Failed to assemble pipeline matrix state structures." });
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

        // Reset job to QUEUED state at the failed step
        const retried = updateJob(job, {
            status: 'QUEUED',
            error: null,
            history: [
                ...(job.history || []),
                { step: 'RETRY', timestamp: new Date().toISOString() }
            ]
        });

        logger.info(`🔄 [Queue] Job ${job.id} retrying from step ${job.currentStep}`);
        return res.json({ success: true, message: 'Job queued for retry', job: retried });
    } catch (err) {
        logger.error('[Queue API] Retry job error: ' + err.message);
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;