// src/routes/admin.routes.js
// Admin management interfaces, real-time log streaming, and manual profile sweeps.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');
const { exec } = require('child_process'); // Restored explicit missing shell execution utility
const logger = require('../utils/logger');
//const logger = require('../services/logger'); 
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
const Orchestrator = require('../../Orchestrator'); // Adjust this path to point to your Orchestrator.js
const metadataService = require('../services/MetadataService');

const MOVIES_DIR = process.env.MOVIES_DIR
    || (fs.existsSync('/app/storage/movies') ? '/app/storage/movies'
        : (fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies'));
// 🚨 NEW FIX: Isolated pathway pointing to your separate TV series mount location
const SERIES_DIR = process.env.SERIES_DIR
    || (fs.existsSync('/app/storage/series') ? '/app/storage/series' : '/data/blockchain/media/Series');

const MOVIE_PATH_CANDIDATES = [
    MOVIES_DIR,
    '/home/epic/movies',
    '/app/storage/movies',
    '/app/movies'
].filter((v, i, arr) => v && arr.indexOf(v) === i);

const SERIES_PATH_CANDIDATES = [
    SERIES_DIR,
    '/home/epic/movies/series',
    '/data/blockchain/media/Series',
    '/app/storage/series',
    '/app/series'
].filter((v, i, arr) => v && arr.indexOf(v) === i);

function resolveMovieFolderPath(folderName) {
    const candidates = MOVIE_PATH_CANDIDATES.map(base => path.join(base, folderName));
    return candidates.find(candidate => fs.existsSync(candidate)) || path.join(MOVIES_DIR, folderName);
}

function resolveSeriesFolderPath(folderName) {
    const candidates = SERIES_PATH_CANDIDATES.map(base => path.join(base, folderName));
    return candidates.find(candidate => fs.existsSync(candidate)) || path.join(SERIES_DIR, folderName);
}

function normalizeTagList(value, fallback = []) {
    const source = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(',') : fallback);

    return [...new Set(source.map(tag => String(tag).trim()).filter(Boolean))].sort();
}

function normalizeEnrichment(meta = {}) {
    const rootTags = normalizeTagList(meta.tags || meta.enrichment?.tags || meta.metadata?.tags || meta.genre || meta.metadata?.genre);
    return {
        genre: meta.genre || meta.enrichment?.genre || meta.metadata?.genre || '',
        tags: rootTags,
        imdbScore: meta.imdbScore || meta.imdbRating || meta.rating || meta.enrichment?.imdbScore || meta.metadata?.imdbScore || meta.metadata?.imdbRating || meta.metadata?.rating || '',
        parentalRating: meta.parentalRating || meta.rated || meta.enrichment?.parentalRating || meta.metadata?.parentalRating || meta.metadata?.rated || '',
        popularity: meta.popularity || meta.enrichment?.popularity || meta.metadata?.popularity || '',
        popularitySource: meta.enrichment?.popularitySource || meta.metadata?.enrichment?.popularitySource || ''
    };
}

router.get('/log-stream', (req, res) => {
    // Ensure only authorized admin access configurations proceed here
    res.setHeader('X-Accel-Buffering', 'no'); 
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders(); // Tell Node to establish the channel link immediately

    // Determine the current active log file name matching our DailyRotate setup
    const todayStr = new Date().toISOString().split('T')[0];
    const currentLogFile = path.join(logger.LOG_DIR, `anymovie-${todayStr}.log`);

    // Stream existing historical context data from today's log first
    if (fs.existsSync(currentLogFile)) {
        const stats = fs.statSync(currentLogFile);
        // Read the last 50KB of historical logs so the screen isn't blank on open
        const startBytes = Math.max(0, stats.size - 50000); 
        const stream = fs.createReadStream(currentLogFile, { start: startBytes, encoding: 'utf8' });
        
        stream.on('data', (chunk) => {
            res.write(`data: ${chunk.replace(/\n/g, '\ndata: ')}\n\n`);
        });
    }

    // Watch today's log file for real-time appends
    let watcher;
    if (fs.existsSync(currentLogFile)) {
        let fileSize = fs.statSync(currentLogFile).size;
        
        watcher = fs.watch(currentLogFile, (eventType) => {
            if (eventType === 'change') {
                const stats = fs.statSync(currentLogFile);
                if (stats.size > fileSize) {
                    const stream = fs.createReadStream(currentLogFile, {
                        start: fileSize,
                        end: stats.size,
                        encoding: 'utf8'
                    });
                    stream.on('data', (chunk) => {
                        res.write(`data: ${chunk.replace(/\n/g, '\ndata: ')}\n\n`);
                    });
                    fileSize = stats.size;
                }
            }
        });
    }

    // Clean up connections if the admin closes the tab
    req.on('close', () => {
        if (watcher) watcher.close();
        res.end();
    });
});



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

router.post('/sync-item', async (req, res) => {
    try {
        const { folder, contentType } = req.body || {};
        const summary = await LibraryScanner.runLibraryScanSweep();

        let itemFound = null;
        if (folder) {
            const library = await getLibrary();
            if (contentType === 'series') {
                const expectedId = `series/${encodeURIComponent(folder)}`;
                itemFound = (library.shows || []).some(s => s.id === expectedId || s.id === `series/${folder}`);
            } else {
                const expectedId = encodeURIComponent(folder);
                itemFound = (library.movies || []).some(m => m.id === expectedId);
            }
        }

        return res.json({
            success: true,
            message: 'Library snapshot refreshed from disk.',
            summary,
            itemFound
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Master Server Endpoint
router.get('/v1/connector/bootstrap-bundle', async (req, res) => {
    // Verify tokens here using verifySecureToken...

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=media-assets.zip');

    const archiver = require('archiver'); // Lightweight streaming zip engine
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.pipe(res);
    
    // Only compress tracking configurations, artwork, and text targets
    archive.directory('/app/storage/movies/', false, (entry) => {
        const ext = path.extname(entry.name).toLowerCase();
        // 🛑 ABSOLUTE GATING CRITERIA: Completely skip video rendering tracks
        if (ext === '.mp4' || ext === '.mkv') return false;
        return entry;
    });

    await archive.finalize();
});

router.post('/repair-metadata', async (req, res) => {
    try {
        const { folder, contentType, runCloudSync = true } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const folderPath = contentType === 'series'
            ? path.join(SERIES_DIR, folder)
            : resolveMovieFolderPath(folder);
        const metaFilePath = path.join(folderPath, 'metadata.json');

        if (!fs.existsSync(folderPath)) {
            return res.status(404).json({ success: false, error: 'Target folder not found.' });
        }
        if (!fs.existsSync(metaFilePath)) {
            return res.status(404).json({ success: false, error: 'metadata.json not found.' });
        }

        let metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
        if (!metadata.storage) {
            metadata.storage = { location: 'local', files: {} };
        }
        if (!metadata.storage.files) {
            metadata.storage.files = {};
        }

        const filesOnDisk = fs.readdirSync(folderPath);
        metadata.folderPath = folderPath;
        metadata.folderName = folder;
        const profileMatcher = {
            '1080p': (f) => /\.web\.mp4$/i.test(f) || /1080p/i.test(f),
            '720p': (f) => /720p/i.test(f),
            '480p': (f) => /480p/i.test(f)
        };

        const resolveLocalPath = (profile, existingLocalPath) => {
            if (existingLocalPath && fs.existsSync(path.join(folderPath, existingLocalPath))) {
                return existingLocalPath;
            }

            const preferred = filesOnDisk.find(f => /\.(mp4|mkv|m4v)$/i.test(f) && profileMatcher[profile](f));
            if (preferred) return preferred;

            if (profile === '1080p') {
                const source = filesOnDisk.find(f => f.endsWith('.mp4') && !f.includes('.720p') && !f.includes('.480p'));
                return source || null;
            }

            return null;
        };

        const profiles = ['1080p', '720p', '480p'];
        profiles.forEach(profile => {
            const block = metadata.storage.files[profile] || {};
            const localPath = resolveLocalPath(profile, block.localPath || null);
            const remoteKey = block.remoteKey || null;

            let status = block.status || 'waiting';
            if (remoteKey) {
                status = 'synced';
            } else if (localPath) {
                status = metadata.storage.location === 'remote' ? 'pending' : 'synced';
            } else {
                status = 'waiting';
            }

            metadata.storage.files[profile] = {
                ...block,
                status,
                localPath,
                remoteKey
            };
        });

        fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');

        let cloudSyncTriggered = false;
        if (runCloudSync && metadata.storage.location === 'remote') {
            const hasPendingUpload = profiles.some(profile => metadata.storage.files[profile]?.status === 'pending');
            if (hasPendingUpload) {
                const cloudSyncRes = await axios.post('http://127.0.0.1:5004/process', {
                    folderPath,
                    folderName: folder,
                    contentType: contentType || metadata.contentType || 'movie',
                    forceActualUpload: true
                }, { timeout: 1800000 });

                const patchData = cloudSyncRes.data?.patchData || {};
                metadata = {
                    ...metadata,
                    ...patchData,
                    storage: {
                        ...(metadata.storage || {}),
                        ...(patchData.storage || {}),
                        files: {
                            ...(metadata.storage?.files || {}),
                            ...(patchData.storage?.files || {})
                        }
                    },
                    pipelineState: patchData.pipelineState || metadata.pipelineState
                };

                fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
                cloudSyncTriggered = true;
            }
        }

        await LibraryScanner.runLibraryScanSweep();
        return res.json({
            success: true,
            folder,
            cloudSyncTriggered,
            storage: metadata.storage
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.response?.data?.error || err.message });
    }
});

router.post('/manual-worker-run', async (req, res) => {
    try {
        const { folder, contentType, worker } = req.body || {};
        if (!folder || !worker) {
            return res.status(400).json({ success: false, error: 'Missing folder or worker.' });
        }

        const cleanWorker = String(worker).toUpperCase();
        const workerMap = {
            INGEST: 'http://127.0.0.1:5000/process',
            METADATA: 'http://127.0.0.1:5001/process',
            SUBTITLES: 'http://127.0.0.1:5002/process',
            TRANSCODE: 'http://127.0.0.1:5003/process',
            CLOUDSYNC: 'http://127.0.0.1:5004/process'
        };

        const workerUrl = workerMap[cleanWorker];
        if (!workerUrl) {
            return res.status(400).json({ success: false, error: `Unsupported worker: ${worker}` });
        }

        const folderPath = contentType === 'series'
            ? path.join(SERIES_DIR, folder)
            : resolveMovieFolderPath(folder);
        if (!fs.existsSync(folderPath)) {
            return res.status(404).json({ success: false, error: 'Target folder not found.' });
        }

        let metadata = {};
        const metaFilePath = path.join(folderPath, 'metadata.json');
        if (fs.existsSync(metaFilePath)) {
            try {
                metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
            } catch (_err) {
                metadata = {};
            }
        }

        const payload = {
            folderPath,
            folderName: folder,
            contentType: contentType || metadata.contentType || (folderPath.includes('/series') ? 'series' : 'movie'),
            imdbId: metadata.imdbId || null,
            manualImdbId: metadata.imdbId || null,
            forceActualUpload: cleanWorker === 'CLOUDSYNC'
        };

        const workerResponse = await axios.post(workerUrl, payload, { timeout: 1800000 });

        if (workerResponse?.data?.success === false) {
            return res.status(422).json({
                success: false,
                error: workerResponse.data.error || `${cleanWorker} returned unsuccessful result.`,
                worker: cleanWorker,
                response: workerResponse.data
            });
        }

        await LibraryScanner.runLibraryScanSweep();

        return res.json({
            success: true,
            worker: cleanWorker,
            response: workerResponse.data
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.response?.data?.error || err.message });
    }
});

router.post('/rename-media', async (req, res) => {
    try {
        const { folder, contentType, newFolderName, newFileName } = req.body || {};
        if (!folder) {
            return res.status(400).json({ success: false, error: 'Missing folder.' });
        }

        const hasUnsafePath = (val) => String(val || '').includes('/') || String(val || '').includes('\\');
        if (hasUnsafePath(newFolderName) || hasUnsafePath(newFileName)) {
            return res.status(400).json({ success: false, error: 'Invalid rename value.' });
        }

        const baseDir = contentType === 'series' ? SERIES_DIR : MOVIES_DIR;
        let currentFolderName = folder;
        let currentPath = path.join(baseDir, currentFolderName);

        if (!fs.existsSync(currentPath)) {
            return res.status(404).json({ success: false, error: 'Target folder not found.' });
        }

        if (newFolderName && newFolderName.trim() && newFolderName.trim() !== currentFolderName) {
            const nextFolderName = newFolderName.trim();
            const nextPath = path.join(baseDir, nextFolderName);
            if (fs.existsSync(nextPath)) {
                return res.status(409).json({ success: false, error: 'Destination folder already exists.' });
            }
            await fsPromises.rename(currentPath, nextPath);
            currentFolderName = nextFolderName;
            currentPath = nextPath;
        }

        if (newFileName && newFileName.trim()) {
            const files = fs.readdirSync(currentPath);
            const videoExts = ['.web.mp4', '.mp4', '.mkv', '.m4v', '.avi', '.mov'];

            const sourceFile =
                files.find(f => f.endsWith('.web.mp4')) ||
                files.find(f => videoExts.some(ext => f.toLowerCase().endsWith(ext)));

            if (sourceFile) {
                const sourceExt = path.extname(sourceFile);
                const rawTarget = newFileName.trim();
                const targetFileName = path.extname(rawTarget) ? rawTarget : `${rawTarget}${sourceExt}`;

                if (targetFileName !== sourceFile) {
                    const sourcePath = path.join(currentPath, sourceFile);
                    const targetPath = path.join(currentPath, targetFileName);
                    if (fs.existsSync(targetPath)) {
                        return res.status(409).json({ success: false, error: 'Destination file already exists.' });
                    }
                    await fsPromises.rename(sourcePath, targetPath);
                }
            }
        }

        const metaFilePath = path.join(currentPath, 'metadata.json');
        if (fs.existsSync(metaFilePath)) {
            try {
                const metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
                metadata.folderName = currentFolderName;
                metadata.folderPath = currentPath;
                metadata.pipelineState = metadata.pipelineState || {};
                metadata.pipelineState.lastUpdated = new Date().toISOString();
                fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
            } catch (_err) {
                // Best-effort metadata patch only.
            }
        }

        await LibraryScanner.runLibraryScanSweep();
        return res.json({ success: true, folder: currentFolderName });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST: /api/admin/sanitizer/run
router.post('/sanitizer/run', (req, res) => {
    res.json({ success: true, message: "Sanitizer execution sequence triggered." });
    
    pipelineOrchestrator.runFullAutomationPipeline("admin_manual_ui")
        .catch(err => logger.error(`Critical background processing fault: ${err.message}`));
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
        logger.info(`🎨 [ASSET OVERRIDE] Fresh poster artwork written directly to disk for: ${folder}`);
        
        // 🚨 FIX 4: Fire background db refresh instead of relying on broken global function hooks
        LibraryScanner.runLibraryScanSweep()
            .catch(err => logger.error(`Error running library sweep: ${err.message}`));
        
        res.json({ success: true, message: 'Poster written to disk.' });
    } catch (err) {
        logger.error(`Asset upload exception: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/admin/library-metadata
router.get('/library-metadata', async (req, res) => {
    try {
        const library = await getLibrary();

        const normalizeStorageFiles = (files = {}) => {
            const out = {};
            Object.keys(files || {}).sort().forEach(profile => {
                const block = files[profile] || {};
                out[profile] = {
                    status: block.status || '',
                    localPath: block.localPath || '',
                    remoteKey: block.remoteKey || ''
                };
            });
            return out;
        };

        const normalizeComparable = (meta = {}) => ({
            title: meta.title || '',
            year: meta.year || '',
            imdbId: meta.imdbId || meta.imdb_id || '',
            plot: meta.plot || '',
            genre: meta.genre || '',
            enrichment: normalizeEnrichment(meta),
            storageLocation: meta.storage?.location || 'local',
            storageFiles: normalizeStorageFiles(meta.storage?.files || {})
        });

        const buildItem = (folder, redisMeta, type) => {
            const resolvedFolderPath = type === 'series'
                ? resolveSeriesFolderPath(folder)
                : resolveMovieFolderPath(folder);
            const diskMetaPath = path.join(resolvedFolderPath, 'metadata.json');

            let diskMeta = null;
            if (fs.existsSync(diskMetaPath)) {
                try {
                    diskMeta = JSON.parse(fs.readFileSync(diskMetaPath, 'utf-8'));
                } catch (_err) {
                    diskMeta = null;
                }
            }

            const redisComparable = normalizeComparable(redisMeta || {});
            const diskComparable = normalizeComparable(diskMeta || {});
            const inSync = JSON.stringify(redisComparable) === JSON.stringify(diskComparable);

            return {
                folder,
                metadata: diskMeta || redisMeta,
                redisMetadata: redisMeta,
                diskMetadata: diskMeta,
                resolvedDiskPath: fs.existsSync(resolvedFolderPath) ? resolvedFolderPath : null,
                syncState: {
                    inSync,
                    redisAvailable: Boolean(redisMeta),
                    diskAvailable: Boolean(diskMeta),
                    redisStorageLocation: redisComparable.storageLocation,
                    diskStorageLocation: diskComparable.storageLocation,
                    mismatchNote: diskMeta ? '' : `Disk metadata not found at ${diskMetaPath}`
                }
            };
        };
        
        const results = {
            movies: (library.movies || []).map(m => buildItem(decodeURIComponent(m.id), m, 'movie')),
            shows: (library.shows || []).map(s => buildItem(s.id.replace('series/', ''), s, 'series'))
        };

        res.json({ success: true, library: results });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// QB_TORRENT / UI PANEL AUTOMATION TRIGGER ENDPOINT
// =========================================================================

router.post('/trigger-automation', async (req, res) => {
    // Instantly return a clean status code to the qBittorrent client agent
    res.status(202).send('Automation trigger received. Processing pool in background.');
    console.log(`\n⚡ qBittorrent completion trigger received! Invoking unified Orchestrator loop...`);

    try {
        // Run the real, modern pipeline with managed concurrency bounds safely
        await pipelineOrchestrator.runFullAutomationPipeline("qbittorrent_webhook");
        console.log(`✅ Automated background library sync completed flawlessly.`);
    } catch (err) {
        console.error(`❌ Automated orchestration cycle block exception:`, err.message);
    }
});

// =========================================================================
// ✍️ ENDPOINT 1: OVERRIDE METADATA (DASHBOARD PANEL SAVES)
// =========================================================================
router.post('/override-metadata', async (req, res) => {
    const { folder, contentType, title, year, imdbId, plot, genre, storage, tags, imdbScore, parentalRating, popularity, enrichment } = req.body;
    
    // Ensure custom dashboard panel modifications write metadata out to the true folder mounts
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
            metadata.genre = genre || metadata.genre || '';
        } else {
            metadata.metadata = { ...metadata.metadata, title, year, imdbId, plot, genre: genre || metadata.metadata.genre || '' };
            // Mirror back to root level to avoid background component blindness
            metadata.title = title;
            metadata.year = year;
            metadata.imdbId = imdbId;
            metadata.plot = plot;
            metadata.genre = genre || metadata.genre || metadata.metadata.genre || '';
        }

        const nextEnrichment = {
            ...normalizeEnrichment(metadata),
            ...normalizeEnrichment(enrichment || {}),
            tags: normalizeTagList(
                tags !== undefined ? tags : (enrichment?.tags !== undefined ? enrichment.tags : metadata.tags || metadata.enrichment?.tags)
            ),
            genre: enrichment?.genre || metadata.genre || metadata.metadata?.genre || metadata.enrichment?.genre || '',
            imdbScore: imdbScore || enrichment?.imdbScore || metadata.imdbScore || metadata.rating || metadata.enrichment?.imdbScore || 'N/A',
            parentalRating: parentalRating || enrichment?.parentalRating || metadata.parentalRating || metadata.enrichment?.parentalRating || 'N/A',
            popularity: popularity || enrichment?.popularity || metadata.popularity || metadata.enrichment?.popularity || 'N/A'
        };

        metadata.tags = nextEnrichment.tags;
        metadata.genre = nextEnrichment.genre || metadata.genre || '';
        metadata.imdbScore = nextEnrichment.imdbScore;
        metadata.parentalRating = nextEnrichment.parentalRating;
        metadata.popularity = nextEnrichment.popularity;
        metadata.enrichment = nextEnrichment;
        if (metadata.metadata) {
            metadata.metadata.genre = nextEnrichment.genre || metadata.metadata.genre || '';
            metadata.metadata.tags = nextEnrichment.tags;
            metadata.metadata.imdbScore = nextEnrichment.imdbScore;
            metadata.metadata.parentalRating = nextEnrichment.parentalRating;
            metadata.metadata.popularity = nextEnrichment.popularity;
            metadata.metadata.enrichment = nextEnrichment;
        }

        let triggerCloudSync = false;
        const mergeStorage = (existingStorage = {}, incomingStorage = {}) => ({
            ...existingStorage,
            ...incomingStorage,
            files: {
                ...(existingStorage.files || {}),
                ...(incomingStorage.files || {})
            }
        });

        const filesOnDisk = fs.existsSync(folderPath) ? fs.readdirSync(folderPath) : [];
        const findLocalProfileFile = (profile) => {
            const suffix = profile === '1080p' ? '.web.mp4' : `.${profile}.mp4`;
            return filesOnDisk.find(f => f.endsWith(suffix)) || null;
        };

        if (storage && storage.location === 'remote') {
            if (!metadata.storage) {
                metadata.storage = { location: 'local', files: {} };
            }

            metadata.storage.location = 'remote';

            const profiles = ['1080p', '720p', '480p'];
            if (!metadata.storage.files) metadata.storage.files = {};

            profiles.forEach(profile => {
                const existingBlock = metadata.storage.files[profile] || {};
                const existingLocalPath = existingBlock.localPath && fs.existsSync(path.join(folderPath, existingBlock.localPath))
                    ? existingBlock.localPath
                    : null;
                const inferredLocalPath = existingLocalPath || findLocalProfileFile(profile);

                if (existingBlock.status !== 'synced' && inferredLocalPath) {
                    metadata.storage.files[profile] = {
                        ...existingBlock,
                        status: 'pending',
                        localPath: inferredLocalPath,
                        remoteKey: existingBlock.remoteKey || null
                    };
                    triggerCloudSync = true;
                } else if (existingBlock.status !== 'synced') {
                    metadata.storage.files[profile] = {
                        ...existingBlock,
                        status: 'waiting',
                        localPath: inferredLocalPath || null,
                        remoteKey: existingBlock.remoteKey || null
                    };
                }
            });
        } else if (storage) {
            // Local storage option chosen (NVMe Local)
            metadata.storage = { location: 'local', files: {} };

            // 🎯 THE FIX: Force short-circuiting out of the pipeline processing loop
            if (!metadata.pipelineState) metadata.pipelineState = {};
            if (metadata.pipelineState.currentStep === 'UPLOAD') {
                logger.info(`💾 [Admin Override] Local NVMe allocation set for [${folder}]. Short-circuiting UPLOAD state to COMPLETED.`);
                metadata.pipelineState.currentStep = 'COMPLETED';
                metadata.pipelineState.lastUpdated = new Date().toISOString();
                metadata.pipelineState.error = null;
            }
        }

        fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');

        if (triggerCloudSync) {
            logger.info(`📡 [Orchestrator Bridge] Allocation changed to Cloud for [${folder}]. Triggering CloudSync Worker on port 5004...`);

            const cloudSyncRes = await axios.post('http://127.0.0.1:5004/process', {
                folderPath: folderPath,
                folderName: folder,
                forceActualUpload: true
            }, { timeout: 1800000 }).catch(err => {
                logger.error(`❌ [Orchestrator Bridge] Failed to wake CloudSync Worker at endpoint: ${err.message}`);
                throw err;
            });

            const patchData = cloudSyncRes.data?.patchData || {};
            metadata = {
                ...metadata,
                ...patchData,
                storage: mergeStorage(metadata.storage, patchData.storage || {}),
                pipelineState: patchData.pipelineState || metadata.pipelineState
            };

            fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
        }

        // Refresh database record tracking arrays automatically
        await LibraryScanner.runLibraryScanSweep();

        return res.json({ success: true, libraryLocation: metadata.storage.location });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// =========================================================================
// 🔄 ENDPOINT 2: REFETCH METADATA (OMDb THIRD-PARTY SYNCHRONIZATION)
// =========================================================================
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
        const cleanTitle = data.Title || folder.replace(/[-_.]/g, ' ');

        // Construct baseline flat map fields securely
        const normalizedMetadata = {
            ...existingMeta, // Retain underlying storage/file status states safely
            title: cleanTitle,
            year: data.Year || '',
            genre: data.Genre || 'N/A',
            tags: normalizeTagList(data.Genre || 'N/A'),
            imdbScore: data.imdbRating || 'N/A',
            parentalRating: data.Rated || 'N/A',
            popularity: data.imdbVotes || 'N/A',
            imdbId: finalImdbId,
            imdb_id: finalImdbId, // ✨ Map snake_case to preserve frontend input bindings
            plot: data.Plot || '',
            contentType: contentType
        };

        // 🎯 THE FIX: Keep nested structure perfectly mirrored so UI views and background processes are completely unified
        normalizedMetadata.metadata = {
            ...(existingMeta.metadata || {}),
            title: cleanTitle,
            year: data.Year || '',
            genre: data.Genre || 'N/A',
            tags: normalizeTagList(data.Genre || 'N/A'),
            imdbScore: data.imdbRating || 'N/A',
            parentalRating: data.Rated || 'N/A',
            popularity: data.imdbVotes || 'N/A',
            imdbId: finalImdbId,
            imdb_id: finalImdbId,
            plot: data.Plot || '',
            enrichment: {
                genre: data.Genre || 'N/A',
                tags: normalizeTagList(data.Genre || 'N/A'),
                imdbScore: data.imdbRating || 'N/A',
                parentalRating: data.Rated || 'N/A',
                popularity: data.imdbVotes || 'N/A',
                popularitySource: data.imdbVotes ? 'imdbVotes' : 'unknown'
            }
        };

        // Prevent structural dropouts on pipeline state properties
        if (!normalizedMetadata.pipelineState) {
            normalizedMetadata.pipelineState = existingMeta.pipelineState || { 
                currentStep: 'COMPLETED', 
                lastUpdated: new Date().toISOString(), 
                error: null 
            };
        }

        await fsPromises.writeFile(metaFilePath, JSON.stringify(normalizedMetadata, null, 4), 'utf-8');

        if (data.Poster && data.Poster !== "N/A") {
            try {
                await metadataService.downloadCover(data.Poster, path.join(targetDir, 'cover.jpg'));
                logger.info(`📥 [METADATA REFETCH] Cover artwork downloaded successfully for: ${folder}`);
            } catch (imgErr) {
                logger.warn(`⚠️ [METADATA WARN] Failed retrieving art asset: ${imgErr.message}`);
            }
        }

        // Fire background DB sync loop cleanly
        await LibraryScanner.runLibraryScanSweep();

        res.json({ success: true, metadata: normalizedMetadata });
    } catch (err) {
        logger.error(`❌ [REFETCH FAILURE] Exception dropped: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
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