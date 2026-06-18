console.log("!!! SERVER IS CURRENTLY INITIALIZING !!!");

const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;
const MOVIES_DIR = path.join(__dirname, 'movies');
const axios = require('axios');
const FormData = require('form-data');
const { exec, spawn } = require('child_process');

const logger = require('./logger');


if (!fs.existsSync(MOVIES_DIR)) {
    fs.mkdirSync(MOVIES_DIR, { recursive: true });
}
app.use(express.urlencoded({ extended: true }));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/movie-assets', express.static(MOVIES_DIR));


// GET: Stream Live Real-Time Logs straight to Admin UI via SSE
app.get('/api/admin/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Instruct Cloudflare not to buffer the stream chunks
    res.setHeader('X-Accel-Buffering', 'no'); 
    res.flushHeaders();

    // 1. Flush historical data arrays right away
    logger.getHistory().forEach(line => {
        res.write(`data: ${line}\n\n`);
    });

    // 2. Listen for active logging calls
    const logListener = (line) => {
        res.write(`data: ${line}\n\n`);
    };
    logger.logStream.on('line', logListener);

    // 3. FIXED: Keep-Alive Heartbeat Interval Loop to block Cloudflare 524 timeouts
    const keepAliveInterval = setInterval(() => {
        res.write(': keepalive\n\n'); 
    }, 30000); // Pulse every 30 seconds

    // Clean up connections on browser tab close
    req.on('close', () => {
        clearInterval(keepAliveInterval);
        logger.logStream.off('line', logListener);
    });
});

// POST: Let the admin trigger the sanitizer manually from the web UI
app.post('/api/admin/sanitizer/run', async (req, res) => {
    res.json({ success: true, message: "Sanitizer execution sequence triggered." });
    
    try {
        // Explicitly destructure the exported function out of the module object
        const { sanitizeLibrary } = require('./library-sanitizer');
        await sanitizeLibrary();
    } catch (err) {
        logger.log(`Critical background processing fault: ${err.message}`, 'error');
    }
});

app.post('/api/admin/upload-poster', async (req, res) => {
    try {
        const { folder, name, image } = req.body;
        if (!folder || !image) {
            return res.status(400).json({ success: false, error: 'Missing parameters.' });
        }

        // Clean up data URL base64 prefix if present
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        // Target the absolute directory mapping for the specific show
        const targetDir = path.join('/app/movies', 'series', folder);
        
        try {
            // Non-blocking asynchronous directory verification
            await fsPromises.access(targetDir);
        } catch {
            return res.status(404).json({ success: false, error: 'Target directory not found.' });
        }

        // Save cleanly as poster.jpg using non-blocking async writes
        const finalPath = path.join(targetDir, 'cover.jpg');
        await fsPromises.writeFile(finalPath, buffer);

        logger.log(`🎨 [ASSET OVERRIDE] Fresh poster artwork written directly to disk for: ${folder}`);
        res.json({ success: true, message: 'Poster written to disk.' });
    } catch (err) {
        logger.log(`Asset upload exception: ${err.message}`, 'error');
        res.status(500).json({ success: false, error: err.message });
    }
});

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
        
        let temporaryCache = [];

        // --- SUB-PASS A: MOVIE ROOT DISK FILES ---
        const cleanMovies = folders.filter(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);
            if (folder.startsWith('.') || !fs.lstatSync(folderPath).isDirectory()) return false;
            if (['sample', 'series'].includes(folder.toLowerCase())) return false; // Skip the TV branch here
            if (fs.existsSync(path.join(folderPath, '.processing'))) return false;

            const files = fs.readdirSync(folderPath);
            return files.some(f => f.endsWith('.web.mp4'));
        });

        cleanMovies.forEach(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);
            const metaFile = path.join(folderPath, 'metadata.json');
            let metaData = { title: folder.replace(/[-_.]/g, ' '), year: '', plot: '', genre: '', contentType: 'movie' };
            
            if (fs.existsSync(metaFile)) {
                try { metaData = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch (e) {}
            }

            temporaryCache.push({
                id: encodeURIComponent(folder),
                title: metaData.title,
                year: metaData.year,
                plot: metaData.plot,
                genre: metaData.genre,
                contentType: 'movie',
                cover: `/movie-assets/${encodeURIComponent(folder)}/cover.jpg`
            });
        });

        // --- SUB-PASS B: NESTED TV SHOWS BRANCH ---
        const seriesRootDir = path.join(MOVIES_DIR, 'series');
        if (fs.existsSync(seriesRootDir)) {
            const showFolders = fs.readdirSync(seriesRootDir);
            
            showFolders.forEach(showFolder => {
                const showPath = path.join(seriesRootDir, showFolder);
                if (showFolder.startsWith('.') || !fs.lstatSync(showPath).isDirectory()) return;

                const metaFile = path.join(showPath, 'metadata.json');
                let metaData = { title: showFolder.replace(/[-_.]/g, ' '), year: '', plot: '', genre: '', contentType: 'series' };

                if (fs.existsSync(metaFile)) {
                    try { metaData = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch (e) {}
                }

                temporaryCache.push({
                    id: encodeURIComponent(`series/${showFolder}`), // Keeps resource paths descriptive and unique
                    title: metaData.title,
                    year: metaData.year,
                    plot: metaData.plot,
                    genre: metaData.genre,
                    contentType: 'series',
                    cover: `/movie-assets/series/${encodeURIComponent(showFolder)}/cover.jpg`
                });
            });
        }

        INSTANT_LIBRARY_CACHE = temporaryCache;
        console.log(`⚡ [Cache Worker] Cache initialized. ${INSTANT_LIBRARY_CACHE.length} active multi-tier assets mapped.`);
    } catch (err) {
        console.error("❌ Failed building internal memory cache maps:", err);
    }
}

