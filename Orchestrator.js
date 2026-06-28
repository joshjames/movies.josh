// ~/movie-streamer/Orchestrator.js
// Concurrency-bounded system engine routing background tasks across media volumes without resource thrashing.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./src/services/logger');
const LibraryScanner = require('./src/services/LibraryScanner'); 
const MOVIES_DIR = process.env.MOVIES_DIR || '/app/movies';

const WORKERS = {
    INGEST:    process.env.WORKER_URL_INGEST    || 'http://localhost:5000/process',
    METADATA:  process.env.WORKER_URL_METADATA  || 'http://localhost:5001/process',
    SUBTITLES: process.env.WORKER_URL_SUBTITLES || 'http://localhost:5002/process',
    TRANSCODE: process.env.WORKER_URL_TRANSCODE || 'http://localhost:5003/process',
    UPLOAD:    process.env.WORKER_URL_UPLOAD    || 'http://localhost:5004/process'
};

const activeJobs = new Set();

async function processAsset(folder, destinationParent) {
    const folderPath = path.join(destinationParent, folder);
    if (activeJobs.has(folderPath)) return; 

    // If the directory was deleted by an ingestion worker early, drop execution gracefully
    if (!fs.existsSync(folderPath)) return;

    const metaFilePath = path.join(folderPath, 'metadata.json');
    if (fs.existsSync(path.join(folderPath, '.processing'))) return;

    let metadata = { pipelineState: { currentStep: 'METADATA' } };
    if (fs.existsSync(metaFilePath)) {
        try { 
            metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8')); 
        } catch (e) {
            metadata = { pipelineState: { currentStep: 'METADATA' } };
        }
    }

    const currentStep = metadata.pipelineState?.currentStep || 'METADATA';
    if (currentStep === 'COMPLETED') return;

    const workerUrl = WORKERS[currentStep];
    if (!workerUrl) return;

    activeJobs.add(folderPath);

    try {
        logger.log(`🤖 Dispatching asset [${folder}] to worker node [${currentStep}]`);

        const response = await axios.post(workerUrl, {
            folderPath,
            folderName: folder,
            contentType: metadata.contentType || (destinationParent.endsWith('series') ? 'series' : 'movie'),
            imdbId: metadata.imdbId || null,
            manualImdbId: metadata.manualImdbId || null
        }, { timeout: 1200000 });

        if (response.data?.success) {
            // 🎯 FIX: Check if worker returned an explicit terminal step override first
            let nextStep = response.data.patchData?.pipelineState?.currentStep;

            if (!nextStep) {
                const nextStepMap = { 
                    'METADATA': 'SUBTITLES', 
                    'SUBTITLES': 'TRANSCODE', 
                    'TRANSCODE': 'UPLOAD', 
                    'UPLOAD': 'COMPLETED' 
                };
                nextStep = nextStepMap[currentStep];
            }
            
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

            // 🎯 FIX: Only write metadata file if the directory still exists on disk
            if (fs.existsSync(folderPath)) {
                fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4));
                logger.log(`✅ Asset [${folder}] advanced successfully down-pipe to state: ${nextStep}`);
            } else {
                logger.log(`✨ Asset [${folder}] path was integrated directly into backend libraries. Skipping folder state write.`);
            }

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
        activeJobs.delete(folderPath);
    }
}

async function orchestrateStorageTree() {
    try {
        // Phase 1: Standalone download ingest cleaner execution
        try {
            await axios.post(WORKERS.INGEST, {}, { timeout: 30000 });
        } catch (e) {
            logger.log(`⚠️ Ingest sanitizer pipeline check-in failed or timed out: ${e.message}`, 'warn');
        }

        // Phase 2: Traverse root tracks safely
        if (!fs.existsSync(MOVIES_DIR)) return;

        const movieFolders = fs.readdirSync(MOVIES_DIR).filter(f => !f.startsWith('.') && f !== 'series');
        const seriesDir = path.join(MOVIES_DIR, 'series');
        const seriesFolders = fs.existsSync(seriesDir) ? fs.readdirSync(seriesDir).filter(f => !f.startsWith('.')) : [];

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
            const currentFolderRoot = path.join(seriesDir, folder);
            if (!fs.existsSync(currentFolderRoot) || !fs.lstatSync(currentFolderRoot).isDirectory()) continue;

            const metaFile = path.join(seriesDir, folder, 'metadata.json');
            
            if (fs.existsSync(metaFile)) {
                try {
                    let meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
                    if (meta.pipelineState?.currentStep === 'COMPLETED') {
                        const seasons = fs.readdirSync(currentFolderRoot).filter(s => s.startsWith('Season.'));
                        let hasNewFiles = false;
                        
                        for (const season of seasons) {
                            const seasonFiles = fs.readdirSync(path.join(currentFolderRoot, season));
                            if (seasonFiles.some(f => f.endsWith('.mp4') || f.endsWith('.mkv'))) {
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
                    // Fail silently to avoid breaking loop
                }
            }

            runningPromises.push(processAsset(folder, seriesDir));
            if (runningPromises.length >= CONCURRENCY_LIMIT) {
                await Promise.all(runningPromises);
                runningPromises = [];
            }
        }

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
    
    async runFullAutomationPipeline() {
        logger.log(`⚡ [Manual Trigger] Manual library automation sweep invoked from admin override desk.`);
        await orchestrateStorageTree();
        return { success: true };
    }
};