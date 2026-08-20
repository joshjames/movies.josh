const crypto = require('crypto');
const { connectWriteDb, redisWriteClient } = require('./db');
const logger = require('./logger');

const WINDOW_MS = Math.max(1, Number(process.env.ACQUISITION_QUOTA_WINDOW_MS || 24 * 60 * 60 * 1000));
const SUBSCRIBED_LIMIT = Math.max(0, Number(process.env.SUBSCRIBED_DAILY_MOVIE_LIMIT || 10));
const TRIAL_LIMIT = Math.max(0, Number(process.env.TRIAL_DAILY_MOVIE_LIMIT || 3));
const GUEST_LIMIT = Math.max(0, Number(process.env.GUEST_DAILY_MOVIE_LIMIT || 0));
const KEY_PREFIX = String(process.env.ACQUISITION_QUOTA_PREFIX || 'anymovie:quota:movies:');
const TTL_SECONDS = Math.max(60, Math.ceil((WINDOW_MS * 2) / 1000));

const fallbackStore = new Map();

function normalizeUserKey(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (!clean || clean === 'guest') return null;
    return clean;
}

function resolvePositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.floor(parsed);
}

function getQuotaKey(userKey) {
    const clean = normalizeUserKey(userKey);
    return clean ? `${KEY_PREFIX}${clean}` : null;
}

// A gifted/administrative premium grant. `freeAccessUntil` of null/undefined means an
// unlimited grant (no expiry); otherwise it lapses once that timestamp passes.
function isFreeAccessGrantActive(config) {
    if (!config || config.freeAccessActive !== true) return false;
    if (!config.freeAccessUntil) return true;
    const untilMs = Date.parse(config.freeAccessUntil);
    return !Number.isFinite(untilMs) || untilMs > Date.now();
}

function getUserQuotaTier(config = {}) {
    const status = String(config.subscriptionStatus || '').trim().toUpperCase();
    const billingTier = String(config.billingTier || '').trim().toLowerCase();
    const trialEndsMs = config.trialEndsAt ? Date.parse(config.trialEndsAt) : 0;
    const trialActive = Number.isFinite(trialEndsMs) && trialEndsMs > Date.now();
    const giftActive = isFreeAccessGrantActive(config);

    if (resolvePositiveInt(config.dailyMovieLimit, -1) >= 0) {
        return 'custom';
    }

    if (status === 'ACTIVE' || billingTier.startsWith('premium') || billingTier.startsWith('pro') || giftActive) {
        return 'subscribed';
    }

    if (trialActive || status === 'TRIAL' || status === 'TRIALING') {
        return 'trial';
    }

    if (status === 'GRACE' || status === 'PAUSED' || status === 'PENDING') {
        return 'subscribed';
    }

    return 'guest';
}

function getDailyMovieLimit(config = {}) {
    const customLimit = resolvePositiveInt(config.dailyMovieLimit, -1);
    if (customLimit >= 0) {
        return { limit: customLimit, tier: 'custom' };
    }

    const tier = getUserQuotaTier(config);
    const limit = tier === 'subscribed'
        ? SUBSCRIBED_LIMIT
        : (tier === 'trial' ? TRIAL_LIMIT : GUEST_LIMIT);

    return { limit, tier };
}

function pruneFallbackEntries(entries, now = Date.now()) {
    return entries.filter((entry) => Number(entry?.ts || 0) > now - WINDOW_MS);
}

function getFallbackState(userKey) {
    const clean = normalizeUserKey(userKey);
    if (!clean) return null;
    const existing = fallbackStore.get(clean) || [];
    const trimmed = pruneFallbackEntries(existing);
    if (trimmed.length > 0) fallbackStore.set(clean, trimmed);
    else fallbackStore.delete(clean);
    return trimmed;
}

