// src/services/TorrentService.js
// Central communication interface for managing qBittorrent container transactions.

const axios = require('axios');
const FormData = require('form-data');
const logger = require('./logger');

const QBIT_BASE_URL = process.env.QBIT_API_URL || 'http://qbittorrent:8080/api/v2';

// Simple in-memory cache for torrent hash -> IMDB ID mapping
const torrentImdbMap = new Map();

class TorrentService {
    /**
     * Dispatched a formatted magnet stream download command into qBittorrent.
     * @param {string} magnetUrl 
     * @param {string} category 'movie' or 'series-streamer'
     * @param {string} imdbId Optional IMDB ID to track with torrent
     */
    async addMagnet(magnetUrl, category = 'movie', imdbId = null) {
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
            form.append('tags', targetTag);

            const endpoint = `${QBIT_BASE_URL}/torrents/add`;
            await axios.post(endpoint, form, {
                headers: form.getHeaders(),
                timeout: 5000
            });

            // After adding to qBittorrent, fetch the torrent info to get its hash
            if (imdbId) {
                try {
                    const allTorrents = await axios.get(`${QBIT_BASE_URL}/torrents/info`, { timeout: 3000 });
                    const addedTorrent = (allTorrents.data || []).find(t => t.category === targetCategory);
                    if (addedTorrent && addedTorrent.hash) {
                        torrentImdbMap.set(addedTorrent.hash, imdbId);
                        logger.debug(`🔗 [Torrent Service] Mapped hash ${addedTorrent.hash.substring(0, 8)} -> IMDB ${imdbId}`);
                    }
                } catch (mapErr) {
                    logger.warn(`⚠️ [Torrent Service] Could not map IMDB ID to torrent: ${mapErr.message}`);
                }
            }

            logger.info(`📥 [Torrent Service] Successfully queued [${targetCategory}] download payload with tag [${targetTag}].`);
            return { success: true };
        } catch (err) {
            logger.error(`❌ [Torrent Service] Failed to add magnet to qBit: ${err.message}`);
            throw new Error("Could not communicate assignment payloads down to qBittorrent.");
        }
    }

    /**
     * Retrieves all active downloads matching our systemic workflow tags.
     */
    async getActivePipelineTorrents() {
        try {
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


            return activeTorrents;
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
    getImdbIdByHash(hash) {
        return torrentImdbMap.get(hash) || null;
    }

    /**
     * Store IMDB ID for a torrent hash
     * @param {string} hash 
     * @param {string} imdbId 
     */
    setImdbIdForHash(hash, imdbId) {
        torrentImdbMap.set(hash, imdbId);
    }
}

module.exports = new TorrentService();