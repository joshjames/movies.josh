// src/services/MetadataRegistry.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const fsPromises = fs.promises;
const { connectDb, connectWriteDb, redisClient, redisWriteClient } = require('./db');
const { withDistributedLock } = require('./DistributedLockService');

const META_REDIS_PREFIX = process.env.METADATA_REDIS_PREFIX || 'anymovie:metadata:';
const META_CACHE_MAX_ITEMS = Math.max(100, parseInt(process.env.METADATA_CACHE_MAX_ITEMS || '5000', 10));
const localCache = new Map();

function normalizeFolderName(metaFilePath, folderName) {
    const cleanFolder = String(folderName || '').trim();
    if (cleanFolder) return cleanFolder;
    const parent = path.basename(path.dirname(metaFilePath || ''));
    return parent || 'unknown';
}

function getCacheKey(metaFilePath) {
    return path.resolve(String(metaFilePath || ''));
}

function getRedisKey(metaFilePath, folderName) {
    const resolved = path.resolve(String(metaFilePath || ''));
    const cleanFolder = normalizeFolderName(metaFilePath, folderName);
    return `${META_REDIS_PREFIX}${cleanFolder}:${Buffer.from(resolved).toString('base64')}`;
}

function setLocalCache(metaFilePath, payload) {
    const key = getCacheKey(metaFilePath);
    localCache.delete(key);
    localCache.set(key, payload);

    if (localCache.size > META_CACHE_MAX_ITEMS) {
        const firstKey = localCache.keys().next().value;
        if (firstKey) {
            localCache.delete(firstKey);
        }
    }
}

async function readFromDisk(metaFilePath) {
    const raw = await fsPromises.readFile(metaFilePath, 'utf-8');
    return JSON.parse(raw);
}

async function readFromRedis(metaFilePath, folderName) {
    await connectDb();
    if (!redisClient.isOpen) return null;

    try {
        const raw = await redisClient.get(getRedisKey(metaFilePath, folderName));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        logger.warn(`⚠️ [MetadataRegistry] Redis read failed for ${metaFilePath}: ${err.message}`);
        return null;
    }
}

async function writeToRedis(metaFilePath, folderName, payload) {
    await connectWriteDb();
    if (!redisWriteClient.isOpen) return;

    try {
        await redisWriteClient.set(getRedisKey(metaFilePath, folderName), JSON.stringify(payload));
    } catch (err) {
        logger.warn(`⚠️ [MetadataRegistry] Redis write failed for ${metaFilePath}: ${err.message}`);
    }
}

async function persistUnlocked(metaFilePath, folderName, payload) {
    await fsPromises.mkdir(path.dirname(metaFilePath), { recursive: true });
    await fsPromises.writeFile(metaFilePath, JSON.stringify(payload, null, 4), 'utf-8');
    setLocalCache(metaFilePath, payload);
    await writeToRedis(metaFilePath, folderName, payload);
}

const MetadataRegistry = {
    async read(metaFilePath, folderName = '', options = {}) {
        const key = getCacheKey(metaFilePath);
        if (!options.skipCache) {
            const cached = localCache.get(key);
            if (cached) return cached;
        }

        if (!options.skipRedis) {
            const redisPayload = await readFromRedis(metaFilePath, folderName);
            if (redisPayload) {
                setLocalCache(metaFilePath, redisPayload);
                return redisPayload;
            }
        }

        try {
            const diskPayload = await readFromDisk(metaFilePath);
            setLocalCache(metaFilePath, diskPayload);
            await writeToRedis(metaFilePath, folderName, diskPayload);
            return diskPayload;
        } catch (_err) {
            return {};
        }
    },

    /**
     * Safely updates metadata on disk and instantly pushes it to the Redis read-cache.
     * This forces a deterministic, unidirectional data sync flow.
     */
    async writeAndCommit(metaFilePath, folderName, updatedMetadata, options = {}) {
        const cleanFolder = normalizeFolderName(metaFilePath, folderName);
        const lockKey = `metadata:file:${getCacheKey(metaFilePath)}`;

        const writer = async () => {
            await persistUnlocked(metaFilePath, cleanFolder, updatedMetadata);
            logger.info(`⚙️ [MetadataRegistry] Committed [${cleanFolder}] metadata to memory, redis, and disk.`);
            return true;
        };

        try {
            if (options.skipLock) {
                return await writer();
            }

            return await withDistributedLock(lockKey, writer, { ttlMs: 8000, waitMs: 5000 });
        } catch (err) {
            logger.error(`❌ [Registry Failure] Failed atomic write on [${cleanFolder}]: ${err.message}`);
            throw err;
        }
    },

    async mergeAndCommit(metaFilePath, folderName, mergeFn) {
        const cleanFolder = normalizeFolderName(metaFilePath, folderName);
        const lockKey = `metadata:file:${getCacheKey(metaFilePath)}`;

        return withDistributedLock(lockKey, async () => {
            const current = await this.read(metaFilePath, cleanFolder, { skipCache: true, skipRedis: true });
            const next = await mergeFn(current || {});
            await this.writeAndCommit(metaFilePath, cleanFolder, next, { skipLock: true });
            return next;
        }, { ttlMs: 10000, waitMs: 8000 });
    }
};

module.exports = MetadataRegistry;