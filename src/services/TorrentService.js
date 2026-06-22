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
     * @param {string} category 'movie' or 'series'
     */
    async addMagnet(magnetUrl, category = 'movie') {
        try {
            const form = new FormData();
            form.append('urls', magnetUrl);
            
            // Map download target storage paths based on media categories
            const targetPath = category === 'series' ? '/downloads/series' : '/downloads';
            form.append('savepath', targetPath);
            form.append('tags', 'movie-streamer');

            const endpoint = `${QBIT_BASE_URL}/torrents/add`;
            await axios.post(endpoint, form, {
                headers: form.getHeaders(),
                timeout: 5000
            });

            logger.log(`📥 [Torrent Service] Successfully queued [${category}] download payload.`);
            return { success: true };
        } catch (err) {
            logger.log(`❌ [Torrent Service] Failed to add magnet to qBit: ${err.message}`, 'error');
            throw new Error("Could not communicate assignment payloads down to qBittorrent.");
        }
    }

    /**
     * Retrieves all active downloads matching our systemic workflow tags.
     */
    async getActivePipelineTorrents() {
        try {
            const endpoint = `${QBIT_BASE_URL}/torrents/info?tag=movie-streamer`;
            const response = await axios.get(endpoint, { timeout: 3000 });
            return response.data || [];
        } catch (err) {
            logger.log(`⚠️ [Torrent Service] Pipeline target unreachable: ${err.message}`, 'warn');
            // Return an empty array instead of crashing so file system scans can continue smoothly
            return [];
        }
    }

    /**
     * Swaps systemic metadata identification tracking tokens inside the tracker client.
     * @param {string} hash Torrent identifier hex
     */
    async rotateWorkflowTags(hash) {
        try {
            // Remove ingestion tracking tags
            await axios.post(`${QBIT_BASE_URL}/torrents/removeTags`, `hashes=${hash}&tags=movie-streamer`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            // Append completion status flag metrics
            await axios.post(`${QBIT_BASE_URL}/torrents/addTags`, `hashes=${hash}&tags=movie-streamer-processed`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            logger.log(`🏷️ [Torrent Service] Rotated workflow tags cleanly for hash: ${hash}`);
            return true;
        } catch (err) {
            logger.log(`⚠️ [Torrent Service] Tag allocation failure for hash ${hash}: ${err.message}`, 'warn');
            return false;
        }
    }
}

module.exports = new TorrentService();