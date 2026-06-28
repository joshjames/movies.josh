// src/routes/admin.routes.js
// Admin management interfaces, real-time log streaming, and manual profile sweeps.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');
const { exec } = require('child_process'); // Restored explicit missing shell execution utility

const logger = require('../services/logger'); 
const { getLibrary, connectDb } = require('../services/db'); // 🚨 NEW FIX: Import Redis engine utilities
// 🚨 NEW FIX: Require your unified pipeline background engine scanner
const LibraryScanner = require('../services/LibraryScanner'); 

// Route map to local worker microservices ports running in the container
const WORKER_PORTS = {
    orchestrator: 3000,
    sanitizer: 5000,
    metadata: 5001,
    subtitle: 5002,
    transcoder: 5003,
    cloudsync: 5004
};

const pipelineOrchestrator = require('../../Orchestrator');
const metadataService = require('../services/MetadataService');

const MOVIES_DIR = process.env.MOVIES_DIR || (fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies');
// 🚨 NEW FIX: Isolated pathway pointing to your separate TV series mount location
const SERIES_DIR = process.env.SERIES_DIR || '/data/blockchain/media/Series';

// =========================================================================
// 🛡️ ADMIN VERIFICATION INTERCEPTOR LAYER
// =========================================================================
function requireAdmin(req, res, next) {
    const activeUser = req.cookies?.user_profile;
    
    if (activeUser && activeUser.toLowerCase().trim() === 'josh') {
        return next();
    }
    
    if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
        return res.status(403).json({ success: false, error: "Access denied. Administrator clearance required." });
    }
    res.redirect('/login.html');
}

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

