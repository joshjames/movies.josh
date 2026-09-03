// src/services/ProfileService.js
// Central Data Access Layer (DAL) for user profile provisioning and state management.
// Inside src/services/ProfileService.js
// Go up 3 levels: services -> src -> root -> metadata/users

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { connectDb, connectWriteDb, redisClient, redisWriteClient } = require('./db');
const { withDistributedLock } = require('./DistributedLockService');

function resolveUserBaseDir() {
    const configured = String(process.env.USER_BASE_DIR || '').trim();
    if (configured) return configured;

    const candidates = [
        '/app/metadata/users',
        path.join(__dirname, '../../metadata/users'),
        path.join(__dirname, '../../../metadata/users')
    ];

    return candidates[0];
}

const USER_BASE_DIR = resolveUserBaseDir();
const ROSTER_FILE = path.join(USER_BASE_DIR, 'roster.json');
const PLAYBACK_KEY_PREFIX = process.env.PLAYBACK_REDIS_PREFIX || 'anymovie:user:playback:';
const USER_STATE_KEY_PREFIX = process.env.USER_STATE_REDIS_PREFIX || 'anymovie:user:state:';
const ROSTER_REDIS_KEY = `${USER_STATE_KEY_PREFIX}roster`;

function normalizeIdentity(value) {
    return String(value || '').toLowerCase().trim();
}

function defaultDisplayNameFromEmail(emailOrUser) {
    const raw = String(emailOrUser || '').trim();
    const localPart = raw.includes('@') ? raw.split('@')[0] : raw;
    const cleaned = localPart.replace(/[._-]+/g, ' ').trim();
    return cleaned || raw;
}

function resolvePositiveInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(n);
}

function normalizeAvatarFileName(value, fallback = 'avatar_001.png') {
    const raw = String(value || '').trim();
    const match = /^avatar_(\d{3})\.png$/i.exec(raw);
    if (!match) return fallback;

    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric) || numeric < 1 || numeric > 136) {
        return fallback;
    }

    return `avatar_${String(numeric).padStart(3, '0')}.png`;
}

