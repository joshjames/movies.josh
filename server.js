// ~/movie-streamer/server.js
console.log("!!! SERVER IS CURRENTLY INITIALIZING !!!");

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');

// All relative imports explicitly point down into the src/ directory tree
const logger = require('./src/services/logger');
const LibraryScanner = require('./src/services/LibraryScanner');
const { startPipelineWorker } = require('./src/services/workers/PipelineWorker');
const { initRedis } = require('./src/services/PipelineQueueService');

const app = express();
const PORT = process.env.PORT || 3000;

//allow webhook requests from Square to reach our server without CORS issues
//or authentication, since they are coming from Square's servers
const webhookRouter = require('./src/routes/webhook.routes');

app.use('/api/webhooks', webhookRouter);

// 🚨 CONTAINER MOUNT DIRECTORY MAPS
const MOVIES_STORAGE_DIR = '/app/storage/movies';
const SERIES_STORAGE_DIR = '/app/storage/series';

// Alias global and process-level flags for legacy module backward compatibility
global.MOVIES_DIR = MOVIES_STORAGE_DIR;
global.SERIES_DIR = SERIES_STORAGE_DIR;
process.env.MOVIES_DIR = MOVIES_STORAGE_DIR;
process.env.SERIES_DIR = SERIES_STORAGE_DIR;

// Verify storage paths exist on initialization
if (!fs.existsSync(MOVIES_STORAGE_DIR)) {
    fs.mkdirSync(MOVIES_STORAGE_DIR, { recursive: true });
}
if (!fs.existsSync(SERIES_STORAGE_DIR)) {
    fs.mkdirSync(SERIES_STORAGE_DIR, { recursive: true });
}

// =========================================================================
// 🌐 GLOBAL CORE MIDDLEWARE STACK (Must come first to parse cookies & bodies)
// =========================================================================
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));

// =========================================================================
// 🔓 PUBLIC ACCESS LAYER & AUTH EXEMPTIONS
// =========================================================================
app.use('/login.html', express.static(path.join(__dirname, 'public/login.html')));
app.use('/css', express.static(path.join(__dirname, 'public/css'))); 
app.use('/js', express.static(path.join(__dirname, 'public/js'))); 
app.use('/favicon.ico', express.static(path.join(__dirname, 'public/favicon.ico')));

const authRouter = require('./src/routes/auth.routes');
app.use('/api/auth', authRouter);

// =========================================================================
// 🛡️ ADMINISTRATIVE ACCESS GATEKEEPER (Terminal Route Execution)
// =========================================================================
app.get('/admin.html', (req, res) => {
    const activeUser = req.cookies?.user_profile;
    if (activeUser && activeUser.toLowerCase().trim() === 'josh') {
        return res.sendFile(path.join(__dirname, 'public/admin.html'));
    }
    return res.redirect('/login.html');
});

// =========================================================================
// 🔐 THE SECURE BOUNDARY: Protect everything below this line
// =========================================================================
const { requireAuth } = require('./src/middleware/auth');
app.use(requireAuth);

// 📁 CORE STATIC FILE AND STREAMING LAYER (Safe behind requireAuth)
app.use(express.static(path.join(__dirname, 'public')));

// 🎨 Cover Artwork Mappings
app.use('/movie-assets', express.static(MOVIES_STORAGE_DIR));
app.use('/movie-assets/series', express.static(SERIES_STORAGE_DIR));

// 🎬 Direct Player Media Video Stream Mappings
app.use('/movies', express.static(MOVIES_STORAGE_DIR));
app.use('/series', express.static(SERIES_STORAGE_DIR));

// =========================================================================
// 🔌 ROUTING TABLES LAYERS
// =========================================================================
const adminRouter = require('./src/routes/admin.routes');
const mediaRouter = require('./src/routes/media.routes');
const torrentRouter = require('./src/routes/torrent.routes');
const profileRouter = require('./src/routes/profile.routes');
const subtitleRouter = require('./src/routes/subtitle.routes');
const accountRouter = require('./src/routes/account.routes');




app.use('/api/account', accountRouter);
app.use('/api/admin', adminRouter);
app.use('/api', mediaRouter); 
app.use('/api', torrentRouter); 
app.use('/api/torrent', torrentRouter); 
app.use('/api/profile', profileRouter);
app.use('/api', subtitleRouter);

app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: "Requested core API coordinate map not found." });
});

// =========================================================================
// 🚀 STARTUP AGENTS BOOTSTRAP INITIALIZATION
// =========================================================================
(async () => {
    // Attempt Redis connection (optional, non-blocking)
    await initRedis().catch(err => logger.debug(`Queue initialization note: ${err.message}`));

    try {
        await LibraryScanner.runLibraryScanSweep();
        logger.info('Library snapshot initialized at startup.');
    } catch (scanErr) {
        logger.warn(`Initial library scan failed: ${scanErr.message}`);
    }

    const LIBRARY_SCAN_INTERVAL_MS = parseInt(process.env.LIBRARY_SCAN_INTERVAL_MS || '300000', 10);
    setInterval(() => {
        LibraryScanner.runLibraryScanSweep().catch(err => logger.warn(`Scheduled library scan failed: ${err.message}`));
    }, LIBRARY_SCAN_INTERVAL_MS);
    
    logger.info('Queue-driven pipeline active; waiting for torrent completion events.');
    startPipelineWorker(10000);
})();

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 MOVIE STREAMER ENGINE IS NOW LIVE`);
    console.log(`🔊 Listening on internal port: ${PORT}`);
    console.log(`📂 Scanning media collection volumes cleanly.`);
    console.log(`==================================================\n`);
});