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
//
// Restart safety (2026-09-28): BullMQ's QueueEvents defaults to only
// replaying events from '$' (i.e. only NEW events from the moment it
// starts) - confirmed directly against the installed bullmq version's own
// source (queue-events.js: `let id = opts.lastEventId || '$';`). This means
// any stage completion/failure that happens while this container is down
// (a deploy, a crash, anything) is silently missed forever, and the job
// would sit in 'WAITING' status with nothing ever telling it to advance.
// Fixed with `reconcileMissedCompletions()`, run once at startup before the
// live listeners attach: for every job parked in 'WAITING', it checks that
// stage's BullMQ queue directly for a job already resolved (completed or
// failed) and replays the exact same handling the live listener would have
// done. Both paths share one set of handler functions
// (handleStageCompleted/handleStageFailed), each guarded by
// `job.currentStep === stage` so replaying an already-processed or
// stale event is always a safe no-op instead of regressing a job that has
// since moved on to a later stage.
'use strict';

const fs = require('fs');
const { QueueEvents } = require('bullmq');
const logger = require('../../utils/logger');
const { getPipelineRedisConnection } = require('../BullMQConnection');
const { STAGE_QUEUE_NAMES, NEXT_STAGE, getPipelineQueue } = require('../PipelineQueues');
const { getJob, getAllJobs, updateJob } = require('../PipelineQueueService');
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

function parseReturnValue(returnvalue) {
    try {
        return typeof returnvalue === 'string' ? JSON.parse(returnvalue) : (returnvalue || {});
    } catch (_err) {
        return {};
    }
}

// Shared by the live QueueEvents listener AND reconcileMissedCompletions -
// guarded so replaying a stale/duplicate event for a job that has already
// moved past this stage is always a safe no-op.
async function handleStageCompleted(stage, jobId, returnvalue) {
    try {
        const job = await getJob(jobId);
        if (!job) {
            logger.warn(`[PipelineOrchestrator] ${stage} job ${jobId} completed but no matching pipeline item found (stale/removed) - ignoring.`);
            return;
        }
        if (job.currentStep !== stage) {
            logger.debug(`[PipelineOrchestrator] ${stage} job ${jobId} completed but job is already at ${job.currentStep} - stale/duplicate event, ignoring.`);
            return;
        }

        const result = parseReturnValue(returnvalue);
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
        // hooks/notifications, torrent cleanup) the legacy flow runs - this
        // function itself no-ops for stages/transitions that wouldn't have
        // triggered them in the legacy flow either, so it's safe to call
        // unconditionally after every stage advance.
        await runPostStageSideEffects(stage, updated);
    } catch (err) {
        logger.error(`❌ [PipelineOrchestrator] Error handling ${stage} completion for job ${jobId}: ${err.message}`);
    }
}

async function handleStageFailed(stage, jobId, failedReason) {
    try {
        const job = await getJob(jobId);
        if (!job) return;
        if (job.currentStep !== stage) {
            logger.debug(`[PipelineOrchestrator] ${stage} job ${jobId} failed but job is already at ${job.currentStep} - stale/duplicate event, ignoring.`);
            return;
        }
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
}

const activeListeners = [];

function attachStageListener(stage) {
    const queueName = STAGE_QUEUE_NAMES[stage];
    const events = new QueueEvents(queueName, { connection: getPipelineRedisConnection() });
    activeListeners.push(events);

    events.on('completed', ({ jobId, returnvalue }) => handleStageCompleted(stage, jobId, returnvalue));
    events.on('failed', ({ jobId, failedReason }) => handleStageFailed(stage, jobId, failedReason));

    logger.info(`🧭 [PipelineOrchestrator] Listening for completions on ${queueName} (stage ${stage}).`);
}

// Restart safety: catches any job whose stage resolved (in BullMQ) while
// nothing was listening (any pipeline-runner downtime - a deploy, a crash,
// anything). Only jobs in 'WAITING' are at risk - that's the status this
// service's own dispatch branch (PipelineWorker.js) sets right after
// enqueueing a stage, specifically so the legacy tick loop won't re-pick it
// up; a plain 'QUEUED' job is never at risk since the tick loop re-reads and
// re-dispatches it regardless of how long the container was down.
async function reconcileMissedCompletions() {
    let jobs;
    try {
        jobs = await getAllJobs();
    } catch (err) {
        logger.error(`❌ [PipelineOrchestrator] Startup reconciliation could not read job list: ${err.message}`);
        return;
    }

    const waitingJobs = jobs.filter((job) => String(job?.status || '').toUpperCase() === 'WAITING');
    if (waitingJobs.length === 0) {
        logger.info('🧭 [PipelineOrchestrator] Startup reconciliation: no WAITING jobs to check.');
        return;
    }

    logger.info(`🧭 [PipelineOrchestrator] Startup reconciliation: checking ${waitingJobs.length} WAITING job(s) for missed completions...`);
    let recovered = 0;

    for (const job of waitingJobs) {
        const stage = job.currentStep;
        if (!STAGE_QUEUE_NAMES[stage]) continue; // not a BullMQ-migrated stage (shouldn't happen for WAITING, but be defensive)

        try {
            const queue = getPipelineQueue(stage);
            const bullJob = await queue.getJob(job.id);
            if (!bullJob) {
                // Nothing found under this id - either genuinely still in
                // flight under a different mechanism, or lost to
                // removeOnComplete/removeOnFail cleanup before we got here.
                // Leave it; if it's truly stuck, it'll surface as a job that
                // never leaves WAITING for an admin to investigate.
                continue;
            }

            const state = await bullJob.getState();
            if (state === 'completed') {
                logger.warn(`🧭 [PipelineOrchestrator] Recovering missed completion for job ${job.id} (${stage}) - resolved while this container was down.`);
                await handleStageCompleted(stage, job.id, bullJob.returnvalue);
                recovered += 1;
            } else if (state === 'failed') {
                logger.warn(`🧭 [PipelineOrchestrator] Recovering missed failure for job ${job.id} (${stage}) - resolved while this container was down.`);
                await handleStageFailed(stage, job.id, bullJob.failedReason);
                recovered += 1;
            }
            // 'active'/'waiting'/'delayed' - genuinely still in flight, leave
            // it for the live listener (or the next restart's reconciliation).
        } catch (err) {
            logger.error(`❌ [PipelineOrchestrator] Startup reconciliation failed for job ${job.id} (${stage}): ${err.message}`);
        }
    }

    logger.info(`🧭 [PipelineOrchestrator] Startup reconciliation complete: ${recovered}/${waitingJobs.length} job(s) recovered.`);
}

async function startPipelineOrchestrator() {
    await reconcileMissedCompletions();

    attachStageListener('INGEST');
    attachStageListener('METADATA');
    attachStageListener('SUBTITLES');
    attachStageListener('TRANSCODE');
    attachStageListener('CLOUDSYNC');
}

module.exports = { startPipelineOrchestrator };
