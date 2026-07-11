// src/services/TorrentService.js
// Central communication interface for managing qBittorrent container transactions.

const axios = require('axios');
const FormData = require('form-data');
const logger = require('./logger');
const { connectDb, redisClient } = require('./db');

const QBIT_BASE_URL = process.env.QBIT_API_URL || 'http://qbittorrent:8080/api/v2';
const TORRENT_IMDB_PREFIX = process.env.TORRENT_IMDB_PREFIX || 'anymovie:torrent:imdb:';
const TORRENT_USER_PREFIX = process.env.TORRENT_USER_PREFIX || 'anymovie:torrent:user:';

// Simple in-memory cache for torrent hash -> IMDB ID mapping
const torrentImdbMap = new Map();
const torrentUserMap = new Map();
const userTagMap = new Map();

function normalizeUserKey(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (!clean || clean === 'guest') return null;
    return clean;
}

function buildUserTag(userKey) {
    const clean = normalizeUserKey(userKey);
    if (!clean) return null;
    const encoded = clean.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return encoded ? `user-${encoded}` : null;
}

function normalizeHash(value) {
    const clean = String(value || '').trim().toLowerCase();
    return clean || null;
}

function parseTags(tags) {
    return String(tags || '')
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);
}

function extractInfoHashFromMagnet(magnetUrl) {
    try {
        const xt = new URL(magnetUrl).searchParams.get('xt') || '';
        const raw = xt.includes('btih:') ? xt.split('btih:')[1] : '';
        return normalizeHash(raw);
    } catch (_err) {
        return null;
    }
}

function extractUserFromTagList(tagList = []) {
    const userTag = tagList.find(tag => tag.startsWith('user-'));
    if (!userTag) return null;
    return normalizeUserKey(userTagMap.get(userTag)) || null;
}

function buildRedisKey(prefix, hash) {
    const cleanHash = normalizeHash(hash);
    return cleanHash ? `${prefix}${cleanHash}` : null;
}

async function readRedisMapping(prefix, hash) {
    const key = buildRedisKey(prefix, hash);
    if (!key) return null;

    await connectDb();
    if (!redisClient.isOpen) return null;

    try {
        return await redisClient.get(key);
    } catch (err) {
        logger.warn(`⚠️ [Torrent Service] Failed reading mapping ${key}: ${err.message}`);
        return null;
    }
}

async function writeRedisMapping(prefix, hash, value, ttlSeconds = 604800) {
    const key = buildRedisKey(prefix, hash);
    if (!key || !value) return;

    await connectDb();
    if (!redisClient.isOpen) return;

    try {
        await redisClient.set(key, String(value), { EX: ttlSeconds });
    } catch (err) {
        logger.warn(`⚠️ [Torrent Service] Failed writing mapping ${key}: ${err.message}`);
    }
}

class TorrentService {
    /**
     * Dispatched a formatted magnet stream download command into qBittorrent.
     * @param {string} magnetUrl 
     * @param {string} category 'movie' or 'series-streamer'
     * @param {string} imdbId Optional IMDB ID to track with torrent
     */
    async addMagnet(magnetUrl, category = 'movie', imdbId = null, options = {}) {
        try {
            const form = new FormData();
            form.append('urls', magnetUrl);
            
            // Map incoming requests directly to your updated client categories
            const targetCategory = (category === 'series-streamer' || category === 'series') 
                ? 'series-streamer' 
                : 'movie-streamer';

            form.append('category', targetCategory);
            
            // Set dynamic workflow tags based on the media type
            const targetTag = targetCategory === 'series-streamer' ? 'series-streamer' : 'movie-streamer';
            const addedByUser = normalizeUserKey(options.addedByUser || options.userKey || options.username);
            const userTag = buildUserTag(addedByUser);
            if (userTag && addedByUser) {
                userTagMap.set(userTag, addedByUser);
            }
            form.append('tags', [targetTag, userTag].filter(Boolean).join(','));

            const endpoint = `${QBIT_BASE_URL}/torrents/add`;
            await axios.post(endpoint, form, {
                headers: form.getHeaders(),
                timeout: 5000
            });

            const infoHashFromMagnet = extractInfoHashFromMagnet(magnetUrl);
            if (infoHashFromMagnet && imdbId) {
                torrentImdbMap.set(infoHashFromMagnet, imdbId);
                await writeRedisMapping(TORRENT_IMDB_PREFIX, infoHashFromMagnet, imdbId);
            }
            if (infoHashFromMagnet && addedByUser) {
                torrentUserMap.set(infoHashFromMagnet, addedByUser);
                await writeRedisMapping(TORRENT_USER_PREFIX, infoHashFromMagnet, addedByUser);
            }

            // After adding to qBittorrent, fetch the torrent info to get its hash
            if (imdbId) {
                try {
                    const allTorrents = await axios.get(`${QBIT_BASE_URL}/torrents/info`, { timeout: 3000 });
                    const addedTorrent = (allTorrents.data || []).find(t => t.category === targetCategory);
                    if (addedTorrent && addedTorrent.hash) {
                        const cleanHash = normalizeHash(addedTorrent.hash);
                        torrentImdbMap.set(cleanHash, imdbId);
                        await writeRedisMapping(TORRENT_IMDB_PREFIX, cleanHash, imdbId);
                        logger.debug(`🔗 [Torrent Service] Mapped hash ${addedTorrent.hash.substring(0, 8)} -> IMDB ${imdbId}`);
                    }
                } catch (mapErr) {
                    logger.warn(`⚠️ [Torrent Service] Could not map IMDB ID to torrent: ${mapErr.message}`);
                }
            }

            if (addedByUser) {
                try {
                    const allTorrents = await axios.get(`${QBIT_BASE_URL}/torrents/info`, { timeout: 3000 });
                    const addedTorrent = (allTorrents.data || []).find(t => {
                        const hash = normalizeHash(t.hash);
                        if (infoHashFromMagnet && hash && hash === infoHashFromMagnet) return true;
                        return t.category === targetCategory;
                    });

                    if (addedTorrent && addedTorrent.hash) {
                        const cleanHash = normalizeHash(addedTorrent.hash);
                        torrentUserMap.set(cleanHash, addedByUser);
                        await writeRedisMapping(TORRENT_USER_PREFIX, cleanHash, addedByUser);
                    }
                } catch (mapErr) {
                    logger.warn(`⚠️ [Torrent Service] Could not map user to torrent: ${mapErr.message}`);
                }
            }

            logger.info(`📥 [Torrent Service] Successfully queued [${targetCategory}] payload with tags [${[targetTag, userTag].filter(Boolean).join(',')}].`);
            return { success: true };
        } catch (err) {
            logger.error(`❌ [Torrent Service] Failed to add magnet to qBit: ${err.message}`);
            throw new Error("Could not communicate assignment payloads down to qBittorrent.");
        }
    }

