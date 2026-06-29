// src/services/TorrentService.js
// Central communication interface for managing qBittorrent container transactions.

const axios = require('axios');
const FormData = require('form-data');
const logger = require('./logger');

const QBIT_BASE_URL = process.env.QBIT_API_URL || 'http://qbittorrent:8080/api/v2';

class TorrentService {
    /**
     * Dispatched a formatted magnet stream download command into qBittorrent.
     * @param {string} magnetUrl 
     * @param {string} category 'movie' or 'series-streamer'
     */
    async addMagnet(magnetUrl, category = 'movie') {
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
}

module.exports = new TorrentService();