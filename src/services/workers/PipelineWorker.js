// src/services/PipelineWorker.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');
// ADD THIS TO THE TOP PROTOCOLS REGION:
const TorrentService = require('../services/TorrentService');

let isProcessingPipeline = false;

async function checkPipelineCompletions() {
    if (isProcessingPipeline) return;

    try {
        const qbitRes = await axios.get('http://qbittorrent:8080/api/v2/torrents/info?tag=movie-streamer', { timeout: 4000 });
        const torrents = qbitRes.data;
        
        // Anti-Stuck Fix: Find any valid completion, rather than locking on an un-cleared zero index
        const completedTorrent = torrents.find(t => t.progress === 1);
        if (!completedTorrent) return;

        isProcessingPipeline = true;
        const torrentHash = completedTorrent.hash;
        
        logger.log(`🎉 Pipeline Watcher detected download completion: [${completedTorrent.name}]`, 'info');
        
        const pipelineProcess = spawn('node', ['/app/library-sanitizer.js']);
        const logStream = fs.createWriteStream(path.join(__dirname, '../../automation.log'), { flags: 'a' });

        logStream.write(`\n=== LIVE PIPELINE RUN: ${new Date().toISOString()} ===\n`);

        pipelineProcess.stdout.on('data', (data) => logStream.write(data));
        pipelineProcess.stderr.on('data', (data) => logStream.write(data));

        pipelineProcess.on('close', (code) => {
            if (code !== 0) {
                logger.log(`❌ Sanitizer layer exited with failure code: ${code}`, 'error');
                logStream.end();
                isProcessingPipeline = false;
                return;
            }

            logger.log(`🧹 Sanitizer pass complete. Proceeding to transcode optimizer engine...`, 'info');
            const transcodeProcess = spawn('node', ['/app/pre-transcode.js']);

            transcodeProcess.stdout.on('data', (data) => logStream.write(data));
            transcodeProcess.stderr.on('data', (data) => logStream.write(data));

            transcodeProcess.on('close', async (transcodeCode) => {
                logStream.end();

                if (transcodeCode !== 0) {
                    logger.log(`❌ Transcoder layer exited with failure code: ${transcodeCode}`, 'error');
                    isProcessingPipeline = false;
                    return;
                }

                // REPLACE THE OLD AXIOS POSTS FOR TAG ROTATION WITH THIS:
                logger.log(`✅ Media normalization and transcode loops finished cleanly. Updating tags.`, 'info');
                
                // Call our unified tag rotation service module safely
                

                
                try {
                    await axios.post('http://qbittorrent:8080/api/v2/torrents/removeTags', `hashes=${torrentHash}&tags=movie-streamer`, {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    });
                    await axios.post('http://qbittorrent:8080/api/v2/torrents/addTags', `hashes=${torrentHash}&tags=movie-streamer-processed`, {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    });
                } catch (tagErr) {
                    logger.log(`⚠️ Failed updating torrent metadata flags: ${tagErr.message}`, 'warn');
                }

                if (typeof global.rebuildLibraryCache === 'function') {
                    global.rebuildLibraryCache();
                }
                await TorrentService.rotateWorkflowTags(torrentHash);
                isProcessingPipeline = false; 
            });
        });
    } catch (err) {
        // Prevent connection timeouts down to down-pipe targets from killing loop integrity
        isProcessingPipeline = false; 
    }
}

function startPipelineWorker(intervalMs = 10000) {
    setInterval(checkPipelineCompletions, intervalMs);
    logger.log(`⚙️  Autonomous pipeline agent active. Polling loop: ${intervalMs}ms`, 'info');
}

module.exports = { startPipelineWorker };


