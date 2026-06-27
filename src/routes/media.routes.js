// src/routes/media.routes.js
// Media catalog discovery, paginated queries, subtitle streams, and B2 presigned asset routers.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const { getLibrary } = require('../services/db');

const MediaService = require('../services/MediaService');
const MOVIES_DIR = process.env.MOVIES_DIR || (fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies');
// 🚨 NEW FIX: Isolated pathway pointing to the new separate SSD mount for TV shows
const SERIES_DIR = process.env.SERIES_DIR || '/data/blockchain/media/Series';

// =========================================================================
// ENDPOINTS
// =========================================================================

// GET: /api/library (Serves the entire dashboard instantly out of memory)
router.get('/library', async (req, res) => {
    try {
        const library = await getLibrary();
        return res.json({ success: true, library });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/movies (High-Performance Paginated Catalog Discovery utilizing Redis lookups)
router.get('/movies', async (req, res) => {
    try {
        // Now pulls safely from the hot cache layer database instead of the broken global array
        const library = await getLibrary();
        const cachedMovies = library.movies || [];

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 24; 
        
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;

        const paginatedMovies = cachedMovies.slice(startIndex, endIndex);

        res.json({
            totalMovies: cachedMovies.length,
            totalPages: Math.ceil(cachedMovies.length / limit),
            currentPage: page,
            movies: paginatedMovies
        });
    } catch (err) {
        console.error("❌ Paginated library presentation routing fault:", err);
        res.status(500).json({ success: false, error: "Failed to assemble structured movie matrix blocks." });
    }
});

// GET: /api/movies/:id (Individual Stream Quality Switcher Profile Router)
router.get('/movies/:id', async (req, res) => {
    const movieId = req.params.id;
    const movieFolder = path.join(MOVIES_DIR, movieId);
    const infoFilePath = path.join(movieFolder, 'movie_info.json');
    const metaFilePath = path.join(movieFolder, 'metadata.json'); 

    let streamPayload = {
        id: movieId,
        title: movieId.replace(/\./g, ' '), 
        file1080p: null,
        file720p: null,
        file480p: null
    };

    // Unpack local details if configured inside the storage path
    try {
        const rawData = await fsPromises.readFile(infoFilePath, 'utf8');
        const meta = JSON.parse(rawData);
        streamPayload.title = meta.title || streamPayload.title;
    } catch (e) {
        // Silent block bypass for clean fallback names
    }

    // 🚨 CLOUD TRACKING CHECK: Check if the file lives in object storage before running local fs checks
    try {
        if (fs.existsSync(metaFilePath)) {
            const rawMeta = await fsPromises.readFile(metaFilePath, 'utf-8');
            const metaData = JSON.parse(rawMeta);
            
            if (metaData?.storage?.location === 'remote') {
                streamPayload.title = metaData.title || streamPayload.title;
                streamPayload.file1080p = await MediaService.getPlaybackUrl(metaData, '1080p', null);
                streamPayload.file720p = await MediaService.getPlaybackUrl(metaData, '720p', null);
                streamPayload.file480p = await MediaService.getPlaybackUrl(metaData, '480p', null);
                return res.json(streamPayload); // Exit completely so it doesn't fail on missing local files
            }
        }
    } catch (err) {
        // Fail over quietly to evaluate standard disk lookups
    }

    // Standard Local File Checking Core
    try {
        await fsPromises.access(movieFolder);
    } catch {
        return res.status(404).json({ status: 'error', message: 'Movie cluster destination missing.' });
    }

    const expectedOutputs = {
        '1080p': `${movieId}.web.mp4`,      
        '720p': `${movieId}.720p.mp4`,      
        '480p': `${movieId}.480p.mp4`       
    };

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['1080p']));
        streamPayload.file1080p = `/movie-assets/${movieId}/${expectedOutputs['1080p']}`;
    } catch {
        try {
            const files = await fsPromises.readdir(movieFolder);
            const sourceMp4 = files.find(f => f.endsWith('.mp4') && !f.includes('720p') && !f.includes('480p'));
            if (sourceMp4) streamPayload.file1080p = `/movie-assets/${movieId}/${sourceMp4}`;
        } catch {}
    }

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['720p']));
        streamPayload.file720p = `/movie-assets/${movieId}/${expectedOutputs['720p']}`;
    } catch {}

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['480p']));
        streamPayload.file480p = `/movie-assets/${movieId}/${expectedOutputs['480p']}`;
    } catch {}

    if (!streamPayload.file1080p) {
        streamPayload.file1080p = `/movie-assets/${movieId}`;
    }

    res.json(streamPayload);
});

