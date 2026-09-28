// src/services/workers/PipelineOrchestratorService.js
// The "orchestrator" half of the phased pipeline-queue redesign: listens for
// completion/failure on each migrated stage's real BullMQ queue, validates
// the actual output (not just "the job didn't throw"), and only then hands
// the pipeline item back to the legacy PipelineQueueService/PipelineWorker
// flow for its next stage - by flipping status back to 'QUEUED' with the
// next currentStep, exactly like a normal legacy-flow advance. When the
// stage that just completed is the last one (CLOUDSYNC), it runs the same
// post-stage side effects (library scan, notifications, torrent cleanup)
// the legacy flow runs on completion, via the shared
// runPostStageSideEffects helper - so a job finishing through the new path
// behaves identically to one that finished through the old one.
//
// All 5 stages are migrated as of the pipeline orchestrator redesign's
// "straight through" pass - every stage now has a live BullMQ consumer
// Worker (see IngestSanitizerWorker.js / MetadataWorker.js /
// SubtitleWorker.js / TranscoderWorker.js / CloudSyncWorker.js). SEARCH and
// WAITING_DOWNLOAD deliberately stay outside this queue graph (see the plan
// doc) - they're handled by PipelineWorker.js's existing tick/poll logic.
'use strict';

const fs = require('fs');
const { QueueEvents } = require('bullmq');
const logger = require('../../utils/logger');
const { getPipelineRedisConnection } = require('../BullMQConnection');
const { STAGE_QUEUE_NAMES, NEXT_STAGE } = require('../PipelineQueues');
const { getJob, updateJob } = require('../PipelineQueueService');
const { persistPipelinePatchToDisk, runPostStageSideEffects } = require('./PipelineWorker');

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return null;
    return `tt${cleaned}`;
}

// Per-stage sanity check on the worker's own reported output, run before
// ever promoting to the next stage - this is deliberately separate from
// "did the BullMQ job resolve without throwing". The substantive honesty
// fixes for partial-failure masking (MetadataWorker/TranscoderWorker/
// CloudSyncWorker all used to conflate "something worked" with "everything
// worked") live inside each worker itself now, so by the time a job reaches
// 'completed' here its own success flag is already trustworthy - these
// validators are a second, independent sanity layer, not a duplicate of
// that work.
const STAGE_VALIDATORS = {
    INGEST: (result) => {
        const folderPath = result?.patchData?.folderPath;
        if (!folderPath) {
            return { ok: false, reason: 'Ingest response carried no folderPath to advance with.' };
        }
        if (!fs.existsSync(folderPath)) {
            return { ok: false, reason: `Ingest reported success but target folder does not exist on disk: ${folderPath}` };
        }
        return { ok: true };
    },
    METADATA: (result) => {
        if (!result || typeof result !== 'object') {
            return { ok: false, reason: 'Metadata response was empty or malformed.' };
        }
        if (!result.patchData?.title) {
            return { ok: false, reason: 'Metadata response carried no title to advance with.' };
        }
        if (Array.isArray(result.failedSeasons) && result.failedSeasons.length > 0) {
            // Not a hard failure - a per-season OMDb/TMDb hiccup can heal on a
            // later pass - but worth a loud log line rather than silence.
            logger.warn(`⚠️ [PipelineOrchestrator] Metadata succeeded with ${result.failedSeasons.length} failed season(s): ${result.failedSeasons.join(', ')}`);
        }
        return { ok: true };
    },
    SUBTITLES: (result) => {
        if (!result || !Array.isArray(result.patchData?.subtitles)) {
            return { ok: false, reason: 'Subtitle response did not include a subtitles array.' };
        }
        return { ok: true };
    },
    TRANSCODE: (result) => {
        if (!result || typeof result !== 'object') {
            return { ok: false, reason: 'Transcode response was empty or malformed.' };
        }
        return { ok: true };
    },
    CLOUDSYNC: (result) => {
        if (!result || typeof result !== 'object') {
            return { ok: false, reason: 'Cloud sync response was empty or malformed.' };
        }
        return { ok: true };
    }
};

function validateStageOutput(stage, result) {
    const validator = STAGE_VALIDATORS[stage];
    if (!validator) return { ok: true };
    try {
        return validator(result);
    } catch (err) {
        return { ok: false, reason: `Validator threw: ${err.message}` };
    }
}

