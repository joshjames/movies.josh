// src/services/AcquisitionStatusService.js
// Standalone "what should the user see" status layer, decoupled from the
// pipeline's own internal stage model (STAGE_ORDER/NEXT_STAGE in
// PipelineQueues.js, currently SEARCH -> INGEST -> METADATA -> SUBTITLES ->
// TRANSCODE -> CLOUDSYNC - and that list has already been reshuffled more
// than once this project). The internal stage model is allowed to keep
// changing; this module is the one place that knows how to translate
// whatever it currently looks like into the small, stable vocabulary the
// user-facing UI actually shows: searching / acquiring / processing / done
// / error / manual.
//
// Deliberately not a state machine - just "here's the current simplified
// stage for this job", overwritten each time, with a short TTL so a crashed
// job doesn't leave a permanent stale entry. Single integration point: this
// gets called from PipelineQueueService.js's createJob()/updateJob() (the
// one universal write path every job state change already goes through,
// across every process - web server, pipeline-runner, admin retry actions -
// see those functions for why that's the right hook rather than touching
// each individual stage worker). Nothing else needs to change.
'use strict';

const redis = require('redis');
const logger = require('./logger');

const DEFAULT_REDIS_HOST = process.env.REDIS_HOST || 'redis';
const DEFAULT_REDIS_PORT = process.env.REDIS_PORT || '6379';
// Same REDIS_WRITE_URL-over-REDIS_URL precedence as PipelineQueueService.js -
// a satellite's REDIS_URL/REDIS_READ_URL points at a local read replica that
// rejects writes, and this is a write path.
const BASE_REDIS_URL = process.env.REDIS_WRITE_URL || process.env.REDIS_URL || `redis://${DEFAULT_REDIS_HOST}:${DEFAULT_REDIS_PORT}/3`;
const STATUS_REDIS_DB = process.env.ACQUISITION_STATUS_REDIS_DB || '6';
const STATUS_PREFIX = process.env.ACQUISITION_STATUS_PREFIX || 'joshflix:acq-status:';
const USER_INDEX_PREFIX = `${STATUS_PREFIX}user:`;
const JOB_KEY_PREFIX = `${STATUS_PREFIX}job:`;
// Covers a crashed/orphaned job that never reaches a terminal state and
// never gets explicitly cleared - without this, it would otherwise show in
// "my active acquisitions" forever.
const ENTRY_TTL_SECONDS = Number(process.env.ACQUISITION_STATUS_TTL_SECONDS || 6 * 60 * 60);

function buildStatusRedisUrl() {
    if (process.env.ACQUISITION_STATUS_REDIS_URL) return process.env.ACQUISITION_STATUS_REDIS_URL;
    try {
        const parsed = new URL(BASE_REDIS_URL);
        parsed.pathname = `/${STATUS_REDIS_DB}`;
        return parsed.toString();
    } catch (_err) {
        return BASE_REDIS_URL;
    }
}

let client = null;
let connected = false;
let connectPromise = null;

async function ensureClient() {
    if (connected && client) return client;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
        try {
            client = redis.createClient({ url: buildStatusRedisUrl() });
            client.on('error', (err) => {
                connected = false;
                logger.warn(`[AcquisitionStatus] Redis connection error: ${err.message}`);
            });
            await client.connect();
            connected = true;
            return client;
        } catch (err) {
            connected = false;
            logger.warn(`[AcquisitionStatus] Redis connect failed: ${err.message}`);
            return null;
        } finally {
            connectPromise = null;
        }
    })();

    return connectPromise;
}

// The small, stable vocabulary the frontend widget is built against. Keep
// this list short on purpose - see the acquisition-ux-overhaul plan.
const UI_STAGES = {
    SEARCHING: 'searching',
    ACQUIRING: 'acquiring',
    PROCESSING: 'processing',
    DONE: 'done',
    ERROR: 'error',
    MANUAL: 'manual'
};

const PROCESSING_STEPS = new Set(['INGEST', 'METADATA', 'SUBTITLES', 'TRANSCODE', 'CLOUDSYNC']);

// Returns null for a status/currentStep combination this layer has nothing
// user-facing to say about (e.g. a job already marked MANUAL shouldn't get
// silently overwritten back to 'error' by a stale duplicate event - callers
// check job.status themselves before re-reporting in that case, same
// stale/duplicate guard already used throughout PipelineOrchestratorService).
function resolveUiStage({ status, currentStep } = {}) {
    const st = String(status || '').toUpperCase();
    const step = String(currentStep || '').toUpperCase();

    if (st === 'FAILED') return UI_STAGES.ERROR;
    if (st === 'COMPLETE' || step === 'COMPLETE') return UI_STAGES.DONE;
    if (st === 'WAITING_DOWNLOAD') return UI_STAGES.ACQUIRING;
    if (step === 'SEARCH') return UI_STAGES.SEARCHING;
    if (PROCESSING_STEPS.has(step)) return UI_STAGES.PROCESSING;
    return null;
}

