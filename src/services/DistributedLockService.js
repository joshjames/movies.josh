const crypto = require('crypto');
const logger = require('./logger');
const { connectDb, redisClient } = require('./db');

const LOCK_PREFIX = process.env.DISTRIBUTED_LOCK_PREFIX || 'anymovie:lock:';
const DEFAULT_TTL_MS = parseInt(process.env.DISTRIBUTED_LOCK_TTL_MS || '10000', 10);
const DEFAULT_WAIT_MS = parseInt(process.env.DISTRIBUTED_LOCK_WAIT_MS || '3000', 10);
const DEFAULT_RETRY_MS = parseInt(process.env.DISTRIBUTED_LOCK_RETRY_MS || '150', 10);

function buildLockKey(resourceKey) {
    return `${LOCK_PREFIX}${String(resourceKey || '').trim()}`;
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseLock(lockKey, token) {
    if (!redisClient.isOpen) return;

    try {
        await redisClient.sendCommand([
            'EVAL',
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            '1',
            lockKey,
            token
        ]);
    } catch (err) {
        logger.warn(`⚠️ [Lock] Failed releasing ${lockKey}: ${err.message}`);
    }
}

async function withDistributedLock(resourceKey, handler, options = {}) {
    const ttlMs = Math.max(1000, parseInt(options.ttlMs || DEFAULT_TTL_MS, 10));
    const waitMs = Math.max(0, parseInt(options.waitMs || DEFAULT_WAIT_MS, 10));
    const retryMs = Math.max(25, parseInt(options.retryMs || DEFAULT_RETRY_MS, 10));
    const lockKey = buildLockKey(resourceKey);
    const token = crypto.randomUUID();

    await connectDb();

    if (!redisClient.isOpen) {
        logger.warn(`⚠️ [Lock] Redis unavailable. Executing without distributed lock for ${lockKey}.`);
        return handler();
    }

    const deadline = Date.now() + waitMs;
    while (true) {
        const acquired = await redisClient.set(lockKey, token, { PX: ttlMs, NX: true });
        if (acquired === 'OK') {
            try {
                return await handler();
            } finally {
                await releaseLock(lockKey, token);
            }
        }

        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for distributed lock: ${resourceKey}`);
        }

        await sleep(retryMs);
    }
}

module.exports = {
    withDistributedLock
};