const activeListeners = [];

function attachStageListener(stage) {
    const queueName = STAGE_QUEUE_NAMES[stage];
    const events = new QueueEvents(queueName, { connection: getPipelineRedisConnection() });
    activeListeners.push(events);

    events.on('completed', async ({ jobId, returnvalue }) => {
        try {
            const job = await getJob(jobId);
            if (!job) {
                logger.warn(`[PipelineOrchestrator] ${stage} job ${jobId} completed but no matching pipeline item found (stale/removed) - ignoring.`);
                return;
            }

            let result = {};
            try {
                result = typeof returnvalue === 'string' ? JSON.parse(returnvalue) : (returnvalue || {});
            } catch (_err) {
                result = {};
            }

            const verdict = validateStageOutput(stage, result);
            if (!verdict.ok) {
                logger.error(`❌ [PipelineOrchestrator] ${stage} job ${jobId} failed validation: ${verdict.reason}`);
                await updateJob(job, {
                    status: 'FAILED',
                    currentStep: 'FAILED',
                    error: verdict.reason,
                    history: [...(job.history || []), { step: `${stage}_VALIDATION_FAILED`, timestamp: new Date().toISOString() }]
                });
                return;
            }

            const patchData = result.patchData || {};
            const nextStep = NEXT_STAGE[stage] || 'COMPLETE';
            const isPipelineDone = nextStep === 'COMPLETE';
            const resolvedImdbId = normalizeImdbId(
                patchData.imdbId || job.imdbId || job.payload?.imdbId || job.payload?.queueContext?.imdbId
            ) || null;

            const mergedPayload = {
                ...job.payload,
                ...(patchData.payload || {}),
                cleanPath:
                    patchData.cleanPath ||
                    patchData.folderPath ||
                    job.payload?.cleanPath ||
                    job.payload?.rawPath ||
                    null,
                imdbId: resolvedImdbId
            };

            const metadataPath = await persistPipelinePatchToDisk(job, patchData, nextStep, resolvedImdbId);
            if (metadataPath) {
                logger.debug(`📝 [PipelineOrchestrator] Persisted metadata snapshot for job ${job.id} at ${metadataPath}`);
            }

            const updated = await updateJob(job, {
                status: isPipelineDone ? 'COMPLETE' : 'QUEUED',
                currentStep: nextStep,
                imdbId: resolvedImdbId,
                payload: mergedPayload,
                error: null,
                history: [...(job.history || []), { step: `${stage}_BULLMQ_COMPLETE`, timestamp: new Date().toISOString() }]
            });

            logger.info(`✅ [PipelineOrchestrator] ${stage} validated for job ${jobId}, promoted to ${nextStep}.`);

            // Same side effects (library scan, recent-feed card, completion
            // hooks/notifications, torrent cleanup) the legacy flow runs -
            // this function itself no-ops for stages/transitions that
            // wouldn't have triggered them in the legacy flow either, so it's
            // safe to call unconditionally after every stage advance.
            await runPostStageSideEffects(stage, updated);
        } catch (err) {
            logger.error(`❌ [PipelineOrchestrator] Error handling ${stage} completion for job ${jobId}: ${err.message}`);
        }
    });

    events.on('failed', async ({ jobId, failedReason }) => {
        try {
            const job = await getJob(jobId);
            if (!job) return;
            logger.error(`❌ [PipelineOrchestrator] ${stage} job ${jobId} failed permanently: ${failedReason}`);
            await updateJob(job, {
                status: 'FAILED',
                currentStep: 'FAILED',
                error: failedReason || `${stage} worker failed`,
                history: [...(job.history || []), { step: `${stage}_BULLMQ_FAILED`, timestamp: new Date().toISOString() }]
            });
        } catch (err) {
            logger.error(`❌ [PipelineOrchestrator] Error handling ${stage} failure for job ${jobId}: ${err.message}`);
        }
    });

    logger.info(`🧭 [PipelineOrchestrator] Listening for completions on ${queueName} (stage ${stage}).`);
}

function startPipelineOrchestrator() {
    attachStageListener('INGEST');
    attachStageListener('METADATA');
    attachStageListener('SUBTITLES');
    attachStageListener('TRANSCODE');
    attachStageListener('CLOUDSYNC');
}

module.exports = { startPipelineOrchestrator };