router.get('/health-check/:service', async (req, res) => {
    const serviceName = req.params.service;
    const port = WORKER_PORTS[serviceName];
    
    if (!port) return res.status(404).json({ alive: false });
    
    try {
        await axios.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 });
        return res.json({ alive: true });
    } catch (e) {
        if (e.code !== 'ECONNREFUSED') {
            return res.json({ alive: true });
        }
        return res.status(503).json({ alive: false, error: 'ECONNREFUSED' });
    }
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
            ? path.join(SERIES_DIR, folder) 
            : path.join(MOVIES_DIR, folder);

        const metaFilePath = path.join(targetDir, 'metadata.json');

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

        // Read the file context if it already exists to avoid smashing your storage sync metrics
        let existingMeta = {};
        if (fs.existsSync(metaFilePath)) {
            try {
                existingMeta = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
            } catch (pErr) {
                existingMeta = {};
            }
        }

        // Ensure both camelCase and snake_case variations are stored identically
        const finalImdbId = data.imdbID || imdbId || '';

        const normalizedMetadata = {
            ...existingMeta, // Retain underlying storage/file status states safely
            title: data.Title || folder.replace(/[-_.]/g, ' '),
            year: data.Year || '',
            genre: data.Genre || 'N/A',
            imdbId: finalImdbId,
            imdb_id: finalImdbId, // ✨ Map snake_case to preserve frontend input bindings
            plot: data.Plot || '',
            contentType: contentType
        };

        // If your database scanner expects an implicit wrapper, bridge the object structure 
        if (existingMeta.metadata) {
            normalizedMetadata.metadata = {
                ...existingMeta.metadata,
                title: data.Title || folder.replace(/[-_.]/g, ' '),
                year: data.Year || '',
                imdbId: finalImdbId,
                imdb_id: finalImdbId,
                plot: data.Plot || ''
            };
        }

        await fsPromises.writeFile(metaFilePath, JSON.stringify(normalizedMetadata, null, 4), 'utf-8');

        if (data.Poster && data.Poster !== "N/A") {
            try {
                await metadataService.downloadCover(data.Poster, path.join(targetDir, 'cover.jpg'));
                logger.log(`📥 [METADATA REFETCH] Cover artwork downloaded successfully for: ${folder}`);
            } catch (imgErr) {
                logger.log(`⚠️ [METADATA WARN] Failed retrieving art asset: ${imgErr.message}`, 'warn');
            }
        }

        // Fire background DB sync loop cleanly
        await LibraryScanner.runLibraryScanSweep();

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

        // 🚨 FIX 3: Point poster uploads to correct directory mount if it is a show
        const targetDir = (contentType === 'series')
            ? path.join(SERIES_DIR, folder)
            : path.join(MOVIES_DIR, folder); 

        try {
            await fsPromises.access(targetDir);
        } catch {
            return res.status(404).json({ success: false, error: 'Target directory not found.' });
        }

        await fsPromises.writeFile(path.join(targetDir, 'cover.jpg'), buffer);
        logger.log(`🎨 [ASSET OVERRIDE] Fresh poster artwork written directly to disk for: ${folder}`);
        
        // 🚨 FIX 4: Fire background db refresh instead of relying on broken global function hooks
        LibraryScanner.runLibraryScanSweep()
            .catch(err => logger.log(`Error running library sweep: ${err.message}`, 'error'));
        
        res.json({ success: true, message: 'Poster written to disk.' });
    } catch (err) {
        logger.log(`Asset upload exception: ${err.message}`, 'error');
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/library-metadata
router.get('/library-metadata', async (req, res) => {
    try {
        // 🚨 FIX 5: Completely rewrite this endpoint to return high-speed structured metadata from 
        // Redis instead of locking the thread by re-reading thousands of files on disk raw.
        const library = await getLibrary();
        
        const results = {
            movies: (library.movies || []).map(m => ({ folder: decodeURIComponent(m.id), metadata: m })),
            shows: (library.shows || []).map(s => ({ folder: s.id.replace('series/', ''), metadata: s }))
        };

        res.json({ success: true, library: results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// QB_TORRENT AUTOMATION TRIGGER ENDPOINT
// =========================================================================
router.post('/trigger-automation', (req, res) => {
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

router.post('/override-metadata', async (req, res) => {
    const { folder, contentType, title, year, imdbId, plot, storage } = req.body;
    
    // 🚨 FIX 6: Ensure custom dashboard panel modifications write metadata out to the true folder mounts
    const baseDir = contentType === 'series' ? SERIES_DIR : MOVIES_DIR;
    const folderPath = path.join(baseDir, folder);
    const metaFilePath = path.join(folderPath, 'metadata.json');

    try {
        if (!fs.existsSync(metaFilePath)) {
            return res.status(404).json({ success: false, error: "metadata.json manifest missing on disk." });
        }

        let metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));

        // Handle both raw metadata blocks and standard flattened mappings gracefully
        if (!metadata.metadata) {
            metadata.title = title;
            metadata.year = year;
            metadata.imdbId = imdbId;
            metadata.plot = plot;
        } else {
            metadata.metadata = { ...metadata.metadata, title, year, imdbId, plot };
        }

        let triggerCloudSync = false;

        if (storage && storage.location === 'remote') {
            if (!metadata.storage) {
                metadata.storage = { location: 'local', files: {} };
            }

            if (metadata.storage.location !== 'remote') {
                metadata.storage.location = 'remote';
                
                const profiles = ['1080p', '720p', '480p'];
                if (!metadata.storage.files) metadata.storage.files = {};

                profiles.forEach(profile => {
                    if (!metadata.storage.files[profile]) {
                        metadata.storage.files[profile] = {};
                    }
                    if (metadata.storage.files[profile].status !== 'synced') {
                        metadata.storage.files[profile].status = 'pending';
                        triggerCloudSync = true;
                    }
                });
            }
        } else if (storage) {
            metadata.storage = { location: 'local', files: {} };
        }

        fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');

        // Refresh database record tracking arrays automatically
        await LibraryScanner.runLibraryScanSweep();

        if (triggerCloudSync) {
            logger.log(`📡 [Orchestrator Bridge] Allocation changed to Cloud for [${folder}]. Triggering CloudSync Worker on port 5003...`);
            
            axios.post('http://127.0.0.1:5003/process', {
                folderPath: folderPath,
                folderName: folder
            }).catch(err => {
                logger.log(`❌ [Orchestrator Bridge] Failed to wake CloudSync Worker at endpoint: ${err.message}`);
            });
        }

        return res.json({ success: true, libraryLocation: metadata.storage.location });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/users
router.get('/users', (req, res) => {
    try {
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