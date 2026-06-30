// src/services/workers/PipelineWorker.js
const axios = require('axios');
const logger = require('../../utils/logger');
const TorrentService = require('../TorrentService');
const {
    createJob,
    getAllJobs,
    getJob,
    getJobSnapshot,
    updateJob
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

function findPendingDownloadJob(torrent) {
    const allJobs = getAllJobs();
    const torrentHash = String(torrent.hash || '').toLowerCase();
    const torrentName = String(torrent.name || '').trim();

    return allJobs.find(job => {
        if (job.status !== 'WAITING_DOWNLOAD') return false;
        const jobHash = String(job.payload?.torrentHash || '').toLowerCase();
        const jobName = String(job.payload?.torrentName || '').trim();
        if (torrentHash && jobHash && torrentHash === jobHash) return true;
        return torrentName && jobName && torrentName === jobName;
    }) || null;
}

async function enqueueCompletedTorrent(torrent) {
    const tagStr = normalizeTags(torrent.tags);
    if (!tagStr.includes('movie-streamer') && !tagStr.includes('series-streamer')) return null;
    if (tagStr.includes('-processed')) return null;

    // Retrieve IMDB ID from TorrentService mapping
    const imdbId = TorrentService.getImdbIdByHash(torrent.hash);

    const pendingJob = findPendingDownloadJob(torrent);
    if (pendingJob) {
        const resumed = updateJob(pendingJob, {
            status: 'QUEUED',
            imdbId: pendingJob.imdbId || imdbId || null,
            payload: {
                ...pendingJob.payload,
                torrentHash: torrent.hash || pendingJob.payload?.torrentHash || null,
                torrentName: torrent.name || pendingJob.payload?.torrentName || pendingJob.id,
                rawPath: torrent.content_path || torrent.save_path || null,
                cleanPath: null,
                videoFile: null
            },
            error: null
        });
        logger.info(`🔁 [Queue] Resumed placeholder job ${resumed.id} for completed torrent ${torrent.name}`);
        return resumed;
    }

    const existingJob = getAllJobs().find(job => {
        const jobHash = String(job.payload?.torrentHash || '').toLowerCase();
        const jobName = String(job.payload?.torrentName || '').trim();
        const torrentHash = String(torrent.hash || '').toLowerCase();
        const torrentName = String(torrent.name || '').trim();
        return (torrentHash && jobHash && torrentHash === jobHash) || (torrentName && jobName && torrentName === jobName);
    });

    if (existingJob && ['QUEUED', 'PROCESSING', 'WAITING_DOWNLOAD'].includes(existingJob.status)) {
        logger.info(`↩️ [Queue] Reusing existing job ${existingJob.id} for completed torrent ${torrent.name}`);
        return updateJob(existingJob, {
            status: 'QUEUED',
            payload: {
                ...existingJob.payload,
                torrentHash: torrent.hash || existingJob.payload?.torrentHash || null,
                torrentName: torrent.name || existingJob.payload?.torrentName || existingJob.id,
                rawPath: torrent.content_path || torrent.save_path || existingJob.payload?.rawPath || null
            },
            error: null
        });
    }

    const job = createJob({
        status: 'QUEUED',
        currentStep: 'INGEST',
        imdbId: imdbId || null,
        contentType: inferContentType(tagStr),
        payload: {
            torrentHash: torrent.hash || null,
            torrentName: torrent.name,
            rawPath: torrent.content_path || torrent.save_path || null,
            cleanPath: null,
            videoFile: null
        }
    });

    logger.info(`💾 [Queue] Enqueued job ${job.id} for torrent ${torrent.name} (IMDB: ${imdbId || 'unknown'})`);
    return job;
}

async function processNextJob(job) {
    if (!job) return null;

    logger.debug(
        `🧭 [Queue] Processing job ${job.id} | status=${job.status} | step=${job.currentStep} | imdbId=${job.imdbId || 'unknown'} | hasRawPath=${Boolean(job.payload?.rawPath)} | hasCleanPath=${Boolean(job.payload?.cleanPath)}`
    );

    // Prevent accidental global ingest sweep when a pre-download placeholder job leaks into runnable state.
    if (job.currentStep === 'INGEST' && !(job.payload?.rawPath || job.payload?.cleanPath)) {
        logger.warn(`⏭️ [Queue] Deferring job ${job.id}: missing folder path for INGEST.`);
        return updateJob(job, {
            status: 'WAITING_DOWNLOAD',
            error: 'Waiting for completed download path before INGEST dispatch.'
        });
    }

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
        logger.debug(`🧠 [Queue] Dispatching job ${job.id} to ${job.currentStep} -> ${stepConfig.workerUrl}`);
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

        logger.debug(
            `📦 [Queue] ${job.id} ${job.currentStep} response: success=${response.data?.success !== false} | nextStep=${nextStep} | patchKeys=${Object.keys(patchData).join(',') || 'none'}`
        );

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

        if (updated.status === 'QUEUED' && updated.currentStep !== 'COMPLETE' && updated.currentStep !== 'FAILED') {
            logger.debug(`🔁 [Queue] Continuing job ${updated.id} to ${updated.currentStep}`);
            return processNextJob(updated);
        }

        return updated;
    } catch (err) {
        logger.error(`❌ [Queue] Job ${job.id} failed during ${job.currentStep}: ${err.message}`);
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
            if (tagStr.includes('-processed')) return false;
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
                logger.debug(`🚦 [Queue] Starting pipeline chain for job ${job.id}`);
                await processNextJob(job);
            }
        } catch (queueErr) {
            logger.error(`❌ Queue processing failed: ${queueErr.message}`);
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