// GET: /api/series/:showFolder (Unified Series Hierarchy Aggregator)
router.get('/series/:showFolder', async (req, res) => {
    try {
        const showFolder = decodeURIComponent(req.params.showFolder);
        // 🚨 FIX: Updated to find directories inside the new separate SERIES_DIR path
        const showPath = path.join(SERIES_DIR, showFolder);

        const metaFile = path.join(showPath, 'metadata.json');
        const seriesFile = path.join(showPath, 'series.json');

        try {
            await Promise.all([fsPromises.access(metaFile), fsPromises.access(seriesFile)]);
        } catch {
            return res.status(404).json({ error: "Serialized map targets are currently missing for this show cluster destination." });
        }

        const [rawMeta, rawSeries] = await Promise.all([
            fsPromises.readFile(metaFile, 'utf-8'),
            fsPromises.readFile(seriesFile, 'utf-8')
        ]);

        const metaData = JSON.parse(rawMeta);
        const seriesData = JSON.parse(rawSeries);

        res.json({
            id: `series/${showFolder}`,
            title: metaData.title,
            year: metaData.year,
            plot: metaData.plot,
            genre: metaData.genre,
            poster: `/movie-assets/series/${encodeURIComponent(showFolder)}/cover.jpg`,
            seasons: seriesData.seasons,
            totalSeasons: seriesData.totalSeasons
        });
    } catch (err) {
        console.error("❌ Unified Series router failure:", err);
        res.status(500).json({ error: "Failed assembling compiled local series data arrays." });
    }
});

// GET: /api/raw-file/:id (Lightweight Video Ranger Seek Pipeline)
router.get('/raw-file/:id', async (req, res) => {
    try {
        const movieId = decodeURIComponent(req.params.id);
        const folderPath = path.join(MOVIES_DIR, movieId);

        try {
            await fsPromises.access(folderPath);
        } catch {
            return res.status(404).send('Movie asset folder directory not found.');
        }

        const files = await fsPromises.readdir(folderPath);
        let videoFile = files.find(f => f.endsWith('.web.mp4')) || files.find(f => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.m4v'));

        if (!videoFile) {
            return res.status(404).send('No playable video format container found.');
        }

        const fullVideoPath = path.join(folderPath, videoFile);
        const stat = await fsPromises.stat(fullVideoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4'
        };

        if (req.method === 'OPTIONS') {
            return res.writeHead(204, headers).end();
        }

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                ...headers,
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunksize,
            });
            fs.createReadStream(fullVideoPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { ...headers, 'Content-Length': fileSize });
            fs.createReadStream(fullVideoPath).pipe(res);
        }
    } catch (err) {
        console.error("💣 Direct stream controller fault:", err);
        if (!res.headersSent) res.status(500).send('Internal static streaming pipeline error.');
    }
});

// GET: /api/subtitles/:id (Dynamic SRT-to-WebVTT Structural Sanitizer Engine)
router.get('/subtitles/:id', async (req, res) => {
    try {
        const movieId = decodeURIComponent(req.params.id);
        const folderPath = path.join(MOVIES_DIR, movieId);

        try {
            await fsPromises.access(folderPath);
        } catch {
            return res.status(404).send('Movie folder not found.');
        }

        const files = await fsPromises.readdir(folderPath);
        const srtFile = files.find(f => f.endsWith('.srt'));

        if (!srtFile) {
            return res.status(404).send('No subtitles found.');
        }

        const srtContent = await fsPromises.readFile(path.join(folderPath, srtFile), 'utf-8');

        let vttContent = "WEBVTT\n\n" + srtContent
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

        res.setHeader('Content-Type', 'text/vtt');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).send(vttContent);
    } catch (err) {
        console.error("💣 Subtitle engine failure:", err);
        res.status(500).send('Error processing subtitle asset.');
    }
});

module.exports = router;