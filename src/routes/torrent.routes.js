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

const MOVIES_DIR = process.env.MOVIES_DIR || (fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies');

// =========================================================================
// 🔍 MEDIA INDEXER & SEARCH PROXIES
// =========================================================================

// GET: /api/torrent/yts/browse
router.get('/yts/browse', async (req, res) => {
    try {
        const { query_term, page, genre, minimum_rating, sort_by } = req.query;
        const ytsUrl = `https://movies-api.accel.li/api/v2/list_movies.json`;
        
        const apiParams = {
            page: parseInt(page, 10) || 1,
            limit: 24,
            order_by: 'desc'
        };

        if (query_term && query_term.trim() !== '' && query_term !== '0') apiParams.query_term = query_term.trim();
        if (genre && genre.toLowerCase() !== 'all') apiParams.genre = genre.toLowerCase();
        if (minimum_rating && minimum_rating !== '0') apiParams.minimum_rating = minimum_rating;
        apiParams.sort_by = sort_by || 'date_added';

        const response = await axios.get(ytsUrl, { params: apiParams });
        res.json(response.data);
    } catch (err) {
        logger.log(`❌ YTS proxy route failure: ${err.message}`, 'error');
        res.status(500).json({ error: "Failed to fetch media data source indices." });
    }
});

// GET: /api/torrent/eztv/browse
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

        res.json({ success: true, torrents: results });
    } catch (err) {
        logger.log(`EZTV proxy route failure: ${err.message}`, 'error');
        res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// 📥 QB_TORRENT DOWN-PIPE INGESTION INTERFACES
// =========================================================================


// REPLACE OLD POST '/downloader/add' WITH THIS:
router.post('/downloader/add', async (req, res) => {
    const { magnetUrl, category } = req.body; 

    if (!magnetUrl) {
        return res.status(400).json({ error: "Missing target magnet payload." });
    }

    try {
        await TorrentService.addMagnet(magnetUrl, category);
        res.status(200).json({ success: true, message: "Queued layout allocation pipeline records." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST: /api/torrent/yts/add (Legacy structural alias mapping route)
router.post('/yts/add', async (req, res) => {
    const { magnetUrl } = req.body;
    if (!magnetUrl) return res.status(400).json({ error: "Missing target magnet payload." });

    req.body.category = 'movie';
    return router.handle(req, res); 
});

// =========================================================================
// 📊 TELEMETRY & WORKFLOW DATA MONITOR
// =========================================================================

// GET: /api/torrent/pipeline/status
router.get('/pipeline/status', async (req, res) => {
    try {
        let pipeline = [];

        // 1. Offload active downloads calculation step straight to the service agent
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
                size: (torrent.size / (1024 ** 3)).toFixed(2) + ' GB'
            });
        });

        // 2. Scan processing directory locks
        try {
            await fsPromises.access(MOVIES_DIR);
            const folders = await fsPromises.readdir(MOVIES_DIR);
            
            await Promise.all(folders.map(async (folder) => {
                const folderPath = path.join(MOVIES_DIR, folder);
                try {
                    const stat = await fsPromises.lstat(folderPath);
                    if (stat.isDirectory()) {
                        await fsPromises.access(path.join(folderPath, '.processing'));
                        pipeline.push({
                            title: folder.replace(/[._-]/g, ' '),
                            progress: 'N/A',
                            status: 'Pre-Transcoding (Optimizing)',
                            eta: 'Calculating...',
                            size: 'Processing Video Stream...'
                        });
                    }
                } catch {}
            }));
        } catch (fsErr) {}

        res.json({ success: true, pipeline });
    } catch (err) {
        res.status(500).json({ error: "Failed to assemble pipeline matrix state structures." });
    }
});

module.exports = router;