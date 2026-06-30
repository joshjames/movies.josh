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
        const packsOnly = req.query.packsOnly === 'true';
        let targetImdbId = '';
        let omdbMeta = null;

        if (!queryTerm) return res.json({ success: true, torrents: [] });

        const omdbRes = await axios.get(`http://www.omdbapi.com/?apikey=84196d01&s=${encodeURIComponent(queryTerm)}&type=series`);
        
        if (omdbRes.data?.Search?.length > 0) {
            const match = omdbRes.data.Search[0];
            targetImdbId = match.imdbID.replace('tt', ''); 
            const detailRes = await axios.get(`http://www.omdbapi.com/?apikey=84196d01&i=${match.imdbID}`);
            omdbMeta = detailRes.data;
        } else {
            targetImdbId = queryTerm.startsWith('tt') ? queryTerm.replace('tt', '') : '';
        }

        if (!targetImdbId) return res.json({ success: true, torrents: [] });

        let allTorrents = [];
        let currentPage = 1;
        let keepScanning = true;

        while (keepScanning && currentPage <= 5) { 
            const eztvRes = await axios.get(`https://eztv.wf/api/get-torrents?imdb_id=${targetImdbId}&limit=100&page=${currentPage}`, { timeout: 5000 });
            if (eztvRes.data?.torrents?.length > 0) {
                allTorrents = allTorrents.concat(eztvRes.data.torrents);
                if (eztvRes.data.torrents.length < 100) keepScanning = false;
                else currentPage++;
            } else {
                keepScanning = false;
            }
        }

        if (packsOnly) {
            const packRegex = /(season\s*pack|complete|s\d{2}\s*complete|seasons?\s*\d+\s*-\s*\d+|t[-_.]?pack|\[pack\])/i;
            allTorrents = allTorrents.filter(t => packRegex.test(t.title));
        }

        const results = allTorrents.map(t => ({
            title: t.title,
            size: t.size_bytes ? (parseFloat(t.size_bytes) / (1024 ** 3)).toFixed(2) + ' GB' : 'N/A',
            seeds: parseInt(t.seeds, 10) || 0,
            peers: parseInt(t.peers, 10) || 0,
            magnet: t.magnet_url || `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.title)}`,
            cover: omdbMeta?.Poster !== "N/A" ? omdbMeta.Poster : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="100%" height="100%" fill="%23020617"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23475569">No Cover</text></svg>'
        }));

        return res.json({ success: true, torrents: results });
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
    const { magnetUrl, category, imdbId } = req.body; 

    if (!magnetUrl) {
        return res.status(400).json({ error: "Missing target magnet payload." });
    }

    try {
        const targetCategory = category || 'series-streamer';
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
                imdbId: imdbId || null
            }
        });
        
        return res.status(200).json({ success: true, message: "Queued layout allocation pipeline records." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// POST: /api/yts/add (Legacy alias layout router mapping)
router.post('/yts/add', async (req, res) => {
    const { magnetUrl, imdbId } = req.body;
    if (!magnetUrl) return res.status(400).json({ error: "Missing target magnet payload." });

    try {
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
                imdbId: imdbId || null
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
            if (job.status === 'COMPLETE') return;

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