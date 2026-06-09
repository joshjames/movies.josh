console.log("!!! SERVER IS CURRENTLY INITIALIZING !!!");

const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;
const { exec } = require('child_process');
const MOVIES_DIR = path.join(__dirname, 'movies');
const axios = require('axios');
const FormData = require('form-data'); // Ensure you have form-data installed (npm install form-data)

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

            // Load local metadata if present
            const metaFile = path.join(folderPath, 'metadata.json');
            let metaData = { title: folder.replace(/[-_]/g, ' '), year: '', plot: '', genre: '' };
            
            if (fs.existsSync(metaFile)) {
                metaData = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
            }

            return {
                id: encodeURIComponent(folder),
                title: metaData.title,
                year: metaData.year,
                plot: metaData.plot,
                genre: metaData.genre,
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
// QB_TORRENT AUTOMATION TRIGGER ENDPOINT
// =========================================================================
app.post('/api/trigger-automation', (req, res) => {
    // Respond immediately to qBittorrent with a 202 Accepted 
    // This prevents the torrent client from hanging or timing out
    res.status(202).send('Automation trigger received. Processing pool in background.');

    console.log(`\n⚡ qBittorrent completion trigger received! Firing media pipeline...`);

    // Run the sanitizer, then chain into the transcoder sequentially
    // Using absolute paths relative to your Docker container structure
    const commandChain = `node /app/library-sanitizer.js && node /app/pre-transcode.js`;

    exec(commandChain, (error, stdout, stderr) => {
        const logPath = path.join(__dirname, 'automation.log');
        const timestamp = new Date().toISOString();
        let logOutput = `\n=== AUTOMATION RUN: ${timestamp} ===\n${stdout}`;

        if (error) {
            console.error(`❌ Automation pipeline encountered an error:`, error.message);
            logOutput += `\n❌ ERROR: ${error.message}\nSTDERR: ${stderr}`;
        } else {
            console.log(`✅ Automation pipeline completed flawlessly.`);
        }

        // Append the results to an internal log file for easy auditing
        fs.appendFileSync(logPath, logOutput);
    });
});

// =========================================================================
// YTS BROWSE PROXY ENDPOINT
// =========================================================================
app.get('/api/yts/browse', async (req, res) => {
    try {
        const { query, page, genre, min_rating } = req.query;
        
        // Target the updated, lightweight public REST base URL
        const ytsUrl = `https://movies-api.accel.li/api/v2/list_movies.json`;
        
        const response = await axios.get(ytsUrl, {
            params: {
                query_term: query || '0',
                page: page || 1,
                genre: genre || 'All',
                minimum_rating: min_rating || 0,
                sort_by: 'date_added',
                order_by: 'desc',
                limit: 24
            }
        });

        res.json(response.data);
    } catch (err) {
        console.error("❌ YTS directory route communication failure:", err.message);
        res.status(500).json({ error: "Failed to fetch media data source indices." });
    }
});

// =========================================================================
// QB_TORRENT INTERNAL INGESTION TARGET
// =========================================================================
app.post('/api/yts/add', async (req, res) => {
    const { magnetUrl } = req.body;

    if (!magnetUrl) {
        return res.status(400).json({ error: "Missing targets inside structural body frames." });
    }

    try {
        // Build standard multipart structure matching qBittorrent's WebAPI specifications
        const form = new FormData();
        form.append('urls', magnetUrl);
        form.append('savepath', '/home/epic/movies'); // Forces default library directories auto-targets

        // Shoot the payload straight over the internal Docker network layer
        const qbitResponse = await axios.post('http://qbittorrent:8080/api/v2/torrents/add', form, {
            headers: form.getHeaders()
        });

        console.log(`📥 Dispatched magnet stream directly to qBittorrent container core.`);
        res.status(200).json({ message: "Successfully queued layout allocation pipeline records." });
    } catch (err) {
        console.error("❌ Failed forwarding payload across container interfaces:", err.message);
        res.status(500).json({ error: "Could not communicate assignment payloads down to qBittorrent." });
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

// =========================================================================
// DYNAMIC SRT-TO-WEBVTT SUBTITLE STREAM ENGINE
// =========================================================================
app.get('/api/subtitles/:id', (req, res) => {
    try {
        const movieId = decodeURIComponent(req.params.id);
        const folderPath = path.join(MOVIES_DIR, movieId);

        if (!fs.existsSync(folderPath)) {
            return res.status(404).send('Movie folder not found.');
        }

        const files = fs.readdirSync(folderPath);
        // Find the first SRT file available (e.g., Michael.2026.1080p.srt or English.srt)
        const srtFile = files.find(f => f.endsWith('.srt'));

        if (!srtFile) {
            return res.status(404).send('No subtitles found.');
        }

        const srtPath = path.join(folderPath, srtFile);
        let srtContent = fs.readFileSync(srtPath, 'utf-8');

        // On-the-fly conversion: WebVTT just needs a header and decimals instead of commas
        let vttContent = "WEBVTT\n\n" + srtContent
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2'); // Change SRT commas to VTT dots

        res.setHeader('Content-Type', 'text/vtt');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).send(vttContent);

    } catch (err) {
        console.error("💣 Subtitle engine failure:", err);
        res.status(500).send('Error processing subtitle asset.');
    }
});

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 MOVIE STREAMER ENGINE IS NOW LIVE`);
    console.log(`🔊 Listening on internal port: ${PORT}`);
    console.log(`📂 Scanning library at: ${MOVIES_DIR}`);
    console.log(`==================================================\n`);
});