// Fire the scan immediately on startup so the RAM array is instantly populated
rebuildLibraryCache();

// INDIVIDUAL MOVIE STREAM PROFILE ROUTER
app.get('/api/movies/:id', (req, res) => {
    const movieId = req.params.id;
    
    // Construct the absolute path to this specific movie's metadata folder
    const movieFolder = path.join(MOVIES_DIR, movieId);
    const infoFilePath = path.join(movieFolder, 'movie_info.json');

    // Fallback Verification: Ensure the requested directory is physically present
    if (!fs.existsSync(movieFolder)) {
        return res.status(404).json({ status: 'error', message: 'Movie cluster destination missing.' });
    }

    // Baseline fallback payload matching your stream-switcher properties
    let streamPayload = {
        id: movieId,
        title: movieId.replace(/\./g, ' '), // Quick string regex replacement for human readable title fallback
        file1080p: null,
        file720p: null,
        file480p: null
    };

    // If you maintain isolated movie_info.json descriptors per-folder, unpack it
    if (fs.existsSync(infoFilePath)) {
        try {
            const rawData = fs.readFileSync(infoFilePath, 'utf8');
            const meta = JSON.parse(rawData);
            streamPayload.title = meta.title || streamPayload.title;
        } catch (e) {
            console.error(`⚠️ Failed to parse metadata file for ${movieId}`);
        }
    }

    // Dynamic Filesystem Probe: Map available profile outputs to payload properties
    // Looks for local files matching your pre-transcode script definitions
    const expectedOutputs = {
        '1080p': `${movieId}.web.mp4`,      // Your master progressive output asset
        '720p': `${movieId}.720p.mp4`,      // Item 1 downscaled profile
        '480p': `${movieId}.480p.mp4`       // Item 1 cellular profile
    };

    // Build functional streaming asset paths accessible over HTTP
    if (fs.existsSync(path.join(movieFolder, expectedOutputs['1080p']))) {
        streamPayload.file1080p = `/movies/${movieId}/${expectedOutputs['1080p']}`;
    } else {
        // Fallback: If your preprocessing rename wasn't run yet, probe for standard .mp4 containers
        const files = fs.readdirSync(movieFolder);
        const sourceMp4 = files.find(f => f.endsWith('.mp4') && !f.includes('720p') && !f.includes('480p'));
        if (sourceMp4) streamPayload.file1080p = `/movies/${movieId}/${sourceMp4}`;
    }

    if (fs.existsSync(path.join(movieFolder, expectedOutputs['720p']))) {
        streamPayload.file720p = `/movies/${movieId}/${expectedOutputs['720p']}`;
    }

    if (fs.existsSync(path.join(movieFolder, expectedOutputs['480p']))) {
        streamPayload.file480p = `/movies/${movieId}/${expectedOutputs['480p']}`;
    }

    // Safety: If no specific targeted mp4 was matched, just serve up the base source file
    if (!streamPayload.file1080p) {
        streamPayload.file1080p = `/movies/${movieId}`;
    }

    // Ship the fully compiled structural map back to player.html
    res.json(streamPayload);
});

// GET: Fetch raw metadata states for manual curation workspace
app.get('/api/admin/series-metadata', (req, res) => {
    try {
        const seriesDir = path.join(MOVIES_DIR, 'series');
        if (!fs.existsSync(seriesDir)) return res.json({ success: true, shows: [] });

        const shows = fs.readdirSync(seriesDir).map(folder => {
            const showPath = path.join(seriesDir, folder);
            if (!fs.lstatSync(showPath).isDirectory()) return null;

            const metaPath = path.join(showPath, 'metadata.json');
            let meta = { title: folder, year: '', plot: '', genre: '', contentType: 'series' };
            
            if (fs.existsSync(metaPath)) {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            }

            return { folder, metadata: meta };
        }).filter(Boolean);

        res.json({ success: true, shows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST: Force manual override mapping adjustments
app.post('/api/admin/override-metadata', (req, res) => {
    try {
        const { folder, title, year, plot, genre, imdbId } = req.body;
        const targetPath = path.join(MOVIES_DIR, 'series', folder);

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({ success: false, error: "Target directory configuration missing." });
        }

        const metadataPath = path.join(targetPath, 'metadata.json');
        const updatedMeta = {
            title: title || folder,
            year: year || '',
            plot: plot || '',
            genre: genre || '',
            contentType: 'series',
            imdbId: imdbId || ''
        };

        fs.writeFileSync(metadataPath, JSON.stringify(updatedMeta, null, 4));
        console.log(`🔧 [ADMIN OVERRIDE] Saved metadata manually for: ${folder}`);
        
        res.json({ success: true, message: "Metadata overrides saved successfully." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/series/:showFolder', (req, res) => {
    try {
        const showFolder = decodeURIComponent(req.params.showFolder);
        const showPath = path.join(MOVIES_DIR, 'series', showFolder);

        const metaFile = path.join(showPath, 'metadata.json');
        const seriesFile = path.join(showPath, 'series.json');

        if (!fs.existsSync(metaFile) || !fs.existsSync(seriesFile)) {
            return res.status(404).json({ error: "Serialized map targets are currently missing for this show cluster destination." });
        }

        // Fast sequential direct file-reads
        const metaData = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        const seriesData = JSON.parse(fs.readFileSync(seriesFile, 'utf-8'));

        // Respond with a clean, fully unified payload object
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
// FIXED YTS BROWSE PROXY ENDPOINT
// =========================================================================
app.get('/api/yts/browse', async (req, res) => {
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
        form.append('savepath', '/downloads');
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