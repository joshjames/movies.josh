// ~/movie-streamer/server.js
console.log("!!! SERVER IS CURRENTLY INITIALIZING !!!");

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');

// All relative imports now explicitly point down into the src/ directory tree
const logger = require('./src/services/logger');
const { rebuildLibraryCache } = require('./src/services/CacheWorker');
const { startPipelineWorker } = require('./src/services/workers/PipelineWorker');

const app = express();
const PORT = process.env.PORT || 3000;
const MOVIES_DIR = process.env.MOVIES_DIR || path.join(__dirname, 'movies');

if (!fs.existsSync(MOVIES_DIR)) {
    fs.mkdirSync(MOVIES_DIR, { recursive: true });
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// =========================================================================
// ROUTING TABLES LAYERS
// =========================================================================
const authRouter = require('./src/routes/auth.routes');
const adminRouter = require('./src/routes/admin.routes');
const mediaRouter = require('./src/routes/media.routes');
const torrentRouter = require('./src/routes/torrent.routes');
const profileRouter = require('./src/routes/profile.routes');

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api', mediaRouter); 
app.use('/api/torrent', torrentRouter);
app.use('/api/profile', profileRouter);

// Administrative Page Access Gatekeeper
app.use('/admin.html', (req, res, next) => {
    const activeUser = req.cookies?.user_profile;
    if (activeUser && activeUser.toLowerCase().trim() === 'josh') {
        return next();
    }
    return res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/movie-assets', express.static(MOVIES_DIR));

app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: "Requested core API coordinate map not found." });
});

// =========================================================================
// STARTUP AGENTS BOOTSTRAP INITIALIZATION
// =========================================================================
rebuildLibraryCache();
startPipelineWorker(10000);

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 MOVIE STREAMER ENGINE IS NOW LIVE`);
    console.log(`🔊 Listening on internal port: ${PORT}`);
    console.log(`📂 Scanning library at: ${MOVIES_DIR}`);
    console.log(`==================================================\n`);
});