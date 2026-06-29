// ~/movie-streamer/Orchestrator.js
// Concurrency-bounded system engine routing background tasks across media volumes without resource thrashing.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./src/services/logger');
const LibraryScanner = require('./src/services/LibraryScanner'); 
const MOVIES_DIR = process.env.MOVIES_DIR || '/app/movies';

const WORKERS = {
    INGEST:    process.env.WORKER_URL_INGEST    || 'http://movie-streamer-v2-test:5000/process',
    METADATA:  process.env.WORKER_URL_METADATA  || 'http://movie-streamer-v2-test:5001/process',
    SUBTITLES: process.env.WORKER_URL_SUBTITLES || 'http://movie-streamer-v2-test:5002/process',
    TRANSCODE: process.env.WORKER_URL_TRANSCODE || 'http://movie-streamer-v2-test:5003/process',
    UPLOAD:    process.env.WORKER_URL_UPLOAD    || 'http://movie-streamer-v2-test:5004/process'
};

const activeJobs = new Set();

async function processAsset(folder, destinationParent) {
    const folderPath = path.join(destinationParent, folder);
    logger.debug(`processAsset start folder=${folder} path=${folderPath}`);
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
        logger.debug(`🤖 Dispatching asset [${folder}] to worker node [${currentStep}] - path=${folderPath}`);

        const response = await axios.post(workerUrl, {
            folderPath,
            folderName: folder,
            contentType: metadata.contentType || (destinationParent.endsWith('series') ? 'series' : 'movie'),
            imdbId: metadata.imdbId || null,
            manualImdbId: metadata.manualImdbId || null
        }, { timeout: 1200000 });

        logger.debug(`Worker response status=${response.status} success=${!!response.data?.success}`);

        if (response.data?.success) {
            // 🎯 FIX: Check if worker returned an explicit terminal step override first
            let nextStep = response.data.patchData?.pipelineState?.currentStep;

            if (!nextStep) {
                const nextStepMap = { 
                    'METADATA': 'SUBTITLES', 
                    'SUBTITLES': 'TRANSCODE', 
                    'TRANSCODE': 'COMPLETED'
                    // 'UPLOAD': 'COMPLETED' 
                };
                nextStep = nextStepMap[currentStep];
            }
            if (nextStep === 'UPLOAD') {
                logger.debug(`⚠️ Intercepted legacy 'UPLOAD' step from worker patch on [${folder}]. Forcing terminal state: COMPLETED.`);
                nextStep = 'COMPLETED';
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
                logger.debug(`✅ Asset [${folder}] advanced successfully down-pipe to state: ${nextStep}`);
            } else {
                logger.debug(`✨ Asset [${folder}] path was integrated directly into backend libraries. Skipping folder state write.`);
            }

            // ⚡ AUTOMATED FLUSH: Rebuild RAM cache instantly when any item hits completion state
            if (nextStep === 'COMPLETED') {
                logger.debug(`⚡ [Cache System Trigger] Asset ${folder} complete. Triggering instant library re-indexing.`);
                LibraryScanner.runLibraryScanSweep()
                    .catch(err => logger.error(`Error updating database cache values: ${err.message}`));
            }
        } else {
            logger.error(`⚠️ Worker Engine Alert [${currentStep}] on [${folder}]: ${response.data?.error}`);
        }
    } catch (err) {
        logger.error(`❌ Failed connecting to worker endpoint [${currentStep}] on [${folder}]: ${err.message}`);
    } finally {
        activeJobs.delete(folderPath);
        logger.debug(`processAsset end folder=${folder} path=${folderPath}`);
    }
} 

