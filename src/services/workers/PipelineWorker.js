// src/services/workers/PipelineWorker.js
const axios = require('axios');
const logger = require('../../utils/logger');
const {
    createJob,
    getAllJobs,
    getJob,
    getJobSnapshot,
    updateJob,
    getNextRunnableJob
} = require('../PipelineQueueService');

const QBIT_URL = process.env.QBIT_URL || 'http://qbittorrent:8080';

let isProcessingPipeline = false;

function normalizeTags(tags) {
    if (!tags) return '';
    return Array.isArray(tags) ? tags.join(',') : String(tags);
}

function inferContentType(tagStr) {
    return tagStr.includes('series-streamer') ? 'series' : 'movie';
}

async function enqueueCompletedTorrent(torrent) {
    const tagStr = normalizeTags(torrent.tags);
    if (!tagStr.includes('movie-streamer') && !tagStr.includes('series-streamer')) return null;
    if (tagStr.includes('-processed')) return null;

    const job = createJob({
        imdbId: torrent.imdbId || null,
        contentType: inferContentType(tagStr),
        payload: {
            torrentName: torrent.name,
            rawPath: torrent.content_path || torrent.save_path || null,
            cleanPath: null,
            videoFile: null
        }
    });

    logger.info(`🧾 [Queue] Enqueued job ${job.id} for torrent ${torrent.name}`);
    return job;
}

async function processNextJob(job) {
    if (!job) return null;

    const stepMap = {
        INGEST: {
            workerUrl: 'http://127.0.0.1:5000/process',
            payload: {
                folderPath: job.payload?.rawPath || job.payload?.cleanPath || null,
                folderName: job.payload?.torrentName || job.id,
                contentType: job.contentType || 'movie'
            }
        },
        METADATA: {
            workerUrl: 'http://127.0.0.1:5001/process',
            payload: {
                folderPath: job.payload?.cleanPath || job.payload?.rawPath || null,
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (job.payload?.torrentName || job.id),
                contentType: job.contentType || 'movie',
                manualImdbId: job.imdbId || null
            }
        },
        SUBTITLES: {
            workerUrl: 'http://127.0.0.1:5002/process',
            payload: {
                folderPath: job.payload?.cleanPath || job.payload?.rawPath || null,
                imdbId: job.imdbId || null,
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (job.payload?.torrentName || job.id)
            }
        },
        TRANSCODE: {
            workerUrl: 'http://127.0.0.1:5003/process',
            payload: {
                folderPath: job.payload?.cleanPath || job.payload?.rawPath || null,
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (job.payload?.torrentName || job.id)
            }
        },
        CLOUDSYNC: {
            workerUrl: 'http://127.0.0.1:5004/process',
            payload: {
                folderPath: job.payload?.cleanPath || job.payload?.rawPath || null,
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (job.payload?.torrentName || job.id),
                imdbId: job.imdbId || null,
                contentType: job.contentType || 'movie'
            }
        }
    };

    const stepConfig = stepMap[job.currentStep];
    if (!stepConfig) {
        return updateJob(job, {
            status: 'COMPLETE',
            currentStep: 'COMPLETE',
            history: [...(job.history || []), { step: job.currentStep, timestamp: new Date().toISOString() }]
        });
    }

    try {
        logger.debug(`🧠 [Queue] Dispatching job ${job.id} to ${job.currentStep}`);
        const response = await axios.post(stepConfig.workerUrl, stepConfig.payload, { timeout: 1800000 });
        const patchData = response.data?.patchData || {};
        const nextStep = patchData.pipelineState?.currentStep || {
            INGEST: 'METADATA',
            METADATA: 'SUBTITLES',
            SUBTITLES: 'TRANSCODE',
            TRANSCODE: 'COMPLETE',
            CLOUDSYNC: 'COMPLETE'
        }[job.currentStep] || 'COMPLETE';

        const mergedPayload = {
            ...job.payload,
            ...(patchData.payload || {}),
            cleanPath: patchData.cleanPath || patchData.payload?.cleanPath || job.payload?.cleanPath || job.payload?.rawPath || null,
            rawPath: patchData.rawPath || job.payload?.rawPath || null
        };

        const updated = updateJob(job, {
            status: response.data?.success === false ? 'FAILED' : 'QUEUED',
            currentStep: response.data?.success === false ? 'FAILED' : nextStep,
            payload: mergedPayload,
            history: [
                ...(job.history || []),
                { step: job.currentStep, timestamp: new Date().toISOString() }
            ],
            error: response.data?.success === false ? response.data?.error || 'worker failed' : null
        });

        logger.debug(`🧠 [Queue] Job ${updated.id} moved to ${updated.currentStep}`);
        return updated;
    } catch (err) {
        return updateJob(job, {
            status: 'FAILED',
            currentStep: 'FAILED',
            error: err.message,
            history: [...(job.history || []), { step: job.currentStep, timestamp: new Date().toISOString() }]
        });
    }
}

async function checkPipelineCompletions() {
    if (isProcessingPipeline) return;

    try {
        // Fetch current active torrent tracking pools from qBittorrent
        const qbitRes = await axios.get(`${QBIT_URL}/api/v2/torrents/info`, { timeout: 4000 });
        const torrents = qbitRes.data || [];
        
        if (!torrents.length) return;

        // Isolate complete items belonging specifically to our pipeline types safely
        const completedTorrent = torrents.find(t => {
            if (t.progress !== 1 || !t.tags) return false;
            
            const tagStr = normalizeTags(t.tags);
            return tagStr.includes('movie-streamer') || tagStr.includes('series-streamer');
        });

        if (!completedTorrent) return;

        isProcessingPipeline = true;
        const torrentHash = completedTorrent.hash;

        const tagStr = normalizeTags(completedTorrent.tags);
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

        try {
            const job = await enqueueCompletedTorrent(completedTorrent);
            if (job) {
                const nextJob = getNextRunnableJob(getAllJobs());
                if (nextJob) {
                    await processNextJob(nextJob);
                }
            }
        } catch (queueErr) {
            logger.error(`❌ Queue processing failed: ${queueErr.message}`);
        }

        try {
            const pendingJob = getNextRunnableJob(getAllJobs());
            if (pendingJob) {
                await processNextJob(pendingJob);
            }
        } catch (pendingErr) {
            logger.error(`❌ Pending queue drain failed: ${pendingErr.message}`);
        }

        isProcessingPipeline = false;

    } catch (err) {
        isProcessingPipeline = false; 
    }
}

module.exports = {
    startPipelineWorker(intervalMs = 10000) {
        logger.debug(`⚙️  Autonomous pipeline queue manager active. Monitoring completions every ${intervalMs}ms...`);
        setInterval(checkPipelineCompletions, intervalMs);
    },
    createJob,
    getJob,
    getAllJobs,
    getJobSnapshot,
    updateJob
};