function setFallbackState(userKey, entries) {
    const clean = normalizeUserKey(userKey);
    if (!clean) return;
    const trimmed = pruneFallbackEntries(entries);
    if (trimmed.length > 0) fallbackStore.set(clean, trimmed);
    else fallbackStore.delete(clean);
}

function buildSnapshot(entries, now = Date.now()) {
    const trimmed = pruneFallbackEntries(entries, now);
    const count = trimmed.length;
    const oldest = count > 0 ? Math.min(...trimmed.map((entry) => Number(entry.ts || 0))) : null;
    return {
        used: count,
        resetAt: oldest ? new Date(oldest + WINDOW_MS).toISOString() : null
    };
}

async function getRedisClientIfAvailable() {
    await connectWriteDb();
    return redisWriteClient.isOpen ? redisWriteClient : null;
}

async function getQuotaSnapshot(userKey, config = {}) {
    const cleanUser = normalizeUserKey(userKey);
    const { limit, tier } = getDailyMovieLimit(config);
    if (!cleanUser) {
        return { allowed: false, userKey: null, tier, limit, used: 0, remaining: 0, resetAt: null, windowMs: WINDOW_MS };
    }

    const redis = await getRedisClientIfAvailable();
    if (!redis) {
        const fallbackEntries = getFallbackState(cleanUser) || [];
        const snapshot = buildSnapshot(fallbackEntries);
        return {
            allowed: snapshot.used < limit,
            userKey: cleanUser,
            tier,
            limit,
            used: snapshot.used,
            remaining: Math.max(0, limit - snapshot.used),
            resetAt: snapshot.resetAt,
            windowMs: WINDOW_MS,
            storage: 'memory'
        };
    }

    const key = getQuotaKey(cleanUser);
    const now = Date.now();
    const minScore = now - WINDOW_MS;
    try {
        await redis.zRemRangeByScore(key, '-inf', minScore);
        const used = await redis.zCard(key);
        const oldest = await redis.zRangeWithScores(key, 0, 0);
        const oldestScore = oldest?.[0]?.score ? Number(oldest[0].score) : null;
        return {
            allowed: used < limit,
            userKey: cleanUser,
            tier,
            limit,
            used,
            remaining: Math.max(0, limit - used),
            resetAt: oldestScore ? new Date(oldestScore + WINDOW_MS).toISOString() : null,
            windowMs: WINDOW_MS,
            storage: 'redis'
        };
    } catch (err) {
        logger.warn(`⚠️ [Quota] Snapshot failed for ${cleanUser}: ${err.message}`);
        const fallbackEntries = getFallbackState(cleanUser) || [];
        const snapshot = buildSnapshot(fallbackEntries);
        return {
            allowed: snapshot.used < limit,
            userKey: cleanUser,
            tier,
            limit,
            used: snapshot.used,
            remaining: Math.max(0, limit - snapshot.used),
            resetAt: snapshot.resetAt,
            windowMs: WINDOW_MS,
            storage: 'memory'
        };
    }
}

