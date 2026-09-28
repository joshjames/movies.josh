// src/services/workers/PipelineOrchestratorService.js
// The "orchestrator" half of the phased pipeline-queue redesign: listens for
// completion/failure on each migrated stage's real BullMQ queue, validates
// the actual output (not just "the job didn't throw"), and only then hands
// the pipeline item back to the legacy PipelineQueueService/PipelineWorker
// flow for its next stage - by flipping status back to 'QUEUED' with the
// next currentStep, exactly like a normal legacy-flow advance.
//
// Only INGEST is migrated so far (see the pipeline orchestrator plan) - this
// file only attaches a listener for stages that actually have a BullMQ
// consumer Worker; not-yet-migrated stages keep going through
// PipelineWorker.js's direct axios dispatch untouched.
'use strict';

const fs = require('fs');
const { QueueEvents } = require('bullmq');
const logger = require('../../utils/logger');
const { getPipelineRedisConnection } = require('../BullMQConnection');
const { STAGE_QUEUE_NAMES, NEXT_STAGE } = require('../PipelineQueues');
const { getJob, updateJob } = require('../PipelineQueueService');
const { persistPipelinePatchToDisk } = require('./PipelineWorker');

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return null;
    return `tt${cleaned}`;
}

// Per-stage sanity check on the worker's own reported output, run before
// ever promoting to the next stage - this is deliberately separate from
// "did the BullMQ job resolve without throwing", since the whole point of
// this redesign is catching the class of bug already confirmed across every
// worker (CloudSyncWorker/TranscoderWorker/etc all conflate partial success
// with full success). Only INGEST has a check today; add one per stage as
// each stage gets migrated.
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

            await updateJob(job, {
                status: 'QUEUED',
                currentStep: nextStep,
                imdbId: resolvedImdbId,
                payload: mergedPayload,
                error: null,
                history: [...(job.history || []), { step: `${stage}_BULLMQ_COMPLETE`, timestamp: new Date().toISOString() }]
            });

            logger.info(`✅ [PipelineOrchestrator] ${stage} validated for job ${jobId}, promoted to ${nextStep}.`);
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
    // Only stages with a live BullMQ consumer Worker get a listener - see the
    // module comment. Extend this list as each stage is migrated.
    attachStageListener('INGEST');
}

module.exports = { startPipelineOrchestrator };
