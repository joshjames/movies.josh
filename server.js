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
const { startPipelineWorker, reconcileQueueStartupState } = require('./src/services/workers/PipelineWorker');
const { initRedis } = require('./src/services/PipelineQueueService');
const ProfileService = require('./src/services/ProfileService');

const app = express();
const PORT = process.env.PORT || 3000;
const ENABLE_PIPELINE_WATCHER = !['false', '0', 'no'].includes(String(process.env.ENABLE_PIPELINE_WATCHER || 'true').trim().toLowerCase());
const ENABLE_LIBRARY_AUTOSCAN = !['false', '0', 'no'].includes(String(process.env.ENABLE_LIBRARY_AUTOSCAN || 'true').trim().toLowerCase());
const SESSION_ACTIVITY_WINDOW_MS = Number(process.env.SESSION_ACTIVITY_WINDOW_MS || 15 * 60 * 1000);

const SERVER_STARTED_AT_MS = Date.now();
const BUILD_VERSION = String(process.env.APP_BUILD_VERSION || process.env.IMAGE_TAG || 'dev').trim();
const DEPLOYED_AT = String(process.env.APP_DEPLOYED_AT || new Date(SERVER_STARTED_AT_MS).toISOString()).trim();
const METRICS_TOKEN = String(process.env.METRICS_TOKEN || '').trim();
const requestMetrics = {
    totalRequests: 0,
    activeRequests: 0,
    totalErrors: 0,
    byMethod: Object.create(null),
    byStatusClass: {
        '2xx': 0,
        '3xx': 0,
        '4xx': 0,
        '5xx': 0,
        other: 0
    }
};
const sessionActivity = new Map();
let lastSessionCleanupAt = Date.now();

function classifyStatus(statusCode) {
    const status = Number(statusCode);
    if (status >= 200 && status < 300) return '2xx';
    if (status >= 300 && status < 400) return '3xx';
    if (status >= 400 && status < 500) return '4xx';
    if (status >= 500 && status < 600) return '5xx';
    return 'other';
}

function normalizeActiveUser(value) {
    return String(value || '').trim().toLowerCase();
}

function pruneSessionActivity(nowMs) {
    if (nowMs - lastSessionCleanupAt < 60 * 1000) return;
    const cutoff = nowMs - SESSION_ACTIVITY_WINDOW_MS;
    for (const [userKey, state] of sessionActivity.entries()) {
        if (!state || Number(state.lastSeenAt || 0) < cutoff) {
            sessionActivity.delete(userKey);
        }
    }
    lastSessionCleanupAt = nowMs;
}

function buildSessionMetrics() {
    const nowMs = Date.now();
    const cutoff = nowMs - SESSION_ACTIVITY_WINDOW_MS;
    const activeUsers = [];

    for (const [userKey, state] of sessionActivity.entries()) {
        if (!state) continue;
        if (Number(state.lastSeenAt || 0) < cutoff) continue;
        activeUsers.push({
            user: userKey,
            lastSeenAt: new Date(state.lastSeenAt).toISOString(),
            requestCount: Number(state.requestCount || 0)
        });
    }

    activeUsers.sort((a, b) => {
        const lhs = Date.parse(b.lastSeenAt);
        const rhs = Date.parse(a.lastSeenAt);
        return lhs - rhs;
    });

    return {
        windowMinutes: Math.max(1, Math.round(SESSION_ACTIVITY_WINDOW_MS / 60000)),
        activeUserCount: activeUsers.length,
        activeUsers
    };
}

//allow webhook requests from Square to reach our server without CORS issues
//or authentication, since they are coming from Square's servers
const webhookRouter = require('./src/routes/webhook.routes');

app.use('/api/webhooks', webhookRouter);

// 🚨 CONTAINER MOUNT DIRECTORY MAPS
const MOVIES_STORAGE_DIR = process.env.MOVIES_DIR || '/app/storage/movies';
const SERIES_STORAGE_DIR = process.env.SERIES_DIR || '/app/storage/series';

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

