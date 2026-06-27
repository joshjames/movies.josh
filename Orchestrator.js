// ~/movie-streamer/Orchestrator.js
// Concurrency-bounded system engine routing background tasks across media volumes without resource thrashing.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./src/services/logger');
//const { rebuildLibraryCache } = require('./src/services/CacheWorker');
const LibraryScanner = require('./services/LibraryScanner'); 
const MOVIES_DIR = process.env.MOVIES_DIR || '/app/movies';

const WORKERS = {
    INGEST:    process.env.WORKER_URL_INGEST    || 'http://localhost:5000/process',
    METADATA:  process.env.WORKER_URL_METADATA  || 'http://localhost:5001/process',
    SUBTITLES: process.env.WORKER_URL_SUBTITLES || 'http://localhost:5002/process',
    TRANSCODE: process.env.WORKER_URL_TRANSCODE || 'http://localhost:5003/process',
    UPLOAD:    process.env.WORKER_URL_UPLOAD    || 'http://localhost:5004/process'
};

// In-memory set acting as our mutual exclusion mechanism to block race states
const activeJobs = new Set();

async function processAsset(folder, destinationParent) {
    const folderPath = path.join(destinationParent, folder);
    if (activeJobs.has(folderPath)) return; // Worker protection skip boundary

    const metaFilePath = path.join(folderPath, 'metadata.json');
    
    // Respect OS file-system lock rings instantly
    if (fs.existsSync(path.join(folderPath, '.processing'))) return;

    let metadata = { pipelineState: { currentStep: 'METADATA' } };
    if (fs.existsSync(metaFilePath)) {
        try { 
            metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8')); 
        } catch (e) {
            // Drop back safely if JSON got mangled mid-write cycle
            metadata = { pipelineState: { currentStep: 'METADATA' } };
        }
    }

    const currentStep = metadata.pipelineState?.currentStep || 'METADATA';
    if (currentStep === 'COMPLETED') return;

    const workerUrl = WORKERS[currentStep];
    if (!workerUrl) return;

    // Lock the item context before firing async HTTP channels
    activeJobs.add(folderPath);

    try {
        logger.log(`🤖 Dispatching asset [${folder}] to worker node [${currentStep}]`);

        const response = await axios.post(workerUrl, {
            folderPath,
            folderName: folder,
            contentType: metadata.contentType || (destinationParent.endsWith('series') ? 'series' : 'movie'),
            imdbId: metadata.imdbId || null,
            manualImdbId: metadata.manualImdbId || null
        }, { timeout: 1200000 }); // Transcodes or uploads can take time; set 20 min ceiling

        if (response.data?.success) {
            const nextStepMap = { 
                'METADATA': 'SUBTITLES', 
                'SUBTITLES': 'TRANSCODE', 
                'TRANSCODE': 'UPLOAD', 
                'UPLOAD': 'COMPLETED' 
            };
            
            const nextStep = nextStepMap[currentStep];

            // Safely merge state data fields returned by atomic worker
            metadata = {
                ...metadata,
                ...response.data.patchData,
                pipelineState: {
                    currentStep: nextStep,
                    lastUpdated: new Date().toISOString(),
                    error: null
                }
            };

            fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4));
            logger.log(`✅ Asset [${folder}] advanced successfully down-pipe to state: ${nextStep}`);

            // ⚡ AUTOMATED FLUSH: Rebuild RAM cache instantly when any item hits completion state
            if (nextStep === 'COMPLETED') {
                logger.log(`⚡ [Cache System Trigger] Asset ${folder} complete. Triggering instant library re-indexing.`);
               LibraryScanner.runLibraryScanSweep()
            .catch(err => logger.log(`Error updating database cache values: ${err.message}`, 'error'));
            }
        } else {
            logger.log(`⚠️ Worker Engine Alert [${currentStep}] on [${folder}]: ${response.data?.error}`, 'warn');
        }
    } catch (err) {
        logger.log(`❌ Failed connecting to worker endpoint [${currentStep}] on [${folder}]: ${err.message}`, 'error');
    } finally {
        // Unlock the directory space completely so subsequent loop sweeps can interact with it
        activeJobs.delete(folderPath);
    }
}
async function orchestrateStorageTree() {
    try {
        // Phase 1: Fire off the standalone download ingest cleaner endpoint first
        try {
            await axios.post(WORKERS.INGEST, {}, { timeout: 30000 });
        } catch (e) {
            logger.log(`⚠️ Ingest sanitizer pipeline check-in failed or timed out: ${e.message}`, 'warn');
        }

        // Phase 2: Traverse root tracks safely
        if (!fs.existsSync(MOVIES_DIR)) return;

        // Collect physical tracks
        const movieFolders = fs.readdirSync(MOVIES_DIR).filter(f => !f.startsWith('.') && f !== 'series');
        const seriesDir = path.join(MOVIES_DIR, 'series');
        const seriesFolders = fs.existsSync(seriesDir) ? fs.readdirSync(seriesDir).filter(f => !f.startsWith('.')) : [];

        // Concurrency cap: Process at most 2 items simultaneously to protect CPU/Disk I/O
        const CONCURRENCY_LIMIT = 2;
        let runningPromises = [];

        // Run through Movie folders
        for (const folder of movieFolders) {
            if (path.join(MOVIES_DIR, folder) === '/app/movies/sample') continue;
            if (!fs.lstatSync(path.join(MOVIES_DIR, folder)).isDirectory()) continue;

            runningPromises.push(processAsset(folder, MOVIES_DIR));
            if (runningPromises.length >= CONCURRENCY_LIMIT) {
                await Promise.all(runningPromises);
                runningPromises = [];
            }
        }

        // Run through Series folders
        for (const folder of seriesFolders) {
            if (!fs.lstatSync(path.join(seriesDir, folder)).isDirectory()) continue;

            const metaFile = path.join(seriesDir, folder, 'metadata.json');
            
            // 🔄 RESET TRIGGER: If a new file landed inside a season, drop state back to re-scan
            if (fs.existsSync(metaFile)) {
                try {
                    let meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
                    if (meta.pipelineState?.currentStep === 'COMPLETED') {
                        // Look inside the actual seasons to see if any untranscoded content needs handling
                        const seasons = fs.readdirSync(path.join(seriesDir, folder)).filter(s => s.startsWith('Season.'));
                        let hasNewFiles = false;
                        
                        for (const season of seasons) {
                            const seasonFiles = fs.readdirSync(path.join(seriesDir, folder, season));
                            // If we find raw media files that aren't accounted for in your DB structures yet, kick off the loop
                            if (seasonFiles.some(f => f.endsWith('.mp4') || f.endsWith('.mkv'))) {
                                // Simple flag: if metadata has no recorded episodes yet or total mismatch, mark it
                                if (!meta.episodes || Object.keys(meta.episodes).length === 0) {
                                    hasNewFiles = true;
                                    break;
                                }
                            }
                        }

                        if (hasNewFiles) {
                            meta.pipelineState.currentStep = 'METADATA';
                            meta.pipelineState.lastUpdated = new Date().toISOString();
                            fs.writeFileSync(metaFile, JSON.stringify(meta, null, 4));
                            logger.log(`🔄 [Orchestrator] Detected new episodic drops inside ${folder}. Resetting tracking step to METADATA.`);
                        }
                    }
                } catch (e) {
                    // Fail silently to avoid breaking the core loop on bad metadata formatting
                }
            }

            runningPromises.push(processAsset(folder, seriesDir));
            if (runningPromises.length >= CONCURRENCY_LIMIT) {
                await Promise.all(runningPromises);
                runningPromises = [];
            }
        }

        // Catch the remaining queue assignments
        if (runningPromises.length > 0) {
            await Promise.all(runningPromises);
        }

    } catch (rootErr) {
        logger.log(`🚨 Orchestrator processing block crashed: ${rootErr.message}`, 'error');
    }
}

module.exports = {
    startOrchestrator(intervalMs = 30000) {
        logger.log(`🚀 Master Pipeline Orchestrator online with concurrency boundary [Cap: 2]. Scanning every ${intervalMs}ms...`);
        orchestrateStorageTree();
        setInterval(orchestrateStorageTree, intervalMs);
    },
    
    // 🎛️ Alias exported method to satisfy the Express router invocation from the UI panel button
    async runFullAutomationPipeline() {
        logger.log(`⚡ [Manual Trigger] Manual library automation sweep invoked from admin override desk.`);
        await orchestrateStorageTree();
        return { success: true };
    }
};