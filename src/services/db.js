// src/services/db.js
const { createClient } = require('redis');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FALLBACK_FILE = path.join(__dirname, '../../metadata/fallback_library.json');

// Connect to the host and append the targeted database index (e.g., /3)
const DEFAULT_REDIS_HOST = process.env.REDIS_HOST || 'redis';
const DEFAULT_REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_URL = process.env.REDIS_URL || `redis://${DEFAULT_REDIS_HOST}:${DEFAULT_REDIS_PORT}/3`;

// Cross-geo split: a region running a local read replica (e.g. a secondary
// site) sets REDIS_READ_URL to that replica and REDIS_WRITE_URL to the single
// primary (still reachable, just over WireGuard). The primary region itself
// just leaves both unset and both fall back to REDIS_URL, so this is a no-op
// there - reads and writes hit the same instance exactly as before.
const REDIS_READ_URL = process.env.REDIS_READ_URL || REDIS_URL;
const REDIS_WRITE_URL = process.env.REDIS_WRITE_URL || REDIS_URL;

const REDIS_ENABLED = !['false', '0', 'no'].includes(
    String(process.env.ENABLE_REDIS || 'true').trim().toLowerCase()
);
const REDIS_RECONNECT_INTERVAL_MS = 15000;
let lastRedisConnectAttempt = 0;
let lastRedisWriteConnectAttempt = 0;

function createDisabledRedisClient() {
    return {
        isOpen: false,
        async connect() { return; },
        async set() { return; },
        async get() { return null; },
        async del() { return 0; },
        async hGetAll() { return {}; },
        async hSet() { return 0; },
        async sendCommand() { return null; }
    };
}

function buildClient(url) {
    const client = createClient({
        url,
        socket: {
            connectTimeout: 1000,
            reconnectStrategy: () => false
        }
    });
    client.on('error', (err) => logger.error(`🚨 Redis Hub Error [${url}]: ${err.message}`));
    return client;
}

// Same instance when REDIS_READ_URL/REDIS_WRITE_URL are unset (primary region);
// a distinct connection to the local replica vs. the remote primary otherwise.
const SAME_ENDPOINT = REDIS_READ_URL === REDIS_WRITE_URL;

const redisClient = REDIS_ENABLED ? buildClient(REDIS_READ_URL) : createDisabledRedisClient();
const redisWriteClient = !REDIS_ENABLED
    ? createDisabledRedisClient()
    : (SAME_ENDPOINT ? redisClient : buildClient(REDIS_WRITE_URL));

async function connectDb() {
    if (!REDIS_ENABLED) {
        return;
    }

    if (redisClient.isOpen) {
        return;
    }

    const now = Date.now();
    if (now - lastRedisConnectAttempt < REDIS_RECONNECT_INTERVAL_MS) {
        return;
    }

    lastRedisConnectAttempt = now;

    try {
        await redisClient.connect();
        logger.info(`🚀 Connected to Redis read endpoint [${REDIS_READ_URL.split('/').pop()}]`);
    } catch (e) {
        logger.warn('⚠️ Redis read endpoint unreachable. Shifting operational layout to Cold JSON storage layers.');
    }
}

// Only meaningfully different from connectDb() when running against a local
// replica (SAME_ENDPOINT === false) - otherwise redisWriteClient IS redisClient.
async function connectWriteDb() {
    if (!REDIS_ENABLED || SAME_ENDPOINT) {
        return connectDb();
    }

    if (redisWriteClient.isOpen) {
        return;
    }

    const now = Date.now();
    if (now - lastRedisWriteConnectAttempt < REDIS_RECONNECT_INTERVAL_MS) {
        return;
    }

    lastRedisWriteConnectAttempt = now;

    try {
        await redisWriteClient.connect();
        logger.info(`🚀 Connected to Redis write endpoint [${REDIS_WRITE_URL.split('/').pop()}]`);
    } catch (e) {
        logger.warn('⚠️ Redis write endpoint (primary) unreachable. Writes will fail until it recovers.');
    }
}

async function syncLibraryToStorage(libraryData) {
    await connectDb();
    try {
        if (redisClient.isOpen) {
            await redisClient.set('joshflix:library', JSON.stringify(libraryData));
        }
    } catch (err) {
        logger.error(`Failed updating Redis cache keys: ${err.message}`);
    }

    // Shield Backup Generation
    try {
        fs.mkdirSync(path.dirname(FALLBACK_FILE), { recursive: true });
        fs.writeFileSync(FALLBACK_FILE, JSON.stringify(libraryData, null, 4), 'utf-8');
    } catch (fsErr) {
        logger.error(`Failed writing ultimate fallback file layout: ${fsErr.message}`);
    }
}

async function getLibrary() {
    await connectDb();
    if (redisClient.isOpen) {
        try {
            const cache = await redisClient.get('joshflix:library');
            if (cache) return JSON.parse(cache);
        } catch (e) {
            logger.warn('Fallback shift initiated away from cache tier.');
        }
    }

    if (fs.existsSync(FALLBACK_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf-8'));
        } catch (e) {
            logger.error('Critical Fault: Backup shield corrupted.');
        }
    }
    return { movies: [], shows: [] };
}

module.exports = { connectDb, connectWriteDb, redisClient, redisWriteClient, syncLibraryToStorage, getLibrary };