async function reserveDailyAcquisition(userKey, config = {}, options = {}) {
    const cleanUser = normalizeUserKey(userKey);
    const { limit, tier } = getDailyMovieLimit(config);
    const now = Number(options.now || Date.now());

    if (!cleanUser) {
        return { allowed: false, reason: 'missing_user', userKey: null, tier, limit, used: 0, remaining: 0, resetAt: null, windowMs: WINDOW_MS };
    }

    if (limit <= 0) {
        return { allowed: false, reason: 'quota_disabled', userKey: cleanUser, tier, limit, used: 0, remaining: 0, resetAt: null, windowMs: WINDOW_MS };
    }

    const redis = await getRedisClientIfAvailable();
    if (!redis) {
        const current = getFallbackState(cleanUser) || [];
        const snapshot = buildSnapshot(current, now);
        if (snapshot.used >= limit) {
            return { allowed: false, reason: 'limit_reached', userKey: cleanUser, tier, limit, used: snapshot.used, remaining: 0, resetAt: snapshot.resetAt, windowMs: WINDOW_MS, storage: 'memory' };
        }

        const token = options.token || crypto.randomBytes(12).toString('hex');
        current.push({ token, ts: now });
        setFallbackState(cleanUser, current);
        const nextSnapshot = buildSnapshot(current, now);
        return { allowed: true, token, userKey: cleanUser, tier, limit, used: nextSnapshot.used, remaining: Math.max(0, limit - nextSnapshot.used), resetAt: nextSnapshot.resetAt, windowMs: WINDOW_MS, storage: 'memory' };
    }

    const key = getQuotaKey(cleanUser);
    const token = options.token || crypto.randomBytes(12).toString('hex');
    try {
        const result = await redis.eval(
            `
                local key = KEYS[1]
                local now = tonumber(ARGV[1])
                local windowMs = tonumber(ARGV[2])
                local limit = tonumber(ARGV[3])
                local token = ARGV[4]
                local ttlSeconds = tonumber(ARGV[5])

                redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
                local count = redis.call('ZCARD', key)
                local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
                local oldestScore = nil
                if oldest and oldest[2] then
                    oldestScore = tonumber(oldest[2])
                end

                if count >= limit then
                    return { 0, count, oldestScore or 0 }
                end

                redis.call('ZADD', key, now, token)
                redis.call('EXPIRE', key, ttlSeconds)
                local nextCount = redis.call('ZCARD', key)
                return { 1, nextCount, oldestScore or now }
            `,
            {
                keys: [key],
                arguments: [String(now), String(WINDOW_MS), String(limit), token, String(TTL_SECONDS)]
            }
        );

        const allowed = Number(result?.[0]) === 1;
        const used = Number(result?.[1]) || 0;
        const oldestScore = Number(result?.[2]) || now;
        return {
            allowed,
            token,
            userKey: cleanUser,
            tier,
            limit,
            used,
            remaining: Math.max(0, limit - used),
            resetAt: new Date(oldestScore + WINDOW_MS).toISOString(),
            windowMs: WINDOW_MS,
            storage: 'redis'
        };
    } catch (err) {
        logger.warn(`⚠️ [Quota] Reserve failed for ${cleanUser}: ${err.message}`);
        const current = getFallbackState(cleanUser) || [];
        const snapshot = buildSnapshot(current, now);
        if (snapshot.used >= limit) {
            return { allowed: false, reason: 'limit_reached', userKey: cleanUser, tier, limit, used: snapshot.used, remaining: 0, resetAt: snapshot.resetAt, windowMs: WINDOW_MS, storage: 'memory' };
        }

        current.push({ token, ts: now });
        setFallbackState(cleanUser, current);
        const nextSnapshot = buildSnapshot(current, now);
        return { allowed: true, token, userKey: cleanUser, tier, limit, used: nextSnapshot.used, remaining: Math.max(0, limit - nextSnapshot.used), resetAt: nextSnapshot.resetAt, windowMs: WINDOW_MS, storage: 'memory' };
    }
}

async function releaseDailyAcquisition(userKey, token) {
    const cleanUser = normalizeUserKey(userKey);
    const cleanToken = String(token || '').trim();
    if (!cleanUser || !cleanToken) return false;

    const redis = await getRedisClientIfAvailable();
    if (!redis) {
        const current = getFallbackState(cleanUser) || [];
        const next = current.filter((entry) => String(entry.token || '') !== cleanToken);
        setFallbackState(cleanUser, next);
        return true;
    }

    try {
        await redis.zRem(getQuotaKey(cleanUser), cleanToken);
        return true;
    } catch (err) {
        logger.warn(`⚠️ [Quota] Release failed for ${cleanUser}: ${err.message}`);
        return false;
    }
}

module.exports = {
    getDailyMovieLimit,
    getQuotaSnapshot,
    reserveDailyAcquisition,
    releaseDailyAcquisition,
    WINDOW_MS
};