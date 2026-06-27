// src/services/db.js
const { createClient } = require('redis');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FALLBACK_FILE = path.join(__dirname, '../../metadata/fallback_library.json');

// Connect to the host and append the targeted database index (e.g., /3)
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/3';
const redisClient = createClient({ url: REDIS_URL });

redisClient.on('error', (err) => logger.log(`🚨 Redis Hub Error: ${err.message}`, 'error'));

async function connectDb() {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
            logger.log(`🚀 Connected to Redis Instance Successfully [Isolated DB Index Path: ${REDIS_URL.split('/').pop()}]`);
        }
    } catch (e) {
        logger.log('⚠️ Redis engine unreachable. Shifting operational layout to Cold JSON storage layers.', 'warn');
    }
}

async function syncLibraryToStorage(libraryData) {
    await connectDb();
    try {
        if (redisClient.isOpen) {
            await redisClient.set('joshflix:library', JSON.stringify(libraryData));
        }
    } catch (err) {
        logger.log(`Failed updating Redis cache keys: ${err.message}`, 'error');
    }

    // Shield Backup Generation
    try {
        fs.mkdirSync(path.dirname(FALLBACK_FILE), { recursive: true });
        fs.writeFileSync(FALLBACK_FILE, JSON.stringify(libraryData, null, 4), 'utf-8');
    } catch (fsErr) {
        logger.log(`Failed writing ultimate fallback file layout: ${fsErr.message}`, 'error');
    }
}

async function getLibrary() {
    await connectDb();
    if (redisClient.isOpen) {
        try {
            const cache = await redisClient.get('joshflix:library');
            if (cache) return JSON.parse(cache);
        } catch (e) {
            logger.log('Fallback shift initiated away from cache tier.', 'warn');
        }
    }

    if (fs.existsSync(FALLBACK_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf-8'));
        } catch (e) {
            logger.log('Critical Fault: Backup shield corrupted.', 'error');
        }
    }
    return { movies: [], shows: [] };
}

module.exports = { connectDb, redisClient, syncLibraryToStorage, getLibrary };