// src/routes/admin.routes.js
// Admin management interfaces, real-time log streaming, and manual profile sweeps.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');

const logger = require('../services/logger');
const pipelineOrchestrator = require('../../Orchestrator');
const metadataService = require('../services/MetadataService');

const MOVIES_DIR = process.env.MOVIES_DIR || (fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies');

// =========================================================================
// 🛡️ ADMIN VERIFICATION INTERCEPTOR LAYER
// =========================================================================
function requireAdmin(req, res, next) {
    const activeUser = req.cookies?.user_profile;
    
    if (activeUser && activeUser.toLowerCase().trim() === 'josh') {
        return next();
    }
    
    // Explicitly handle data requests vs standard administrative views
    if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
        return res.status(403).json({ success: false, error: "Access denied. Administrator clearance required." });
    }
    res.redirect('/login.html');
}

// Bind the security wall globally to all routes nested inside this router instance
router.use(requireAdmin);

// =========================================================================
// ENDPOINTS
// =========================================================================

// GET: /api/admin/logs/stream (Server-Sent Events)
router.get('/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); 
    res.flushHeaders();

    if (typeof logger.getHistory === 'function') {
        logger.getHistory().forEach(line => {
            res.write(`data: ${line}\n\n`);
        });
    }
    logger.log('📡 [SSE] Admin log stream initialized. Listening for live updates...', 'info');

    const logListener = (line) => {
        res.write(`data: ${line}\n\n`);
    };
    
    if (logger.logStream) {
        logger.logStream.on('line', logListener);
    }

    const keepAliveInterval = setInterval(() => {
        res.write(': keepalive\n\n'); 
    }, 30000);

    req.on('close', () => {
        clearInterval(keepAliveInterval);
        if (logger.logStream) {
            logger.logStream.off('line', logListener);
        }
    });
});

// POST: /api/admin/sanitizer/run
router.post('/sanitizer/run', (req, res) => {
    res.json({ success: true, message: "Sanitizer execution sequence triggered." });
    
    pipelineOrchestrator.runFullAutomationPipeline("admin_manual_ui")
        .catch(err => logger.log(`Critical background processing fault: ${err.message}`, 'error'));
});

// POST: /api/admin/refetch-metadata
router.post('/refetch-metadata', async (req, res) => {
    try {
        const { folder, contentType, imdbId, title } = req.body;
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Target directory not supplied.' });
        }

        const targetDir = (contentType === 'series') 
            ? path.join(MOVIES_DIR, 'series', folder) 
            : path.join(MOVIES_DIR, folder);

        let queryUrl = `http://www.omdbapi.com/?apikey=84196d01`;
        if (imdbId && imdbId.trim().startsWith('tt')) {
            queryUrl += `&i=${encodeURIComponent(imdbId.trim())}`;
        } else if (title) {
            queryUrl += `&t=${encodeURIComponent(title.trim())}`;
        } else {
            queryUrl += `&t=${encodeURIComponent(folder.replace(/[-_.]/g, ' '))}`;
        }

        const omdbResponse = await axios.get(queryUrl);
        const data = omdbResponse.data;

        if (!data || data.Response === "False") {
            return res.status(404).json({ success: false, error: data.Error || 'No matching titles found inside OMDb library registry.' });
        }

        const normalizedMetadata = {
            title: data.Title || folder.replace(/[-_.]/g, ' '),
            year: data.Year || '',
            genre: data.Genre || 'N/A',
            imdbId: data.imdbID || imdbId || '',
            plot: data.Plot || '',
            contentType: contentType
        };

        await fsPromises.writeFile(path.join(targetDir, 'metadata.json'), JSON.stringify(normalizedMetadata, null, 4), 'utf-8');

        if (data.Poster && data.Poster !== "N/A") {
            try {
                await metadataService.downloadCover(data.Poster, path.join(targetDir, 'cover.jpg'));
                logger.log(`📥 [METADATA REFETCH] Cover artwork downloaded successfully for: ${folder}`);
            } catch (imgErr) {
                logger.log(`⚠️ [METADATA WARN] Failed retrieving art asset: ${imgErr.message}`, 'warn');
            }
        }

        if (global.rebuildLibraryCache && typeof global.rebuildLibraryCache === 'function') {
            global.rebuildLibraryCache();
        }

        res.json({ success: true, metadata: normalizedMetadata });
    } catch (err) {
        logger.log(`❌ [REFETCH FAILURE] Exception dropped: ${err.message}`, 'error');
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/admin/upload-poster
router.post('/upload-poster', async (req, res) => {
    try {
        const { folder, image, contentType } = req.body;
        if (!folder || !image) {
            return res.status(400).json({ success: false, error: 'Missing parameters.' });
        }

        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        const targetDir = (contentType === 'series')
            ? path.join(MOVIES_DIR, 'series', folder)
            : path.join(MOVIES_DIR, folder); 

        try {
            await fsPromises.access(targetDir);
        } catch {
            return res.status(404).json({ success: false, error: 'Target directory not found.' });
        }

        await fsPromises.writeFile(path.join(targetDir, 'cover.jpg'), buffer);
        logger.log(`🎨 [ASSET OVERRIDE] Fresh poster artwork written directly to disk for: ${folder}`);
        
        if (global.rebuildLibraryCache && typeof global.rebuildLibraryCache === 'function') {
            global.rebuildLibraryCache();
        }
        
        res.json({ success: true, message: 'Poster written to disk.' });
    } catch (err) {
        logger.log(`Asset upload exception: ${err.message}`, 'error');
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/library-metadata
router.get('/library-metadata', (req, res) => {
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




// =========================================================================
// QB_TORRENT AUTOMATION TRIGGER ENDPOINT
// =========================================================================
router.post('/api/trigger-automation', (req, res) => {
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

// POST: /api/admin/override-metadata
router.post('/override-metadata', (req, res) => {
    try {
        const { folder, title, year, plot, genre, imdbId, contentType } = req.body;
        
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
        logger.log(`🔧 [ADMIN OVERRIDE] Saved metadata manually for ${contentType}: ${folder}`);
        
        res.json({ success: true, message: "Metadata overrides saved successfully." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/users
router.get('/users', (req, res) => {
    try {
        // Points safely toward your consolidated metadata base folder path
        const userMetaDir = path.join(__dirname, '../../metadata', 'users');
        if (!fs.existsSync(userMetaDir)) return res.json({ success: true, users: [] });

        const profiles = fs.readdirSync(userMetaDir).map(folder => {
            const userPath = path.join(userMetaDir, folder);
            if (!fs.lstatSync(userPath).isDirectory()) return null;

            const hasHistory = fs.existsSync(path.join(userPath, 'history.json'));
            const hasPlayback = fs.existsSync(path.join(userPath, 'playback.json'));
            
            return { username: folder, hasHistory, hasPlayback };
        }).filter(Boolean);

        res.json({ success: true, users: profiles });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;