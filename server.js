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
const { exec, spawn } = require('child_process');

if (!fs.existsSync(MOVIES_DIR)) {
    fs.mkdirSync(MOVIES_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/movie-assets', express.static(MOVIES_DIR));


// =========================================================================
// HIGH-PERFORMANCE IN-MEMORY CACHE SYNC LAYER
// =========================================================================
let INSTANT_LIBRARY_CACHE = []; // Holds the fully mapped movie payloads in RAM

function rebuildLibraryCache() {
    try {
        if (!fs.existsSync(MOVIES_DIR)) {
            INSTANT_LIBRARY_CACHE = [];
            return;
        }

        console.log("📂 [Cache Worker] Indexing disk storage arrays directly to RAM...");
        const folders = fs.readdirSync(MOVIES_DIR);
        
        // --- YOUR EXACT STEP 1: FILTER LOGIC ---
        const cleanLibrary = folders.filter(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);
            
            if (folder.startsWith('.')) return false;
            if (!fs.lstatSync(folderPath).isDirectory()) return false;

            // Condition A: Hidden block while transcoding
            if (fs.existsSync(path.join(folderPath, '.processing'))) return false;

            // Condition B: Verify optimized asset target exists
            const files = fs.readdirSync(folderPath);
            return files.some(f => f.endsWith('.web.mp4'));
        });

        // --- YOUR EXACT STEP 2: METADATA EXTRACTION & MAPPING LOGIC ---
        INSTANT_LIBRARY_CACHE = cleanLibrary.map(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);

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

        console.log(`⚡ [Cache Worker] Cache initialized. ${INSTANT_LIBRARY_CACHE.length} items optimized in memory layout blocks.`);
    } catch (err) {
        console.error("❌ Failed building internal memory cache maps:", err);
    }
}

// Fire the scan immediately on startup so the RAM array is instantly populated
rebuildLibraryCache();



/// =========================================================================
// HIGH-PERFORMANCE PAGINATED MOVIE ENDPOINT
// =========================================================================
app.get('/api/movies', (req, res) => {
    try {
        // Fetch snapshot from our fast in-memory array layer
        let cachedMovies = [...INSTANT_LIBRARY_CACHE];

        // Process request-driven pagination configuration params
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 24; // Default to 24 movie cards per screen view
        
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;

        // Slice the array inside memory bounds instantly
        const paginatedMovies = cachedMovies.slice(startIndex, endIndex);

        // Return unified payload structure to frontend client components
        res.json({
            totalMovies: cachedMovies.length,
            totalPages: Math.ceil(cachedMovies.length / limit),
            currentPage: page,
            movies: paginatedMovies
        });

    } catch (err) {
        console.error("❌ Paginated library presentation routing fault:", err);
        res.status(500).json({ error: "Failed to assemble structured movie matrix blocks." });
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

// =========================================================================
// AUTONOMOUS BACKGROUND PIPELINE WORKER (SPAWN EXECUTION LOOP)
// =========================================================================
const LIFECYCLE_POLL_INTERVAL = 10000; 
let isProcessingPipeline = false;      

async function checkPipelineCompletions() {
    if (isProcessingPipeline) return;

    try {
        const qbitRes = await axios.get('http://qbittorrent:8080/api/v2/torrents/info?tag=movie-streamer');
        const torrents = qbitRes.data;
        const completedTorrent = torrents.find(t => t.progress === 1);

        if (completedTorrent) {
            isProcessingPipeline = true; // Lock worker concurrency
            const torrentHash = completedTorrent.hash;
            
            console.log(`\n🎉 Internal Pipeline Watcher detected download completion: [${completedTorrent.name}]`);
            console.log(`⚡ Launching live-streamed processing pipeline...`);

            // --- START OF THE SPAWN INSERTION CHAIN ---
            
            // 1. Spawn the sanitizer script (No arguments needed, scans /app/movies globally)
            const pipelineProcess = spawn('node', ['/app/library-sanitizer.js']);
            
            const logPath = path.join(__dirname, 'automation.log');
            const logStream = fs.createWriteStream(logPath, { flags: 'a' });

            // Timestamp the top of this run inside the automation log file
            logStream.write(`\n=== LIVE PIPELINE RUN: ${new Date().toISOString()} ===\n`);

            // Stream sanitizer output live to disk so the memory buffer never blocks
            pipelineProcess.stdout.on('data', (data) => logStream.write(data));
            pipelineProcess.stderr.on('data', (data) => logStream.write(data));

            // When the sanitizer completes, step into the transcoder layer
            pipelineProcess.on('close', (code) => {
                if (code !== 0) {
                    console.error(`❌ Sanitizer layer exited with failure code: ${code}`);
                    isProcessingPipeline = false;
                    logStream.end();
                    return;
                }

                console.log(`🧹 Sanitizer pass complete. Proceeding to transcode optimizer engine...`);

                // 2. Spawn the heavy transcoder process sequentially
                const transcodeProcess = spawn('node', ['/app/pre-transcode.js']);

                // Stream the massive FFmpeg progress log updates directly onto disk frame-by-frame
                transcodeProcess.stdout.on('data', (data) => logStream.write(data));
                transcodeProcess.stderr.on('data', (data) => logStream.write(data));

                // Final closure block: Triggers when the full movie is completely transcoded
                transcodeProcess.on('close', async (transcodeCode) => {
                    logStream.end(); // Safely release and close the write stream file handle

                    if (transcodeCode !== 0) {
                        console.error(`❌ Transcoder layer exited with failure code: ${transcodeCode}`);
                        isProcessingPipeline = false;
                        return;
                    }

                    console.log(`✅ Media normalization and transcode loops finished cleanly.`);
                    
                    // Rotate the tracking tags inside qBittorrent now that work is safely written
                    try {
                        console.log(`🏷️  Rotating qBittorrent workflow flags to processed for: ${completedTorrent.name}`);
                        await axios.post('http://qbittorrent:8080/api/v2/torrents/removeTags', `hashes=${torrentHash}&tags=movie-streamer`, {
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                        });
                        await axios.post('http://qbittorrent:8080/api/v2/torrents/addTags', `hashes=${torrentHash}&tags=movie-streamer-processed`, {
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                        });
                    } catch (tagErr) {
                        console.error(`⚠️ Failed updating torrent metadata flags inside qBittorrent:`, tagErr.message);
                    }

                    // Reload the internal memory arrays to show the new movie card immediately
                    rebuildLibraryCache();
                    
                    // Release the worker concurrency flag
                    isProcessingPipeline = false; 
                });
            });
            
            // --- END OF THE SPAWN INSERTION CHAIN ---
        }
    } catch (err) {
        console.error("⚠️ Background pipeline worker cycle execution error:", err.message);
        isProcessingPipeline = false; 
    }
}

setInterval(checkPipelineCompletions, LIFECYCLE_POLL_INTERVAL);

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 MOVIE STREAMER ENGINE IS NOW LIVE`);
    console.log(`🔊 Listening on internal port: ${PORT}`);
    console.log(`📂 Scanning library at: ${MOVIES_DIR}`);
    console.log(`==================================================\n`);
});