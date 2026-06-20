/*
API DOCUMENTATION
=================

Authentication and Profiles
---------------------------
POST /api/auth/register
  - Registers a new user with username and password.
  - Sets the user_profile cookie on success for immediate login.
  - Returns JSON: { success: true } or { success: false, error }

POST /api/auth/login
  - Authenticates credentials and updates login history.
  - Sets the user_profile cookie for session state.
  - Returns JSON: { success: true } or { success: false, error }

GET /api/auth/me
  - Returns the current authenticated profile state.
  - Uses the user_profile cookie.
  - Returns JSON: { loggedIn: true, username, config }

GET /api/auth/logout
  - Clears the user_profile cookie.
  - Redirects the browser to /login.html.

Admin and Maintenance
---------------------
GET /api/admin/logs/stream
  - Streams live server logs to the admin UI using Server-Sent Events.
  - Keeps the connection alive with heartbeat comments.

POST /api/admin/sanitizer/run
  - Triggers the library sanitizer workflow from the web UI.
  - Responds immediately with success while sanitization runs asynchronously.

POST /api/admin/upload-poster
  - Uploads a base64-encoded poster image for a series folder.
  - Writes the image to /app/movies/series/:folder/cover.jpg.
  - Request body: { folder, name, image }

GET /api/admin/series-metadata
  - Returns raw series metadata for each show folder under movies/series.
  - Useful for manual curation workflows.

POST /api/admin/override-metadata
  - Saves manually overridden metadata for a series folder.
  - Request body: { folder, title, year, plot, genre, imdbId }

Playback and Profile State
--------------------------
POST /api/profile/playback/sync
  - Saves playback progress for a media item.
  - Request body: { mediaId, position }
  - Includes anti-reset logic to ignore unsafe zero resets.

GET /api/profile/playback/state
  - Returns the saved playback position for a mediaId.
  - Query param: mediaId

Library and Content Discovery
-----------------------------
GET /api/movies
  - Returns paginated movie/series library entries from an in-memory cache.
  - Query params: page, limit
  - Response: { totalMovies, totalPages, currentPage, movies }

GET /api/movies/:id
  - Returns stream metadata and accessible file paths for a single movie folder.
  - Path param: id
  - Looks for 1080p/720p/480p assets and fallback MP4 files.

GET /api/series/:showFolder
  - Returns a unified series payload for a specific show folder.
  - Path param: showFolder
  - Includes metadata, poster path, seasons, and totalSeasons.

GET /api/eztv/browse
  - Searches EZTV torrents by query term and optional pack-only filter.
  - Query params: query, packsOnly
  - Uses OMDb to resolve title metadata and poster imagery.

GET /api/yts/browse
  - Proxies YTS movie browse requests through a fixed API endpoint.
  - Query params: query_term, page, genre, minimum_rating, sort_by

POST /api/yts/add
  - Adds a magnet link to qBittorrent with a fixed save path and tag.
  - Request body: { magnetUrl }

POST /api/downloader/add
  - Adds a magnet link to qBittorrent with a save path by category.
  - Request body: { magnetUrl, category }

Pipeline and Automation
-----------------------
POST /api/trigger-automation
  - Triggers the post-download automation pipeline in the background.
  - Executes library-sanitizer.js and pre-transcode.js.

GET /api/pipeline/status
  - Returns current pipeline state for tagged qBittorrent torrents and active processing folders.
  - Includes download progress and transcode status.

Streaming and Assets
--------------------
GET /api/raw-file/:id
  - Streams a video file directly from a movie folder with Range support.
  - Path param: id

GET /api/subtitles/:id
  - Converts an SRT subtitle file to WebVTT on-demand.
  - Path param: id

Static Asset Delivery
---------------------
- Static UI files are served from /public via express.static.
- Movie assets are served from /movie-assets mapped to the movies directory.

Auth Middleware
---------------
- All routes are protected by requireAuth except:
  - /login.html
  - /api/auth/login
  - /api/auth/register
*/

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
const fsPromises = fs.promises;
const { sendVerificationEmail } = require('./mailer');
const cookieParser = require('cookie-parser');
const ProfileManager = require('./profile-manager');
const crypto = require('crypto');
const logger = require('./logger');


if (!fs.existsSync(MOVIES_DIR)) {
    fs.mkdirSync(MOVIES_DIR, { recursive: true });
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());