    /**
     * Retrieves all active downloads matching our systemic workflow tags.
     */
    async getActivePipelineTorrents(filters = {}) {
        try {
            const requestedUser = normalizeUserKey(filters.addedByUser || filters.userKey);
            const requiredUserTag = buildUserTag(requestedUser);

            // Fetch everything so we capture both 'movie-stream' and 'tv-pack' tags
            const endpoint = `${QBIT_BASE_URL}/torrents/info`;
            const response = await axios.get(endpoint, { timeout: 3000 });
            
            const activeTorrents = (response.data || []).filter(t => {
    const tagStr = String(t.tags || '');
    
    // 🎯 FIX: Check for the active tag, but explicitly reject if it has already been processed
    return (tagStr.includes('movie-streamer') || tagStr.includes('series-streamer')) 
        && !tagStr.includes('-processed');
});



            // // Filter down to elements currently processing under either active pipe tag
            // return (response.data || []).filter(t => 
            //     t.tags && (t.tags.includes('movie-streamer') || t.tags.includes('series-streamer'))
            // );


            if (!requiredUserTag) {
                return activeTorrents;
            }

            return activeTorrents.filter((torrent) => {
                const tags = parseTags(torrent.tags);
                if (tags.includes(requiredUserTag)) return true;

                const hash = normalizeHash(torrent.hash);
                if (!hash) return false;
                return normalizeUserKey(torrentUserMap.get(hash)) === requestedUser;
            });
        } catch (err) {
            logger.warn(`⚠️ [Torrent Service] Pipeline target unreachable: ${err.message}`);
            return [];
        }
    }

    /**
     * Swaps systemic metadata identification tracking tokens inside the tracker client.
     * @param {string} hash Torrent identifier hex
     */
    async rotateWorkflowTags(hash, isSeries = false) {
        try {
            const oldTag = isSeries ? 'series-streamer' : 'movie-streamer';
            const newTag = isSeries ? 'series-streamer-processed' : 'movie-streamer-processed';

            // Remove ingestion tracking tags
            await axios.post(`${QBIT_BASE_URL}/torrents/removeTags`, `hashes=${hash}&tags=${oldTag}`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            // Append completion status flag metrics
            await axios.post(`${QBIT_BASE_URL}/torrents/addTags`, `hashes=${hash}&tags=${newTag}`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            logger.info(`🏷️ [Torrent Service] Rotated workflow tags cleanly for hash: ${hash}`);
            return true;
        } catch (err) {
            logger.warn(`⚠️ [Torrent Service] Tag allocation failure for hash ${hash}: ${err.message}`);
            return false;
        }
    }

    /**
     * Get IMDB ID for a torrent by hash
     * @param {string} hash 
     */
    async getImdbIdByHash(hash) {
        const cleanHash = normalizeHash(hash);
        if (!cleanHash) return null;

        const cached = torrentImdbMap.get(cleanHash);
        if (cached) return cached;

        const redisValue = await readRedisMapping(TORRENT_IMDB_PREFIX, cleanHash);
        if (redisValue) {
            torrentImdbMap.set(cleanHash, redisValue);
            return redisValue;
        }

        return null;
    }

    /**
     * Store IMDB ID for a torrent hash
     * @param {string} hash 
     * @param {string} imdbId 
     */
    async setImdbIdForHash(hash, imdbId) {
        const cleanHash = normalizeHash(hash);
        if (!cleanHash) return;
        torrentImdbMap.set(cleanHash, imdbId);
        await writeRedisMapping(TORRENT_IMDB_PREFIX, cleanHash, imdbId);
    }

    async getAddedByUserByHash(hash) {
        const cleanHash = normalizeHash(hash);
        if (!cleanHash) return null;

        const cached = normalizeUserKey(torrentUserMap.get(cleanHash));
        if (cached) return cached;

        const redisValue = normalizeUserKey(await readRedisMapping(TORRENT_USER_PREFIX, cleanHash));
        if (redisValue) {
            torrentUserMap.set(cleanHash, redisValue);
            return redisValue;
        }

        return null;
    }

    async setAddedByUserForHash(hash, userKey) {
        const cleanHash = normalizeHash(hash);
        const cleanUser = normalizeUserKey(userKey);
        if (!cleanHash || !cleanUser) return;
        torrentUserMap.set(cleanHash, cleanUser);
        await writeRedisMapping(TORRENT_USER_PREFIX, cleanHash, cleanUser);
    }

    extractAddedByUserFromTags(tags) {
        return extractUserFromTagList(parseTags(tags));
    }
}

module.exports = new TorrentService();