app.use((req, res, next) => {
    const nowMs = Date.now();
    pruneSessionActivity(nowMs);

    requestMetrics.totalRequests += 1;
    requestMetrics.activeRequests += 1;
    const method = String(req.method || 'UNKNOWN').toUpperCase();
    requestMetrics.byMethod[method] = (requestMetrics.byMethod[method] || 0) + 1;

    const activeUser = normalizeActiveUser(req.cookies?.user_profile);
    if (activeUser) {
        const prev = sessionActivity.get(activeUser) || { firstSeenAt: nowMs, requestCount: 0, lastSeenAt: nowMs };
        prev.lastSeenAt = nowMs;
        prev.requestCount = Number(prev.requestCount || 0) + 1;
        sessionActivity.set(activeUser, prev);
    }

    res.on('finish', () => {
        requestMetrics.activeRequests = Math.max(0, requestMetrics.activeRequests - 1);
        const bucket = classifyStatus(res.statusCode);
        requestMetrics.byStatusClass[bucket] = (requestMetrics.byStatusClass[bucket] || 0) + 1;
        if (res.statusCode >= 500) {
            requestMetrics.totalErrors += 1;
        }
    });

    res.on('close', () => {
        requestMetrics.activeRequests = Math.max(0, requestMetrics.activeRequests - 1);
    });

    next();
});

app.get('/api/runtime/health', (_req, res) => {
    return res.json({
        success: true,
        status: 'ok',
        service: 'movie-streamer',
        version: BUILD_VERSION,
        deployedAt: DEPLOYED_AT,
        uptimeSec: Math.floor(process.uptime())
    });
});

app.get('/api/runtime/version', (_req, res) => {
    return res.json({
        success: true,
        version: BUILD_VERSION,
        deployedAt: DEPLOYED_AT,
        startedAt: new Date(SERVER_STARTED_AT_MS).toISOString(),
        node: process.version,
        pid: process.pid
    });
});

app.get('/api/runtime/metrics', (req, res) => {
    if (METRICS_TOKEN) {
        const supplied = String(req.query?.token || req.headers['x-metrics-token'] || '').trim();
        if (!supplied || supplied !== METRICS_TOKEN) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
    }

    return res.json({
        success: true,
        service: 'movie-streamer',
        version: BUILD_VERSION,
        deployedAt: DEPLOYED_AT,
        startedAt: new Date(SERVER_STARTED_AT_MS).toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        requestMetrics,
        sessionMetrics: buildSessionMetrics()
    });
});

// =========================================================================
// 🔓 PUBLIC ACCESS LAYER & AUTH EXEMPTIONS
// =========================================================================
app.get('/', (req, res) => {
    if (req.cookies?.user_profile) {
        return res.redirect('/index.html');
    }
    return res.sendFile(path.join(__dirname, 'public/welcome.html'));
});

