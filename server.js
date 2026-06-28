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

const app = express();
const PORT = process.env.PORT || 3000;

// 🚨 FIX: Explicitly target the mounted container directory paths directly
const MOVIES_STORAGE_DIR = '/app/storage/movies';
const SERIES_STORAGE_DIR = '/app/storage/series';

// Alias global and process-level flags for legacy module backward compatibility
global.MOVIES_DIR = MOVIES_STORAGE_DIR;
global.SERIES_DIR = SERIES_STORAGE_DIR;
process.env.MOVIES_DIR = MOVIES_STORAGE_DIR;
process.env.SERIES_DIR = SERIES_STORAGE_DIR;

// =========================================================================
// SECURITY & GATEKEEPER ROUTING LAYERS
// =========================================================================
const { requireAuth } = require('./src/middleware/auth'); // Add this import

// Administrative Page Access Gatekeeper (Keep this as-is)
app.use('/admin.html', (req, res, next) => {
    const activeUser = req.cookies?.user_profile;
    if (activeUser && activeUser.toLowerCase().trim() === 'josh') {
        return next();
    }
    return res.redirect('/login.html');
});


// Verify storage paths exist on initialization
if (!fs.existsSync(MOVIES_STORAGE_DIR)) {
    fs.mkdirSync(MOVIES_STORAGE_DIR, { recursive: true });
}
if (!fs.existsSync(SERIES_STORAGE_DIR)) {
    fs.mkdirSync(SERIES_STORAGE_DIR, { recursive: true });
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// =========================================================================
// =========================================================================
// ROUTING TABLES LAYERS
// =========================================================================
const authRouter = require('./src/routes/auth.routes');
const adminRouter = require('./src/routes/admin.routes');
const mediaRouter = require('./src/routes/media.routes');
const torrentRouter = require('./src/routes/torrent.routes');
const profileRouter = require('./src/routes/profile.routes');

// 🔓 ALLOW PUBLIC ACCESS TO LOGIN & REGISTRATION FILES ONLY
app.use('/login.html', express.static(path.join(__dirname, 'public/login.html')));
// If your registration or css/js assets for the login screen are inside public:
app.use('/css', express.static(path.join(__dirname, 'public/css'))); 
app.use('/js', express.static(path.join(__dirname, 'public/js'))); 
app.use('/favicon.ico', express.static(path.join(__dirname, 'public/favicon.ico')));



app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api', mediaRouter); 

// 🔐 THE SECURE BOUNDARY: Protect everything below this line
app.use(requireAuth);

// 📁 CORE STATIC FILE AND STREAMING LAYER (Now safe behind requireAuth)
app.use(express.static(path.join(__dirname, 'public')));

// 🎨 Cover Artwork Mappings
app.use('/movie-assets', express.static(MOVIES_STORAGE_DIR));
app.use('/movie-assets/series', express.static(SERIES_STORAGE_DIR));

// 🎬 Direct Player Media Video Stream Mappings
app.use('/movies', express.static(MOVIES_STORAGE_DIR));
app.use('/series', express.static(SERIES_STORAGE_DIR));

// 💡 MOUNT HERE FOR /api/yts/browse AND /api/eztv/browse
app.use('/api', torrentRouter); 
// 💡 KEEP THIS TOO IF OTHER FILES USE THE /api/torrent PATH
app.use('/api/torrent', torrentRouter); 


app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: "Requested core API coordinate map not found." });
});

// =========================================================================
// STARTUP AGENTS BOOTSTRAP INITIALIZATION
// =========================================================================
LibraryScanner.runLibraryScanSweep().catch(err => console.error(err));
startPipelineWorker(10000);

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 MOVIE STREAMER ENGINE IS NOW LIVE`);
    console.log(`🔊 Listening on internal port: ${PORT}`);
    console.log(`📂 Scanning media collection volumes cleanly.`);
    console.log(`==================================================\n`);
});