async function orchestrateStorageTree() {
    try {
        // Phase 1: Standalone download ingest cleaner execution (Global discovery pass)
        try {
            logger.debug(`🔍 Phase 1: Triggering global recursive Ingest sweep...`);
            await axios.post(WORKERS.INGEST, {}, { timeout: 30000 });
        } catch (e) {
            logger.error(`⚠️ Ingest sanitizer pipeline check-in failed or timed out: ${e.message}`);
        }

        // Phase 2: Traverse root tracks safely
        if (!fs.existsSync(MOVIES_DIR)) {
            logger.error(`🚨 Target storage volume path allocation missing: ${MOVIES_DIR}`);
            return;
        }

        const movieFolders = fs.readdirSync(MOVIES_DIR).filter(f => !f.startsWith('.') && f !== 'series');
        const seriesDir = path.join(MOVIES_DIR, 'series');
        const seriesFolders = fs.existsSync(seriesDir) ? fs.readdirSync(seriesDir).filter(f => !f.startsWith('.')) : [];

        const CONCURRENCY_LIMIT = 2;
        let runningPromises = [];

        // =====================================================================
        // 🎬 MOVIE DIRECTORY LOOP
        // =====================================================================
        for (const folder of movieFolders) {
            const targetFullPath = path.join(MOVIES_DIR, folder);
            if (targetFullPath === '/app/movies/sample') continue;
            if (!fs.lstatSync(targetFullPath).isDirectory()) continue;

            logger.debug(`🔎 [Orchestrator Evaluation] Found movie folder node: [${folder}]. Assessing status...`);

            const metaFilePath = path.join(targetFullPath, 'metadata.json');
            
            // Check for active transcoding processing locks
            if (fs.existsSync(path.join(targetFullPath, '.processing'))) {
                logger.debug(`skip [Orchestrator Evaluation] Skipping [${folder}] - Active lock .processing file exists.`);
                continue;
            }

            // 🎯 FIX: Bootstraps files without metadata files straight into the INGEST step
            if (!fs.existsSync(metaFilePath)) {
                logger.debug(`🆕 [Orchestrator Evaluation] No metadata found for [${folder}]. Initializing pipeline state to: INGEST`);
                const initialSeed = {
                    pipelineState: {
                        currentStep: 'INGEST',
                        lastUpdated: new Date().toISOString(),
                        error: null
                    }
                };
                try {
                    fs.writeFileSync(metaFilePath, JSON.stringify(initialSeed, null, 4));
                } catch (writeErr) {
                    logger.error(`❌ Failed writing initial tracking state for [${folder}]: ${writeErr.message}`);
                    continue;
                }
            }

            // Queue asset processing execution window
            runningPromises.push(processAsset(folder, MOVIES_DIR));
            if (runningPromises.length >= CONCURRENCY_LIMIT) {
                await Promise.all(runningPromises);
                runningPromises = [];
            }
        }

        // =====================================================================
        // 📺 TV SERIES DIRECTORY LOOP
        // =====================================================================
        for (const folder of seriesFolders) {
            const currentFolderRoot = path.join(seriesDir, folder);
            if (!fs.existsSync(currentFolderRoot) || !fs.lstatSync(currentFolderRoot).isDirectory()) continue;

            logger.debug(`🔎 [Orchestrator Evaluation] Found TV show folder node: [${folder}]. Assessing status...`);

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
                            logger.debug(`🔄 [Orchestrator] Detected new episodic drops inside ${folder}. Resetting tracking step to METADATA.`);
                        }
                    }
                } catch (e) {
                    // Fail silently to avoid breaking loop execution
                }
            } else {
                // Seed fallback for untracked TV shows
                logger.debug(`🆕 [Orchestrator Evaluation] No metadata found for TV Show [${folder}]. Seeding INGEST tracking loop.`);
                const initialTvSeed = { pipelineState: { currentStep: 'INGEST', lastUpdated: new Date().toISOString() } };
                try { fs.writeFileSync(metaFile, JSON.stringify(initialTvSeed, null, 4)); } catch (e) {}
            }

            runningPromises.push(processAsset(folder, seriesDir));
            if (runningPromises.length >= CONCURRENCY_LIMIT) {
                await Promise.all(runningPromises);
                runningPromises = [];
            }
        }

        // Catch remaining processing promises
        if (runningPromises.length > 0) {
            await Promise.all(runningPromises);
        }

    } catch (rootErr) {
        logger.error(`🚨 Orchestrator processing block crashed: ${rootErr.message}`);
    }
}

module.exports = {
    startOrchestrator(intervalMs = 30000) {
        logger.debug(`🚀 Master Pipeline Orchestrator online with concurrency boundary [Cap: 2]. Scanning every ${intervalMs}ms...`);
        orchestrateStorageTree();
        setInterval(orchestrateStorageTree, intervalMs);
    },
    
    async runFullAutomationPipeline() {
        logger.debug(`⚡ [Manual Trigger] Manual library automation sweep invoked from admin override desk.`);
        await orchestrateStorageTree();
        return { success: true };
    }
};