app.use('/login.html', express.static(path.join(__dirname, 'public/login.html')));
app.use('/welcome.html', express.static(path.join(__dirname, 'public/welcome.html')));
app.use('/mobileframe.html', express.static(path.join(__dirname, 'public/mobileframe.html')));
app.use('/css', express.static(path.join(__dirname, 'public/css'))); 
app.use('/js', express.static(path.join(__dirname, 'public/js'))); 
app.use('/data', express.static(path.join(__dirname, 'public/data')));
app.use('/media', express.static(path.join(__dirname, 'public/media')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/favicon.ico', express.static(path.join(__dirname, 'public/favicon.ico')));
app.use('/manifest.webmanifest', express.static(path.join(__dirname, 'public/manifest.webmanifest')));
app.use('/sw.js', express.static(path.join(__dirname, 'public/sw.js')));

const authRouter = require('./src/routes/auth.routes');
app.use('/api/auth', authRouter);

// =========================================================================
// 🛡️ ADMINISTRATIVE ACCESS GATEKEEPER (Terminal Route Execution)
// =========================================================================
app.get('/admin.html', async (req, res) => {
    const activeUser = req.cookies?.user_profile;
    const cleanUser = String(activeUser || '').toLowerCase().trim();

    const allowByIdentity = cleanUser === 'josh' || cleanUser.startsWith('josh@');
    if (allowByIdentity) {
        return res.sendFile(path.join(__dirname, 'public/admin.html'));
    }

    if (cleanUser) {
        try {
            const config = await ProfileService.readData(cleanUser, 'config', {});
            if (config?.isAdmin === true) {
                return res.sendFile(path.join(__dirname, 'public/admin.html'));
            }
        } catch (_err) {
            // Fall through to login redirect.
        }
    }

    return res.redirect('/login.html');
});

app.get('/admin-users.html', async (req, res) => {
    const activeUser = req.cookies?.user_profile;
    const cleanUser = String(activeUser || '').toLowerCase().trim();

    const allowByIdentity = cleanUser === 'josh' || cleanUser.startsWith('josh@');
    if (allowByIdentity) {
        return res.sendFile(path.join(__dirname, 'public/admin-users.html'));
    }

    if (cleanUser) {
        try {
            const config = await ProfileService.readData(cleanUser, 'config', {});
            if (config?.isAdmin === true) {
                return res.sendFile(path.join(__dirname, 'public/admin-users.html'));
            }
        } catch (_err) {
            // Fall through to login redirect.
        }
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
const torrentSearchRouter = require('./src/routes/torrentsearch.routes');
const profileRouter = require('./src/routes/profile.routes');
const subtitleRouter = require('./src/routes/subtitle.routes');
const accountRouter = require('./src/routes/account.routes');




app.use('/api/account', accountRouter);
app.use('/api/admin', adminRouter);
app.use('/api', mediaRouter); 
app.use('/api', torrentRouter); 
app.use('/api/torrent', torrentRouter); 
app.use('/api/torrentsearch', torrentSearchRouter);
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

    if (ENABLE_LIBRARY_AUTOSCAN) {
        try {
            await LibraryScanner.runLibraryScanSweep();
            logger.info('Library snapshot initialized at startup.');
        } catch (scanErr) {
            logger.warn(`Initial library scan failed: ${scanErr.message}`);
        }

        const LIBRARY_SCAN_INTERVAL_MS = parseInt(process.env.LIBRARY_SCAN_INTERVAL_MS || '300000', 10);
        if (Number.isFinite(LIBRARY_SCAN_INTERVAL_MS) && LIBRARY_SCAN_INTERVAL_MS > 0) {
            setInterval(() => {
                LibraryScanner.runLibraryScanSweep().catch(err => logger.warn(`Scheduled library scan failed: ${err.message}`));
            }, LIBRARY_SCAN_INTERVAL_MS);
        } else {
            logger.info('Library autoscan interval disabled (LIBRARY_SCAN_INTERVAL_MS <= 0).');
        }
    } else {
        logger.info('Library autoscan disabled via ENABLE_LIBRARY_AUTOSCAN=false.');
    }
    
    if (ENABLE_PIPELINE_WATCHER) {
        await reconcileQueueStartupState().catch(err => logger.warn(`Queue startup reconciliation note: ${err.message}`));
        logger.info('Queue-driven pipeline active; waiting for torrent completion events.');
        startPipelineWorker(10000);
    } else {
        logger.info('Pipeline watcher disabled on this node via ENABLE_PIPELINE_WATCHER=false.');
    }
})();

app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 MOVIE STREAMER ENGINE IS NOW LIVE`);
    console.log(`🔊 Listening on internal port: ${PORT}`);
    console.log(`📂 Scanning media collection volumes cleanly.`);
    console.log(`==================================================\n`);
});