// Middleware: Enforce profile authentication walls
function requireAuth(req, res, next) {
    // 1. Exclude core authentication API loops and the login page to prevent infinite redirect spirals
    const publicPaths = ['/login.html', '/api/auth/login', '/api/auth/register'];
    
    if (publicPaths.includes(req.path)) {
        return next();
    }

    // 2. Inspect browser cookies for an active session anchor
    const activeUser = req.cookies.user_profile;

    if (!activeUser) {
        // If it's an API request data fetch, send a formal 401 Unauthorized status code
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ success: false, error: "Authentication required." });
        }
        // If it's a standard page navigation index lookup, force back to the access card
        return res.redirect('/login.html');
    }

    // Session verified safely, hand execution back to the next controller step
    next();
}

// ⚠️ REGISTER THIS MIDDLEWARE RIGHT HERE (Crucial placement index)
app.use(requireAuth);

// Your existing static asset delivery mapping arrays follow below:
app.use(express.static(path.join(__dirname, 'public')));
app.use('/movie-assets', express.static(MOVIES_DIR));


// POST: Process user enrollment pipelines
app.post('/api/auth/register', async (req, res) => {
    const { username, password, email } = req.body; // 👈 Accept email from payload
    if (!username || !password || !email) {
        return res.status(400).json({ success: false, error: "Fields cannot be blank." });
    }

    try {
        // Pass email into your function
        const result = await ProfileManager.registerUser(username, password, email);
        
        if (result.success) {
            // Asynchronously dispatch your mail out via Brevo using the returned token
            sendVerificationEmail(email.trim(), username.trim(), result.token);

            // Inform the front-end to show the success banner check
            return res.json({ 
                success: true, 
                message: "Registration successful! Check your inbox to verify your profile." 
            });
        }
        res.status(400).json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/auth/verify', async (req, res) => {
    const { token, user } = req.query;
    const cleanName = user.toLowerCase().trim();
    
    try {
        // Use your actual generic data reader
        const userConfig = await ProfileManager.readData(cleanName, 'config', null);
        
        if (!userConfig || userConfig.verificationToken !== token) {
            return res.send('<h3>Invalid verification token layout.</h3>');
        }
        if (Date.now() > userConfig.verificationExpires) {
            return res.send('<h3>Verification token has expired. Please register again.</h3>');
        }

        // Flip authorization status flags
        userConfig.isVerified = true;
        delete userConfig.verificationToken;
        delete userConfig.verificationExpires;
        
        // Use your actual generic data writer
        await ProfileManager.writeData(cleanName, 'config', userConfig);
        
        res.redirect('/login.html?verified=true');
    } catch (err) {
        res.status(500).send('Verification error occurred.');
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const cleanName = username.toLowerCase().trim();

    try {
        const result = await ProfileManager.authenticateUser(username, password);
        if (result.success) {
            
            // 🛡️ THE GUARDRAIL: Read the configuration using your generic engine wrapper
            const userConfig = await ProfileManager.readData(cleanName, 'config', null);
            if (userConfig && userConfig.isVerified === false) {
                return res.status(403).json({ 
                    success: false, 
                    error: "Account verification pending. Please validate your registration via email link." 
                });
            }

            // If verified, proceed with your exact cookie assignment steps
            res.cookie('user_profile', cleanName, { maxAge: 31536000000, path: '/' });
            return res.json({ success: true });
        }
        res.status(400).json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: Profile details loop used by frontends
app.get('/api/auth/me', async (req, res) => {
    const activeUser = req.cookies.user_profile;
    if (!activeUser) return res.status(401).json({ loggedIn: false });

    const config = await ProfileManager.readData(activeUser, 'config', {});
    res.json({ loggedIn: true, username: activeUser, config });
});

app.get('/api/auth/logout', (req, res) => {
    res.clearCookie('user_profile', { path: '/' });
    res.redirect('/login.html');
});


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
    logger.log('📡 [SSE] Admin log stream initialized. Listening for live updates...', 'info');

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


// Middleware helper to pull active user identity context
function getActiveUser(req) {
    return req.cookies.user_profile || 'guest';
}

// POST: Heartbeat endpoint triggered by player window updates
app.post('/api/profile/playback/sync', async (req, res) => {
    try {
        const username = getActiveUser(req);
        const { mediaId, position } = req.body;

        if (!mediaId || position === undefined) {
            return res.status(400).json({ success: false, error: 'Missing sync states' });
        }

        // 🛡️ ANTI-RESET SHIELD: 
        // If the frontend tries to save exactly 0, check what we already have on disk first.
        // If we already have a progress position saved, don't let a sudden 0 wipe it out.
        if (parseFloat(position) === 0) {
            const currentPlayback = await ProfileManager.getPlaybackState(username);
            if (currentPlayback && currentPlayback[mediaId] && currentPlayback[mediaId].position > 10) {
                // Ignore the rogue 0 save and return early safely
                return res.json({ success: true, message: 'Ignored teardown zero reset.' });
            }
        }

        await ProfileManager.savePlaybackPosition(username, mediaId, position);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: Fetch individual media position tracking states
app.get('/api/profile/playback/state', async (req, res) => {
    try {
        const username = getActiveUser(req);
        const { mediaId } = req.query;

        const playback = await ProfileManager.getPlaybackState(username);
        const state = playback[mediaId] || { position: 0 };

        res.json({ success: true, position: state.position });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/eztv/browse', async (req, res) => {
    try {
        const queryTerm = req.query.query ? req.query.query.trim() : '';
        const packsOnly = req.query.packsOnly === 'true';
        let targetImdbId = '';
        let omdbMeta = null;

        if (!queryTerm) {
            return res.json({ success: true, torrents: [] });
        }

        // Step 1: Query OMDb to translate text titles into static IMDB IDs
        const omdbUrl = `http://www.omdbapi.com/?apikey=84196d01&s=${encodeURIComponent(queryTerm)}&type=series`;
        const omdbRes = await axios.get(omdbUrl);
        
        if (omdbRes.data && omdbRes.data.Search && omdbRes.data.Search.length > 0) {
            const match = omdbRes.data.Search[0];
            targetImdbId = match.imdbID.replace('tt', ''); // Strip prefix
            
            // Fetch detailed poster meta
            const detailRes = await axios.get(`http://www.omdbapi.com/?apikey=84196d01&i=${match.imdbID}`);
            omdbMeta = detailRes.data;
        } else {
            // Fallback: If OMDb has no hits, try numeric parsing or fallback
            targetImdbId = queryTerm.startsWith('tt') ? queryTerm.replace('tt', '') : '';
        }

        if (!targetImdbId) {
            return res.json({ success: true, torrents: [] });
        }

        // Step 2: Multi-page deep scan loop to pull all available trackers from EZTV
        let allTorrents = [];
        let currentPage = 1;
        let keepScanning = true;

        while (keepScanning && currentPage <= 5) { // Protect from infinite loop walls
            const eztvUrl = `https://eztv.wf/api/get-torrents?imdb_id=${targetImdbId}&limit=100&page=${currentPage}`;
            const eztvRes = await axios.get(eztvUrl, { timeout: 5000 });

            if (eztvRes.data && eztvRes.data.torrents && eztvRes.data.torrents.length > 0) {
                allTorrents = allTorrents.concat(eztvRes.data.torrents);
                // If we got fewer records than the page limit, we've hit the bottom of the lake
                if (eztvRes.data.torrents.length < 100) {
                    keepScanning = false;
                } else {
                    currentPage++;
                }
            } else {
                keepScanning = false;
            }
        }

        // Step 3: Run Filters
        if (packsOnly) {
            const packRegex = /(season\s*pack|complete|s\d{2}\s*complete|seasons?\s*\d+\s*-\s*\d+|t[-_.]?pack|\[pack\])/i;
            allTorrents = allTorrents.filter(t => packRegex.test(t.title));
        }

        // Step 4: Map normalized payloads using high-quality OMDb cover imagery assets
        const results = allTorrents.map(t => {
            const sizeInGB = t.size_bytes ? (parseFloat(t.size_bytes) / (1024 ** 3)).toFixed(2) + ' GB' : 'N/A';
            return {
                title: t.title,
                size: sizeInGB,
                seeds: parseInt(t.seeds, 10) || 0,
                peers: parseInt(t.peers, 10) || 0,
                magnet: t.magnet_url || `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.title)}`,
                cover: (omdbMeta && omdbMeta.Poster && omdbMeta.Poster !== "N/A") ? omdbMeta.Poster : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="100%" height="100%" fill="%23020617"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%23475569">No Cover</text></svg>'
            };
        });

        res.json({ success: true, torrents: results });

    } catch (err) {
        logger.log(`OMDb/EZTV Pipeline crash: ${err.message}`, 'error');
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

// 🛡️ Admin Verification Middleware Layer
function requireAdmin(req, res, next) {
    const activeUser = req.cookies.user_profile;
    if (activeUser && activeUser.toLowerCase().trim() === 'josh') {
        return next();
    }
    // Block API endpoints or kick standard pages out
    if (req.path.startsWith('/api/')) {
        return res.status(403).json({ success: false, error: "Access denied. Administrator clearance required." });
    }
    res.redirect('/login.html');
}

// Bind admin walls to the structural assets and endpoints
app.use('/admin.html', requireAdmin);
app.use('/api/admin/*', requireAdmin);


// GET: Unified library metadata collection array loop (Movies + Series)
app.get('/api/admin/library-metadata', (req, res) => {
    try {
        const results = { movies: [], shows: [] };

        // 1. Process Movie Assets
        if (fs.existsSync(MOVIES_DIR)) {
            fs.readdirSync(MOVIES_DIR).forEach(folder => {
                const itemPath = path.join(MOVIES_DIR, folder);
                if (folder === 'series' || !fs.lstatSync(itemPath).isDirectory()) return;

                const metaPath = path.join(itemPath, 'metadata.json');
                let meta = { title: folder, year: '', plot: '', genre: '', contentType: 'movie' };
                if (fs.existsSync(metaPath)) {
                    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                }
                results.movies.push({ folder, metadata: meta });
            });
        }

        // 2. Process Series Assets
        const seriesDir = path.join(MOVIES_DIR, 'series');
        if (fs.existsSync(seriesDir)) {
            fs.readdirSync(seriesDir).forEach(folder => {
                const itemPath = path.join(seriesDir, folder);
                if (!fs.lstatSync(itemPath).isDirectory()) return;

                const metaPath = path.join(itemPath, 'metadata.json');
                let meta = { title: folder, year: '', plot: '', genre: '', contentType: 'series' };
                if (fs.existsSync(metaPath)) {
                    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                }
                results.shows.push({ folder, metadata: meta });
            });
        }

        res.json({ success: true, library: results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// POST: Flexible Dynamic Override Target Layer
app.post('/api/admin/override-metadata', (req, res) => {
    try {
        const { folder, title, year, plot, genre, imdbId, contentType } = req.body;
        
        // Pinpoint matching host path based on content routing tags
        const baseRoute = (contentType === 'series') ? path.join(MOVIES_DIR, 'series') : MOVIES_DIR;
        const targetPath = path.join(baseRoute, folder);

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({ success: false, error: `Directory target not found: ${folder}` });
        }

        const metadataPath = path.join(targetPath, 'metadata.json');
        const updatedMeta = {
            title: title || folder,
            year: year || '',
            plot: plot || '',
            genre: genre || '',
            contentType: contentType || 'movie',
            imdbId: imdbId || ''
        };

        fs.writeFileSync(metadataPath, JSON.stringify(updatedMeta, null, 4));
        console.log(`🔧 [ADMIN OVERRIDE] Saved metadata manually for ${contentType}: ${folder}`);
        
        res.json({ success: true, message: "Metadata overrides saved successfully." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// POST: Adaptive upload-poster layer targeting subfolders contextually
app.post('/api/admin/upload-poster', (req, res) => {
    try {
        const { folder, image, contentType } = req.body;
        if (!folder || !image) return res.status(400).json({ success: false, error: "Missing assets." });

        const baseRoute = (contentType === 'series') ? path.join(MOVIES_DIR, 'series') : MOVIES_DIR;
        const destinationFolder = path.join(baseRoute, folder);

        if (!fs.existsSync(destinationFolder)) {
            return res.status(404).json({ success: false, error: "Target directory missing." });
        }

        // Strip incoming base64 payload header strings safely
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        fs.writeFileSync(path.join(destinationFolder, 'cover.jpg'), buffer);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// GET: Expose list of configured local runtime user profile folders
app.get('/api/admin/users', (req, res) => {
    try {
        const userMetaDir = path.join(__dirname, 'metadata', 'users');
        if (!fs.existsSync(userMetaDir)) return res.json({ success: true, users: [] });

        const profiles = fs.readdirSync(userMetaDir).map(folder => {
            const userPath = path.join(userMetaDir, folder);
            if (!fs.lstatSync(userPath).isDirectory()) return null;

            // Gather structural footprints safely if files exist on disk
            const hasHistory = fs.existsSync(path.join(userPath, 'history.json'));
            const hasPlayback = fs.existsSync(path.join(userPath, 'playback.json'));
            
            return { username: folder, hasHistory, hasPlayback };
        }).filter(Boolean);

        res.json({ success: true, users: profiles });
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

app.post('/api/downloader/add', async (req, res) => {
    const { magnetUrl, category } = req.body; // 'movie' or 'series'

    if (!magnetUrl) {
        return res.status(400).json({ error: "Missing targets inside structural body frames." });
    }

    try {
        const form = new FormData();
        form.append('urls', magnetUrl);
        // Dynamically append the sub-folder path based on the type!
        const targetPath = category === 'series' ? '/downloads/series' : '/downloads';
        form.append('savepath', targetPath);
        form.append('tags', 'movie-streamer'); 

        await axios.post('http://qbittorrent:8080/api/v2/torrents/add', form, {
            headers: form.getHeaders()
        });

        logger.log(`📥 Dispatched [${category || 'movie'}] magnet directly to qBittorrent.`);
        res.status(200).json({ success: true, message: "Queued layout allocation pipeline records." });
    } catch (err) {
        console.error("❌ qBittorrent forward block:", err.message);
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