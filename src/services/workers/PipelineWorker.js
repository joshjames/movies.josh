// src/services/workers/PipelineWorker.js
const axios = require('axios');
const logger = require('../logger'); // Adjust depth if needed to match your log module
const Orchestrator = require('../../../Orchestrator'); // Points to ~/movie-streamer/Orchestrator.js

// Read configuration values from local environment arrays
const QBIT_URL = process.env.QBIT_URL || 'http://localhost:8080'; 

let isProcessingPipeline = false;

async function checkPipelineCompletions() {
    if (isProcessingPipeline) return;

    try {
        // 1. Fetch current active items being tracked by the platform
        const qbitRes = await axios.get(`${QBIT_URL}/api/v2/torrents/info?tag=movie-streamer`, { timeout: 4000 });
        const torrents = qbitRes.data;
        
        if (!torrents || torrents.length === 0) return;

        // Find items that hit 100% complete (progress === 1)
        const completedTorrent = torrents.find(t => t.progress === 1);
        if (!completedTorrent) return;

        isProcessingPipeline = true;
        const torrentHash = completedTorrent.hash;
        
        logger.log(`🎉 [Pipeline Agent] Download completion caught: [${completedTorrent.name}]`);

        // 2. Rotate the tags immediately to remove it from the UI "downloading" list 
        // and prevent this loop from hammering the same target twice.
        try {
            logger.log(`⚙️  Rotating workflow tags in qBittorrent for hash: ${torrentHash}`);
            
            // Remove active tracking tag
            await axios.post(`${QBIT_URL}/api/v2/torrents/removeTags`, `hashes=${torrentHash}&tags=movie-streamer`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            
            // Apply historical processing tag
            await axios.post(`${QBIT_URL}/api/v2/torrents/addTags`, `hashes=${torrentHash}&tags=movie-streamer-processed`, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            
            logger.log(`✅ Tag rotation complete. Passing context down-pipe.`);
        } catch (tagErr) {
            logger.log(`⚠️ Failed updating qBittorrent status tags: ${tagErr.message}`, 'warn');
            // If tag rotation fails, we back out to prevent losing track of the file state
            isProcessingPipeline = false;
            return;
        }



// // Inside your modernized PipelineWorker.js completion loop block:
// const completedMovie = torrents.find(t => t.progress === 1 && t.tags.includes('movie-streamer'));
// const completedShow = torrents.find(t => t.progress === 1 && t.tags.includes('series-streamer'));

// if (completedMovie) {
//     await processIngestJob(completedMovie, 'movie');
// } else if (completedShow) {
//     await processIngestJob(completedShow, 'series');
// }








        // 3. Hand control off to the new, managed Orchestrator
        try {
            logger.log(`⚡ Invoking unified Orchestrator automation tree sweep...`);
            await Orchestrator.runFullAutomationPipeline();
            logger.log(`✅ Managed background orchestrator pass completed successfully.`);
        } catch (orchErr) {
            logger.log(`❌ Orchestrator execution block failed: ${orchErr.message}`, 'error');
        }

        // Processing block release window clearance
        isProcessingPipeline = false;

    } catch (err) {
        // Catch connection dropouts or web-server timeouts safely
        isProcessingPipeline = false; 
    }
}

module.exports = {
    startPipelineWorker(intervalMs = 10000) {
        logger.log(`⚙️  Autonomous pipeline agent active. Monitoring completions every ${intervalMs}ms...`);
        setInterval(checkPipelineCompletions, intervalMs);
    }
};