function humanizeMediaTitle(mediaId) {
    const raw = String(mediaId || '').trim();
    if (!raw) return 'Unknown Title';

    const withoutPrefix = raw.replace(/^series\//i, '');
    const cleaned = withoutPrefix
        .replace(/\.S\d{1,2}E\d{1,3}$/i, '')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned) return raw;
    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

// A gifted/administrative premium grant. `freeAccessUntil` of null/undefined means an
// unlimited grant (no expiry); otherwise it lapses once that timestamp passes.
function isFreeAccessGrantActive(config) {
    if (!config || config.freeAccessActive !== true) return false;
    if (!config.freeAccessUntil) return true;
    const untilMs = Date.parse(config.freeAccessUntil);
    return !Number.isFinite(untilMs) || untilMs > Date.now();
}

// --- SUBSCRIPTION ENTITLEMENT VALUATION ---
async function getSubscriptionStatus(username) {
    const cleanKey = await this.resolveUserKey(username);
    if (!cleanKey) return { active: false, reason: 'user_not_found' };

    const config = await this.readData(cleanKey, 'config', {});

    // If you manually flag accounts with lifetime/unlocked access
    if (isFreeAccessGrantActive(config)) {
        return { active: true, reason: 'administrative_bypass' };
    }

    const now = Date.now();
    const trialEnd = config.trialEndsAt ? Date.parse(config.trialEndsAt) : 0;

    // 1. Check if they are still inside the core trial window
    if (now <= trialEnd) {
        return { active: true, reason: 'active_trial' };
    }

    // 2. Check if they are inside the grace period window
    const graceDays = resolvePositiveInt(config.gracePeriodDays, 3);
    const graceEnd = trialEnd + (graceDays * 24 * 60 * 60 * 1000);

    if (now <= graceEnd) {
        return { active: true, reason: 'grace_period' };
    }

    // Both trial and grace periods have lapsed
    return { active: false, reason: 'trial_expired' };
}




// ====== PRIVATE DATA UTILITIES ======
async function ensureUserDir(username) {
    const userDir = path.join(USER_BASE_DIR, username);
    await fs.mkdir(userDir, { recursive: true });
    return userDir;
}

async function readRoster() {
    await connectDb();

    if (redisClient.isOpen) {
        try {
            const cached = await redisClient.get(ROSTER_REDIS_KEY);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            logger.warn(`[PROFILE WARN] Failed reading roster cache: ${err.message}`);
        }
    }

    try {
        const data = await fs.readFile(ROSTER_FILE, 'utf-8');
        const parsed = JSON.parse(data);

        // Hydrating a cache miss is still a write - route it through the
        // primary the same as any other write, not the local read replica.
        await connectWriteDb();
        if (redisWriteClient.isOpen) {
            try {
                await redisWriteClient.set(ROSTER_REDIS_KEY, JSON.stringify(parsed));
            } catch (err) {
                logger.warn(`[PROFILE WARN] Failed hydrating roster cache: ${err.message}`);
            }
        }

        return parsed;
    } catch (e) {
        return {};
    }
}

async function writeRoster(roster) {
    await connectWriteDb();
    if (redisWriteClient.isOpen) {
        try {
            await redisWriteClient.set(ROSTER_REDIS_KEY, JSON.stringify(roster));
        } catch (err) {
            logger.warn(`[PROFILE WARN] Failed writing roster cache: ${err.message}`);
        }
    }

    await fs.mkdir(USER_BASE_DIR, { recursive: true });
    await fs.writeFile(ROSTER_FILE, JSON.stringify(roster, null, 4), 'utf-8');
}

function isRedisMirroredFileType(fileType) {
    return fileType === 'config' || fileType === 'history';
}

function userStateRedisKey(username, fileType) {
    return `${USER_STATE_KEY_PREFIX}${fileType}:${normalizeIdentity(username)}`;
}

async function readUserStateFromRedis(username, fileType) {
    if (!isRedisMirroredFileType(fileType)) return null;

    await connectDb();
    if (!redisClient.isOpen) return null;

    try {
        const cached = await redisClient.get(userStateRedisKey(username, fileType));
        return cached ? JSON.parse(cached) : null;
    } catch (err) {
        logger.warn(`[PROFILE WARN] Failed reading ${fileType} cache for ${username}: ${err.message}`);
        return null;
    }
}

async function writeUserStateToRedis(username, fileType, data) {
    if (!isRedisMirroredFileType(fileType)) return;

    await connectWriteDb();
    if (!redisWriteClient.isOpen) return;

    try {
        await redisWriteClient.set(userStateRedisKey(username, fileType), JSON.stringify(data));
    } catch (err) {
        logger.warn(`[PROFILE WARN] Failed writing ${fileType} cache for ${username}: ${err.message}`);
    }
}

function playbackRedisKey(username) {
    return `${PLAYBACK_KEY_PREFIX}${normalizeIdentity(username)}`;
}

async function readPlaybackFromRedis(username) {
    await connectDb();
    if (!redisClient.isOpen) return null;

    try {
        const raw = await redisClient.hGetAll(playbackRedisKey(username));
        if (!raw || Object.keys(raw).length === 0) return null;

        const playback = {};
        for (const [mediaId, value] of Object.entries(raw)) {
            try {
                playback[mediaId] = JSON.parse(value);
            } catch (_err) {
                playback[mediaId] = { position: parseFloat(value) || 0, updatedAt: 0 };
            }
        }
        return playback;
    } catch (err) {
        logger.warn(`[PROFILE WARN] Failed reading playback cache for ${username}: ${err.message}`);
        return null;
    }
}

async function mirrorPlaybackSnapshotToDisk(username) {
    const snapshot = await readPlaybackFromRedis(username);
    if (!snapshot) return false;

    try {
        const userDir = await ensureUserDir(username);
        const filePath = path.join(userDir, 'playback.json');
        await fs.writeFile(filePath, JSON.stringify(snapshot, null, 4), 'utf-8');
        return true;
    } catch (err) {
        logger.warn(`[PROFILE WARN] Failed mirroring playback snapshot for ${username}: ${err.message}`);
        return false;
    }
}

// ====== CORE SERVICE CORE ======
const ProfileService = {
    normalizeIdentity,
    isFreeAccessGrantActive,

    async listUsers() {
        const roster = await readRoster();
        return Object.keys(roster);
    },

    async resolveUserKey(identifier) {
        const cleanIdentifier = normalizeIdentity(identifier);
        if (!cleanIdentifier) return null;

        const roster = await readRoster();
        if (roster[cleanIdentifier]) {
            return cleanIdentifier;
        }

        const byEmail = Object.keys(roster).find(key => normalizeIdentity(roster[key]?.email) === cleanIdentifier);
        if (byEmail) {
            return byEmail;
        }

        return null;
    },
    
    // --- GENERIC READ OPERATIONS ---
    async readData(username, fileType, defaultData = {}) {
        const cached = await readUserStateFromRedis(username, fileType);
        if (cached) return cached;

        try {
            const userDir = path.join(USER_BASE_DIR, username);
            const filePath = path.join(userDir, `${fileType}.json`);
            const data = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(data);
            await writeUserStateToRedis(username, fileType, parsed);
            return parsed;
        } catch (err) {
            return defaultData;
        }
    },

    // --- GENERIC WRITE OPERATIONS ---
    // Lock-protected the same way MetadataRegistry.writeAndCommit is: this
    // serializes the write itself (Redis + disk together) so two nodes can't
    // interleave a partial write to the same user's state. It does NOT make a
    // caller's own read-modify-write atomic - a caller that reads, mutates,
    // then calls writeData can still race another writer's stale read the
    // same way callers of MetadataRegistry.writeAndCommit can. Use
    // mergeAndCommit below for call sites that need true atomicity.
    async writeData(username, fileType, data) {
        const cleanUser = normalizeIdentity(username);
        const lockKey = `profile:user:${cleanUser}:${fileType}`;

        return withDistributedLock(lockKey, async () => {
            try {
                await writeUserStateToRedis(username, fileType, data);
                const userDir = await ensureUserDir(username);
                const filePath = path.join(userDir, `${fileType}.json`);
                await fs.writeFile(filePath, JSON.stringify(data, null, 4), 'utf-8');
                return true;
            } catch (err) {
                logger.error(`[PROFILE ERROR] Failed writing ${fileType} for ${username}: ${err.message}`);
                throw err;
            }
        }, { ttlMs: 8000, waitMs: 5000 });
    },

    // True atomic read-modify-write, matching MetadataRegistry.mergeAndCommit.
    // Prefer this over separate readData()+writeData() calls for any new
    // call site that mutates existing state rather than replacing it wholesale.
    async mergeAndCommit(username, fileType, mergeFn) {
        const cleanUser = normalizeIdentity(username);
        const lockKey = `profile:user:${cleanUser}:${fileType}`;

        return withDistributedLock(lockKey, async () => {
            const current = await this.readData(cleanUser, fileType, {});
            const next = await mergeFn(current || {});
            await writeUserStateToRedis(cleanUser, fileType, next);
            const userDir = await ensureUserDir(cleanUser);
            const filePath = path.join(userDir, `${fileType}.json`);
            await fs.writeFile(filePath, JSON.stringify(next, null, 4), 'utf-8');
            return next;
        }, { ttlMs: 8000, waitMs: 5000 });
    },

    // --- PLAYBACK PROGRESS COORDINATE TRACKS ---
    async getPlaybackState(username) {
        const cached = await readPlaybackFromRedis(username);
        if (cached) return cached;
        return await this.readData(username, 'playback', {});
    },

    async savePlaybackPosition(username, mediaId, position) {
        const cleanUser = normalizeIdentity(username);
        const cleanMediaId = String(mediaId || '').trim();
        const entry = {
            position: parseFloat(position),
            updatedAt: Date.now()
        };

        await connectWriteDb();
        if (redisWriteClient.isOpen) {
            try {
                await redisWriteClient.hSet(playbackRedisKey(cleanUser), cleanMediaId, JSON.stringify(entry));
                await mirrorPlaybackSnapshotToDisk(cleanUser);
                return true;
            } catch (err) {
                logger.warn(`[PROFILE WARN] Failed writing playback cache for ${cleanUser}: ${err.message}`);
            }
        }

        // mergeAndCommit, not writeData - it takes the profile:user:*:playback
        // lock itself internally, so calling writeData here (same lock key)
        // would be a nested acquisition against the same key and stall until
        // the outer withDistributedLock timeout.
        await this.mergeAndCommit(cleanUser, 'playback', async (playback) => {
            const next = { ...playback };
            next[cleanMediaId] = entry;
            return next;
        });
        return true;
    },

    // Drops a title's playback record entirely (rather than just zeroing its
    // position) so a finished title falls out of "Continue Watching" instead
    // of lingering with a stale near-the-end position - there's no separate
    // "watched" flag, so removal from this map is what "not in progress"
    // means to any reader of it (getWatchHistory, Continue Watching, etc).
    async clearPlaybackPosition(username, mediaId) {
        const cleanUser = normalizeIdentity(username);
        const cleanMediaId = String(mediaId || '').trim();
        if (!cleanMediaId) return false;

        await connectWriteDb();
        if (redisWriteClient.isOpen) {
            try {
                await redisWriteClient.hDel(playbackRedisKey(cleanUser), cleanMediaId);
                await mirrorPlaybackSnapshotToDisk(cleanUser);
                return true;
            } catch (err) {
                logger.warn(`[PROFILE WARN] Failed clearing playback cache for ${cleanUser}: ${err.message}`);
            }
        }

        await this.mergeAndCommit(cleanUser, 'playback', async (playback) => {
            const next = { ...playback };
            delete next[cleanMediaId];
            return next;
        });
        return true;
    },

    async getWatchHistory(username, options = {}) {
        const limit = Math.max(1, Math.min(parseInt(options.limit, 10) || 200, 1000));
        const playback = await this.getPlaybackState(username);

        const rows = Object.entries(playback || {})
            .map(([mediaId, entry]) => {
                const updatedAt = Number(entry?.updatedAt || 0);
                const position = Number(entry?.position || 0);
                return {
                    mediaId,
                    title: humanizeMediaTitle(mediaId),
                    position: Number.isFinite(position) ? position : 0,
                    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
                    updatedAtIso: Number.isFinite(updatedAt) && updatedAt > 0
                        ? new Date(updatedAt).toISOString()
                        : null
                };
            })
            .filter((row) => row.updatedAt > 0)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, limit);

        return rows;
    },

    async getWatchLater(username, options = {}) {
        const cleanUser = normalizeIdentity(username);
        const limit = Math.max(1, Math.min(parseInt(options.limit, 10) || 500, 2000));
        const data = await this.readData(cleanUser, 'watch_later', { items: [] });
        const rows = Array.isArray(data.items) ? data.items : [];
        return rows
            .filter((row) => row && row.id)
            .sort((a, b) => new Date(b.updatedAt || b.addedAt || 0) - new Date(a.updatedAt || a.addedAt || 0))
            .slice(0, limit);
    },

    async addWatchLaterItem(username, item = {}) {
        const cleanUser = normalizeIdentity(username);
        const cleanId = String(item.id || '').trim();
        if (!cleanUser || !cleanId) return { success: false, error: 'Missing user or media id.' };

        return await withDistributedLock(`profile:user:${cleanUser}:watch-later`, async () => {
            const data = await this.readData(cleanUser, 'watch_later', { items: [] });
            const list = Array.isArray(data.items) ? data.items : [];
            const nowIso = new Date().toISOString();
            const next = {
                id: cleanId,
                title: String(item.title || cleanId),
                contentType: String(item.contentType || 'movie'),
                cover: String(item.cover || ''),
                href: String(item.href || ''),
                imdbId: String(item.imdbId || ''),
                addedAt: item.addedAt || nowIso,
                updatedAt: nowIso
            };

            const existingIndex = list.findIndex((row) => String(row.id || '') === cleanId);
            if (existingIndex >= 0) {
                list[existingIndex] = { ...list[existingIndex], ...next, addedAt: list[existingIndex].addedAt || nowIso };
            } else {
                list.unshift(next);
            }

            const deduped = [];
            const seen = new Set();
            for (const row of list) {
                const key = String(row.id || '').trim();
                if (!key || seen.has(key)) continue;
                seen.add(key);
                deduped.push(row);
            }

            await this.writeData(cleanUser, 'watch_later', { items: deduped.slice(0, 2000) });
            return { success: true, count: deduped.length };
        }, { ttlMs: 5000, waitMs: 4000 });
    },

    async removeWatchLaterItem(username, mediaId) {
        const cleanUser = normalizeIdentity(username);
        const cleanId = String(mediaId || '').trim();
        if (!cleanUser || !cleanId) return { success: false, error: 'Missing user or media id.' };

        return await withDistributedLock(`profile:user:${cleanUser}:watch-later`, async () => {
            const data = await this.readData(cleanUser, 'watch_later', { items: [] });
            const list = Array.isArray(data.items) ? data.items : [];
            const next = list.filter((row) => String(row.id || '') !== cleanId);
            await this.writeData(cleanUser, 'watch_later', { items: next });
            return { success: true, count: next.length };
        }, { ttlMs: 5000, waitMs: 4000 });
    },

    // --- TELEMETRY SECURITY HISTORY TRACKS ---
    // mergeAndCommit, not a manual lock+writeData - writeData takes the same
    // profile:user:*:history lock internally, so wrapping it in another lock
    // of the same key here would be a nested acquisition against itself.
    async updateLoginHistory(username, ipAddress) {
        const cleanUser = normalizeIdentity(username);
        await this.mergeAndCommit(cleanUser, 'history', async (history) => {
            const next = { logins: [], lastLogin: null, ...history };
            next.logins = Array.isArray(next.logins) ? [...next.logins] : [];
            const currentTimestamp = Date.now();

            next.lastLogin = currentTimestamp;
            next.logins.unshift({ ip: ipAddress, timestamp: currentTimestamp });
            if (next.logins.length > 50) next.logins.pop();

            return next;
        });
        return true;
    },

    // --- SECURE PROVISIONING & LEADER MATRIX ---
    async registerUser(username, password, email, displayName = '') {
        return await withDistributedLock('profile:roster', async () => {
            const cleanName = normalizeIdentity(username);
            const cleanEmail = normalizeIdentity(email);
            const cleanDisplayName = String(displayName || '').trim() || defaultDisplayNameFromEmail(cleanEmail || cleanName);
            const roster = await readRoster();
            const now = Date.now();
            const nowIso = new Date(now).toISOString();
            const trialDays = resolvePositiveInt(process.env.SUBSCRIPTION_TRIAL_DAYS, 7);
            const trialEndsAt = new Date(now + trialDays * 24 * 60 * 60 * 1000).toISOString();

            if (roster[cleanName]) {
                return { success: false, error: "Account already exists for this email." };
            }

            const duplicateEmail = Object.keys(roster).find(key => normalizeIdentity(roster[key]?.email) === cleanEmail);
            if (duplicateEmail) {
                return { success: false, error: "Account already exists for this email." };
            }

            roster[cleanName] = {
                password: password,
                email: cleanEmail,
                displayName: cleanDisplayName,
                createdAt: now,
                updatedAt: now
            };

            const token = require('crypto').randomBytes(32).toString('hex');
            const expires = Date.now() + (24 * 60 * 60 * 1000); 

            const defaultConfigs = {
                username: cleanDisplayName,
                displayName: cleanDisplayName,
                name: cleanDisplayName,
                email: cleanEmail,
                loginKey: cleanName,
                isVerified: false,
                verificationToken: token,
                verificationExpires: expires,
                avatar: 'avatar_001.png',
                signupDate: nowIso,
                trialDays,
                trialEndsAt,
                freeAccessActive: trialDays > 0,
                gracePeriodDays: resolvePositiveInt(process.env.SUBSCRIPTION_GRACE_DAYS, 3),
                gracePeriodEndsAt: null,
                preferences: { autoplay: true, UITheme: "dark" }
            };

            await writeRoster(roster);
            await this.writeData(cleanName, 'config', defaultConfigs);
            await this.writeData(cleanName, 'history', { logins: [], lastLogin: null });
            await this.writeData(cleanName, 'playback', {});

            logger.info(`👤 [USER PROVISIONING] Created new profile volume workspace for: ${cleanName}`);
            return { success: true, token: token };
        }, { ttlMs: 10000, waitMs: 8000 });
    },

    async authenticateUser(username, password) {
        const cleanName = await this.resolveUserKey(username);
        if (!cleanName) {
            return { success: false, error: "Invalid email or password credentials." };
        }

        const roster = await readRoster();

        const account = roster[cleanName];
        if (!account || account.password !== password) {
            return { success: false, error: "Invalid email or password credentials." };
        }

        return { success: true, userKey: cleanName };
    },

    async setPassword(userKey, nextPassword) {
        return await withDistributedLock('profile:roster', async () => {
            const cleanKey = await this.resolveUserKey(userKey);
            if (!cleanKey) {
                return { success: false, error: 'Account not found.' };
            }

            const roster = await readRoster();
            if (!roster[cleanKey]) {
                return { success: false, error: 'Account not found.' };
            }

            roster[cleanKey].password = String(nextPassword);
            roster[cleanKey].updatedAt = Date.now();
            await writeRoster(roster);

            return { success: true, userKey: cleanKey };
        }, { ttlMs: 10000, waitMs: 8000 });
    },

    // mergeAndCommit here too, same reason as updateLoginHistory above -
    // writeData already locks profile:user:*:config internally.
    async issuePasswordResetToken(identifier, ttlMs = 60 * 60 * 1000) {
        const resolvedKey = await this.resolveUserKey(identifier);
        if (!resolvedKey) {
            return { success: false, error: 'Account not found.' };
        }

        const token = require('crypto').randomBytes(32).toString('hex');
        const expires = Date.now() + Math.max(5 * 60 * 1000, Number(ttlMs) || 0);
        let finalConfig = null;

        await this.mergeAndCommit(resolvedKey, 'config', async (config) => {
            const next = { ...config };
            next.passwordResetToken = token;
            next.passwordResetExpires = expires;
            next.updatedAt = Date.now();
            finalConfig = next;
            return next;
        });

        return {
            success: true,
            userKey: resolvedKey,
            token,
            expires,
            email: finalConfig.email || resolvedKey,
            displayName: finalConfig.displayName || finalConfig.name || finalConfig.username || resolvedKey
        };
    },

    async resetPasswordWithToken(identifier, token, nextPassword) {
        const resolvedKey = await this.resolveUserKey(identifier);
        if (!resolvedKey) {
            return { success: false, error: 'Invalid reset request.' };
        }

        const config = await this.readData(resolvedKey, 'config', {});
        if (!config.passwordResetToken || !config.passwordResetExpires) {
            return { success: false, error: 'Reset token is invalid or already used.' };
        }

        if (config.passwordResetToken !== String(token)) {
            return { success: false, error: 'Reset token is invalid or already used.' };
        }

        if (Date.now() > Number(config.passwordResetExpires)) {
            return { success: false, error: 'Reset token has expired. Request a new reset email.' };
        }

        const updateResult = await this.setPassword(resolvedKey, nextPassword);
        if (!updateResult.success) {
            return updateResult;
        }

        await this.mergeAndCommit(resolvedKey, 'config', async (current) => {
            const next = { ...current };
            delete next.passwordResetToken;
            delete next.passwordResetExpires;
            next.updatedAt = Date.now();
            return next;
        });

        return { success: true, userKey: resolvedKey };
    },

    async updateAccountProfile(userKey, payload = {}) {
        const cleanKey = normalizeIdentity(userKey);
        return await withDistributedLock('profile:roster', async () => {
            const roster = await readRoster();
            if (!roster[cleanKey]) {
                throw new Error('Account roster entry not found.');
            }

            const currentConfig = await this.readData(cleanKey, 'config', {});
            const nextDisplayName = String(payload.displayName || payload.name || '').trim() || currentConfig.displayName || currentConfig.username || defaultDisplayNameFromEmail(cleanKey);
            const nextEmail = normalizeIdentity(payload.email || currentConfig.email || cleanKey);
            const nextAvatar = normalizeAvatarFileName(payload.avatar, normalizeAvatarFileName(currentConfig.avatar, 'avatar_001.png'));

            let finalUserKey = cleanKey;
            if (nextEmail && nextEmail !== cleanKey) {
                const collision = Object.keys(roster).find(key => key !== cleanKey && normalizeIdentity(roster[key]?.email) === nextEmail);
                if (collision) {
                    throw new Error('Another account already uses this email.');
                }

                const collisionByKey = roster[nextEmail];
                if (collisionByKey) {
                    throw new Error('Another account already uses this email.');
                }

                finalUserKey = await this.renameUserKey(cleanKey, nextEmail);
            }

            const refreshedRoster = await readRoster();
            refreshedRoster[finalUserKey] = {
                ...(refreshedRoster[finalUserKey] || {}),
                email: nextEmail,
                displayName: nextDisplayName,
                updatedAt: Date.now()
            };
            await writeRoster(refreshedRoster);

            const nextConfig = {
                ...currentConfig,
                username: nextDisplayName,
                displayName: nextDisplayName,
                name: nextDisplayName,
                email: nextEmail,
                loginKey: finalUserKey,
                avatar: nextAvatar,
                updatedAt: Date.now()
            };

            await this.writeData(finalUserKey, 'config', nextConfig);
            return { userKey: finalUserKey, config: nextConfig };
        }, { ttlMs: 15000, waitMs: 12000 });
    },

    async renameUserKey(oldKey, newKey) {
        return await withDistributedLock('profile:roster', async () => {
            const fromKey = normalizeIdentity(oldKey);
            const toKey = normalizeIdentity(newKey);

            if (!fromKey || !toKey) throw new Error('Invalid account identity key.');
            if (fromKey === toKey) return fromKey;

            const roster = await readRoster();
            if (!roster[fromKey]) {
                throw new Error('Current account identity not found.');
            }
            if (roster[toKey]) {
                throw new Error('Target account identity already exists.');
            }

            const fromDir = path.join(USER_BASE_DIR, fromKey);
            const toDir = path.join(USER_BASE_DIR, toKey);

            try {
                await fs.access(fromDir);
                await fs.rename(fromDir, toDir);
            } catch (_err) {
                await fs.mkdir(toDir, { recursive: true });
            }

            roster[toKey] = {
                ...roster[fromKey],
                email: toKey,
                updatedAt: Date.now()
            };
            delete roster[fromKey];
            await writeRoster(roster);

            return toKey;
        }, { ttlMs: 15000, waitMs: 12000 });
    }
};

module.exports = ProfileService;