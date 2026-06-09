console.log("!!! SERVER IS CURRENTLY INITIALIZING !!!");

const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;

const MOVIES_DIR = path.join(__dirname, 'movies');

if (!fs.existsSync(MOVIES_DIR)) {
    fs.mkdirSync(MOVIES_DIR, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/movie-assets', express.static(MOVIES_DIR));

// Scan directories safely
app.get('/api/movies', (req, res) => {
    try {
        const folders = fs.readdirSync(MOVIES_DIR);
        const movies = folders.map(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);
            
            if (folder.startsWith('.') || !fs.lstatSync(folderPath).isDirectory()) {
                return null;
            }

            const files = fs.readdirSync(folderPath);
            const videoFile = files.find(f => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.m4v'));
            
            if (!videoFile) return null;

            return {
                id: encodeURIComponent(folder),
                title: folder.replace(/[-_]/g, ' '),
                cover: `/movie-assets/${encodeURIComponent(folder)}/cover.jpg`
            };
        }).filter(Boolean);

        res.json(movies);
    } catch (err) {
        console.error("Directory read error:", err);
        res.status(500).json({ error: "Failed to read library" });
    }
});

// =========================================================================
// HIGH-PERFORMANCE PROGRESSIVE HTTP RANGE STREAM ENGINE
// =========================================================================
app.get('/stream/:id/:resolution.m3u8', (req, res) => {
    try {
        const movieId = decodeURIComponent(req.params.id);
        
        const folderPath = path.join(MOVIES_DIR, movieId);
        if (!fs.existsSync(folderPath)) {
            return res.status(404).send('Movie folder not found.');
        }

        const files = fs.readdirSync(folderPath);
        const videoFile = files.find(f => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.m4v'));

        if (!videoFile) {
            return res.status(404).send('Video asset missing.');
        }

        const fullVideoPath = path.join(folderPath, videoFile);
        const stat = fs.statSync(fullVideoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        // Base CORS and streaming headers required for native HTML5 players
        const baseHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Accept-Ranges': 'bytes',
        };

        // Handle preflight OPTIONS requests gracefully
        if (req.method === 'OPTIONS') {
            res.writeHead(204, baseHeaders);
            return res.end();
        }

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            
            console.log(`📥 Byte Range Request: ${start}-${end} / ${fileSize}`);

            const file = fs.createReadStream(fullVideoPath, { start, end });
            const responseHeaders = {
                ...baseHeaders,
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            };

            res.writeHead(206, responseHeaders); // 206 Partial Content
            file.pipe(res);
        } else {
            console.log(`🎬 Initial progressive stream delivery for: [${movieId}]`);
            const responseHeaders = {
                ...baseHeaders,
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
            };
            res.writeHead(200, responseHeaders);
            fs.createReadStream(fullVideoPath).pipe(res);
        }

    } catch (err) {
        console.error("💣 Stream engine failure:", err);
        if (!res.headersSent) {
            res.status(500).send('Internal streaming loop fault.');
        }
    }
});

// =========================================================================
// LIGHTWEIGHT DIRECT STATIC STREAM ENGINE (FOR WEB-OPTIMIZED MP4s)
// =========================================================================
app.get('/api/raw-file/:id', (req, res) => {
    try {
        const movieId = decodeURIComponent(req.params.id);
        const folderPath = path.join(MOVIES_DIR, movieId);

        if (!fs.existsSync(folderPath)) {
            return res.status(404).send('Movie asset folder directory not found.');
        }

        const files = fs.readdirSync(folderPath);
        
        // 1. Prioritize the freshly minted .web.mp4 files, fallback to normal mp4/mkv
        let videoFile = files.find(f => f.endsWith('.web.mp4'));
        if (!videoFile) {
            videoFile = files.find(f => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.m4v'));
        }

        if (!videoFile) {
            return res.status(404).send('No playable video format container found.');
        }

        const fullVideoPath = path.join(folderPath, videoFile);
        const stat = fs.statSync(fullVideoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        // Essential CORS and baseline video payload streaming headers
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4'
        };

        // Handle preflight cross-origin options check
        if (req.method === 'OPTIONS') {
            res.writeHead(204, headers);
            return res.end();
        }

        // 2. Handle standard HTML5 progressive chunking (Byte-Range Requests)
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            console.log(`🚀 Direct Stream Range: ${start}-${end} / ${fileSize} | File: ${videoFile}`);

            const file = fs.createReadStream(fullVideoPath, { start, end });
            
            res.writeHead(206, {
                ...headers,
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunksize,
            });
            file.pipe(res);
        } else {
            // Fallback for initial connection if browser asks for the whole bundle at once
            console.log(`🎬 Direct Stream Initialized: Full pipe delivery for ${videoFile}`);
            res.writeHead(200, {
                ...headers,
                'Content-Length': fileSize,
            });
            fs.createReadStream(fullVideoPath).pipe(res);
        }

    } catch (err) {
        console.error("💣 Direct stream controller fault:", err);
        if (!res.headersSent) {
            res.status(500).send('Internal static streaming pipeline error.');
        }
    }
});

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 MOVIE STREAMER ENGINE IS NOW LIVE`);
    console.log(`🔊 Listening on internal port: ${PORT}`);
    console.log(`📂 Scanning library at: ${MOVIES_DIR}`);
    console.log(`==================================================\n`);
});