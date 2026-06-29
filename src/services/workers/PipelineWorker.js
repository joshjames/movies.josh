// src/services/workers/PipelineWorker.js
const axios = require('axios');
const logger = require('../../utils/logger'); 
const Orchestrator = require('../../../Orchestrator'); 

const QBIT_URL = process.env.QBIT_URL || 'http://qbittorrent:8080'; 

let isProcessingPipeline = false;

async function checkPipelineCompletions() {
    if (isProcessingPipeline) return;

    try {
        // Fetch current active torrent tracking pools from qBittorrent
        const qbitRes = await axios.get(`${QBIT_URL}/api/v2/torrents/info`, { timeout: 4000 });
        const torrents = qbitRes.data;
        
        if (!torrents || torrents.length === 0) return;

        // Isolate complete items belonging specifically to our pipeline types safely
        const completedTorrent = torrents.find(t => {
            if (t.progress !== 1 || !t.tags) return false;
            
            // Normalize tags to a string for bulletproof substring matching
            const tagStr = Array.isArray(t.tags) ? t.tags.join(',') : String(t.tags);
            return tagStr.includes('movie-streamer') || tagStr.includes('series-streamer');
        });

        if (!completedTorrent) return;

        isProcessingPipeline = true;
        const torrentHash = completedTorrent.hash;

        // Determine if it's a show or movie by testing the normalized tag string
        const tagStr = Array.isArray(completedTorrent.tags) ? completedTorrent.tags.join(',') : String(completedTorrent.tags);
        const isSeries = tagStr.includes('series-streamer');

        const activeTag = isSeries ? 'series-streamer' : 'movie-streamer';
        const processedTag = isSeries ? 'series-streamer-processed' : 'movie-streamer-processed';

        logger.debug(`🎉 [Pipeline Agent] Download completion caught: [${completedTorrent.name}] (${isSeries ? 'TV Show' : 'Movie'})`);

        // Inside src/services/workers/PipelineWorker.js -> checkPipelineCompletions()

        // Rotate the workflow tag to prevent looping on the same item twice
        try {
            logger.debug(`⚙️  Rotating workflow tags [${activeTag} -> ${processedTag}] for hash: ${torrentHash}`);
            
            // Use URLSearchParams directly for strict urlencoded delivery
            const removeParams = new URLSearchParams();
            removeParams.append('hashes', torrentHash);
            removeParams.append('tags', activeTag);

            const addParams = new URLSearchParams();
            addParams.append('hashes', torrentHash);
            addParams.append('tags', processedTag);

            // 🎯 CRITICAL: Execute these sequentially and verify they complete
            await axios.post(`${QBIT_URL}/api/v2/torrents/removeTags`, removeParams.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            
            await axios.post(`${QBIT_URL}/api/v2/torrents/addTags`, addParams.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            
            logger.debug(`✅ Tag rotation complete for hash ${torrentHash.substring(0,8)}. Triggering down-pipe automation.`);
        } catch (tagErr) {
            logger.error(`⚠️ Failed updating qBittorrent status tags: ${tagErr.message}`);
            isProcessingPipeline = false; // Release the lock so next check can recover
            return; // Drop out early! Do not run orchestrator if tag assignment failed
        }

        // Invoke Orchestrator for local media directory structural sweeps
        try {
            logger.debug(`⚡ Invoking unified Orchestrator automation tree sweep...`);
            await Orchestrator.runFullAutomationPipeline();
            logger.debug(`✅ Managed background orchestrator pass completed successfully.`);
        } catch (orchErr) {
            logger.error(`❌ Orchestrator execution block failed: ${orchErr.message}`, 'error');
        }

        isProcessingPipeline = false;

    } catch (err) {
        isProcessingPipeline = false; 
    }
}

module.exports = {
    startPipelineWorker(intervalMs = 10000) {
        logger.debug(`⚙️  Autonomous pipeline agent active. Monitoring completions every ${intervalMs}ms...`);
        setInterval(checkPipelineCompletions, intervalMs);
    }
};