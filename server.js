console.log("!!! SERVER IS CURRENTLY INITIALIZING !!!");

const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;
const { exec } = require('child_process');
const MOVIES_DIR = path.join(__dirname, 'movies');
const axios = require('axios');
const FormData = require('form-data');

if (!fs.existsSync(MOVIES_DIR)) {
    fs.mkdirSync(MOVIES_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/movie-assets', express.static(MOVIES_DIR));

// =========================================================================
// SAFE & FILTERED LIBRARY INDEX SCANNER
// =========================================================================
app.get('/api/movies', (req, res) => {
    try {
        if (!fs.existsSync(MOVIES_DIR)) return res.json([]);

        const folders = fs.readdirSync(MOVIES_DIR);
        
        // Step 1: Filter out items that are incomplete or currently processing
        const cleanLibrary = folders.filter(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);
            
            // Skip hidden directories/system files
            if (folder.startsWith('.')) return false;
            if (!fs.lstatSync(folderPath).isDirectory()) return false;

            // Condition A: If the folder contains the transient transcode lock, hide it
            if (fs.existsSync(path.join(folderPath, '.processing'))) return false;

            // Condition B: Ensure the final web-optimized file actually exists before showing it
            const files = fs.readdirSync(folderPath);
            const hasWebOptimizedAsset = files.some(f => f.endsWith('.web.mp4'));
            
            return hasWebOptimizedAsset;
        });

        // Step 2: Map over ONLY the safely verified folders to assemble the UI payload
        const movies = cleanLibrary.map(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);
            const files = fs.readdirSync(folderPath);

            // Load local metadata parsed from your OMDb script layer
            const metaFile = path.join(folderPath, 'metadata.json');
            let metaData = { title: folder.replace(/[-_.]/g, ' '), year: '', plot: '', genre: '' };
            
            if (fs.existsSync(metaFile)) {
                try {
                    metaData = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
                } catch (e) {
                    console.error(`Malformed metadata track inside: ${folder}`);
                }
            }

            return {
                id: encodeURIComponent(folder),
                title: metaData.title,
                year: metaData.year,
                plot: metaData.plot,
                genre: metaData.genre,
                cover: `/movie-assets/${encodeURIComponent(folder)}/cover.jpg`
            };
        });

        res.json(movies);
    } catch (err) {
        console.error("❌ Directory read error:", err);
        res.status(500).json({ error: "Failed to read library structures." });
    }
});

// =========================================================================
// QB_TORRENT AUTOMATION TRIGGER ENDPOINT
// =========================================================================
app.post('/api/trigger-automation', (req, res) => {
    res.status(202).send('Automation trigger received. Processing pool in background.');
    console.log(`\n⚡ qBittorrent completion trigger received! Firing media pipeline...`);

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
        fs.appendFileSync(logPath, logOutput);
    });
});

// =========================================================================
// YTS BROWSE PROXY ENDPOINT
// =========================================================================
app.get('/api/yts/browse', async (req, res) => {
    try {
        const { query, page, genre, min_rating } = req.query;
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
        const form = new FormData();
        form.append('urls', magnetUrl);
        form.append('savepath', '/home/epic/movies');
        form.append('tags', 'movie-streamer'); 

        await axios.post('http://qbittorrent:8080/api/v2/torrents/add', form, {
            headers: form.getHeaders()
        });

        console.log(`📥 Dispatched tagged magnet stream directly to qBittorrent.`);
        res.status(200).json({ message: "Successfully queued layout allocation pipeline records." });
    } catch (err) {
        console.error("❌ Failed forwarding payload across container interfaces:", err.message);
        res.status(500).json({ error: "Could not communicate assignment payloads down to qBittorrent." });
    }
});

// =========================================================================
// PIPELINE STATUS MONITOR (FILTERED VIA INTEGRATED WORKFLOW TAGS)
// =========================================================================
app.get('/api/pipeline/status', async (req, res) => {
    try {
        let pipeline = [];

        // 1. Fetch live downloads FILTERED by your tag
        try {
            const qbitRes = await axios.get('http://qbittorrent:8080/api/v2/torrents/info?tag=movie-streamer');
            
            qbitRes.data.forEach(torrent => {
                let displayStatus = 'Downloading';
                if (torrent.progress === 1) displayStatus = 'Finalizing...';
                if (torrent.state.includes('paused') || torrent.state.includes('queued')) displayStatus = 'Queued';

                pipeline.push({
                    title: torrent.name.replace(/[._-]/g, ' '),
                    progress: (torrent.progress * 100).toFixed(1),
                    status: displayStatus,
                    eta: torrent.eta, 
                    size: (torrent.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
                });
            });
        } catch (qbitErr) {
            console.error("⚠️ Pipeline Monitor couldn't reach qBittorrent:", qbitErr.message);
        }

        // 2. Scan physical directories for active transcode lockfiles
        if (fs.existsSync(MOVIES_DIR)) {
            const folders = fs.readdirSync(MOVIES_DIR);
            folders.forEach(folder => {
                const folderPath = path.join(MOVIES_DIR, folder);
                if (fs.lstatSync(folderPath).isDirectory()) {
                    if (fs.existsSync(path.join(folderPath, '.processing'))) {
                        pipeline.push({
                            title: folder.replace(/[._-]/g, ' '),
                            progress: 'N/A',
                            status: 'Pre-Transcoding (Optimizing)',
                            eta: 'Calculating...',
                            size: 'Processing Video Stream...'
                        });
                    }
                }
            });
        }

        res.json({ success: true, pipeline });
    } catch (err) {
        res.status(500).json({ error: "Failed to assemble pipeline matrix state structures." });
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

        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4'
        };

        if (req.method === 'OPTIONS') {
            res.writeHead(204, headers);
            return res.end();
        }

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
            console.log(`🎬 Direct Stream Initialized: Full pipe delivery for ${videoFile}`);
            res.writeHead(200, { ...headers, 'Content-Length': fileSize });
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
        const srtFile = files.find(f => f.endsWith('.srt'));

        if (!srtFile) {
            return res.status(404).send('No subtitles found.');
        }

        const srtPath = path.join(folderPath, srtFile);
        let srtContent = fs.readFileSync(srtPath, 'utf-8');

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

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 MOVIE STREAMER ENGINE IS NOW LIVE`);
    console.log(`🔊 Listening on internal port: ${PORT}`);
    console.log(`📂 Scanning library at: ${MOVIES_DIR}`);
    console.log(`==================================================\n`);
});