function extractUserKey(job) {
    return String(
        job?.payload?.queueContext?.addedByUser
        || job?.payload?.addedByUser
        || ''
    ).toLowerCase().trim() || null;
}

function extractTitle(job) {
    return job?.payload?.mediaTitle
        || job?.payload?.torrentName
        || (job?.payload?.cleanPath || job?.payload?.rawPath || '').split('/').filter(Boolean).pop()
        || job?.id
        || 'Untitled';
}

// Called by PipelineQueueService.js after every createJob()/updateJob() -
// best-effort by design (wrapped so it can never throw back into the
// caller): a Redis hiccup here must never block or fail the actual pipeline
// job it's just reporting on.
async function reportJobState(job) {
    try {
        if (!job?.id) return;
        const uiStage = resolveUiStage(job);
        if (!uiStage) return;

        const userKey = extractUserKey(job);
        const entry = {
            jobId: job.id,
            uiStage,
            title: extractTitle(job),
            imdbId: job.imdbId || null,
            contentType: job.contentType || null,
            userKey,
            error: uiStage === UI_STAGES.ERROR || uiStage === UI_STAGES.MANUAL ? (job.error || null) : null,
            updatedAt: new Date().toISOString()
        };

        const redisClient = await ensureClient();
        if (!redisClient) return;

        const jobKey = `${JOB_KEY_PREFIX}${job.id}`;
        await redisClient.set(jobKey, JSON.stringify(entry), { EX: ENTRY_TTL_SECONDS });

        if (userKey) {
            const userSetKey = `${USER_INDEX_PREFIX}${userKey}`;
            if (uiStage === UI_STAGES.DONE) {
                // Done jobs drop out of "my active acquisitions" immediately -
                // the widget has nothing ongoing left to show for them. The
                // entry itself (jobKey above) still exists briefly under its
                // own TTL in case something reads it directly right after.
                await redisClient.sRem(userSetKey, job.id);
            } else {
                await redisClient.sAdd(userSetKey, job.id);
                await redisClient.expire(userSetKey, ENTRY_TTL_SECONDS);
            }
        }
    } catch (err) {
        logger.warn(`[AcquisitionStatus] reportJobState failed for job ${job?.id}: ${err.message}`);
    }
}

async function getJobStatus(jobId) {
    try {
        const redisClient = await ensureClient();
        if (!redisClient) return null;
        const raw = await redisClient.get(`${JOB_KEY_PREFIX}${jobId}`);
        return raw ? JSON.parse(raw) : null;
    } catch (err) {
        logger.warn(`[AcquisitionStatus] getJobStatus failed for job ${jobId}: ${err.message}`);
        return null;
    }
}

// Active = whatever's currently in the user's index set, each entry
// resolved to its live job record (a DONE/expired job is simply skipped,
// self-cleaning rather than needing a separate sweep).
async function getActiveForUser(userKey) {
    try {
        const cleanUser = String(userKey || '').toLowerCase().trim();
        if (!cleanUser) return [];

        const redisClient = await ensureClient();
        if (!redisClient) return [];

        const userSetKey = `${USER_INDEX_PREFIX}${cleanUser}`;
        const jobIds = await redisClient.sMembers(userSetKey);
        if (!jobIds.length) return [];

        const entries = await Promise.all(jobIds.map((jobId) => getJobStatus(jobId)));
        const live = entries.filter(Boolean);

        const staleIds = jobIds.filter((jobId, index) => !entries[index]);
        if (staleIds.length) {
            await redisClient.sRem(userSetKey, staleIds);
        }

        return live;
    } catch (err) {
        logger.warn(`[AcquisitionStatus] getActiveForUser failed for ${userKey}: ${err.message}`);
        return [];
    }
}

// Explicit dismiss/cancel - removes the entry outright rather than waiting
// on its TTL, and drops it from the user's active set.
async function clearJobStatus(jobId, userKey = null) {
    try {
        const redisClient = await ensureClient();
        if (!redisClient) return;
        await redisClient.del(`${JOB_KEY_PREFIX}${jobId}`);
        if (userKey) {
            await redisClient.sRem(`${USER_INDEX_PREFIX}${String(userKey).toLowerCase().trim()}`, jobId);
        }
    } catch (err) {
        logger.warn(`[AcquisitionStatus] clearJobStatus failed for job ${jobId}: ${err.message}`);
    }
}

module.exports = {
    UI_STAGES,
    resolveUiStage,
    reportJobState,
    getJobStatus,
    getActiveForUser,
    clearJobStatus
};
