// src/services/PipelineQueues.js
// Shared definitions for the per-stage BullMQ pipeline queues (the
// stage-by-stage migration off PipelineWorker.js's single-job-at-a-time HTTP
// dispatch loop - see the "Pipeline orchestrator redesign" plan). Each stage
// gets its own queue name + tuned concurrency/retry options, so a worker
// container can `new Worker(STAGE_QUEUE_NAMES.INGEST, ...)` and the
// orchestrator can enqueue/inspect the same queue by stage name.
//
// Only stages actually migrated have a live consumer Worker - queues for
// not-yet-migrated stages are defined here for forward-consistency but have
// nothing consuming them yet (PipelineWorker.js's legacy HTTP dispatch still
// handles those).
'use strict';

const { Queue } = require('bullmq');
const { getPipelineRedisConnection } = require('./BullMQConnection');

const STAGE_ORDER = ['SEARCH', 'INGEST', 'METADATA', 'SUBTITLES', 'TRANSCODE', 'CLOUDSYNC'];

const NEXT_STAGE = {
    SEARCH: 'INGEST',
    INGEST: 'METADATA',
    METADATA: 'SUBTITLES',
    SUBTITLES: 'TRANSCODE',
    TRANSCODE: 'CLOUDSYNC',
    CLOUDSYNC: null
};

const STAGE_QUEUE_NAMES = {
    SEARCH: 'pipeline-search',
    INGEST: 'pipeline-ingest',
    METADATA: 'pipeline-metadata',
    SUBTITLES: 'pipeline-subtitles',
    TRANSCODE: 'pipeline-transcode',
    CLOUDSYNC: 'pipeline-cloudsync'
};

// BullMQ needs the event loop free to periodically renew a job's lock -
// confirmed live (2026-09-28) that TranscoderWorker.js's execSync-based
// ffmpeg calls block the event loop for the whole encode, so the default
// 30s lockDuration expired mid-transcode on a real movie (a few seconds was
// never a problem in earlier synthetic testing with tiny test videos). When
// the lock expires, BullMQ's stalled-job recovery re-dispatches the SAME
// job a second time; the first (real, successful) run then loses the race
// to report its own result once the lock is gone, and the second
// (redundant, "nothing left to do") run's response - missing patchData -
// is what actually gets recorded. Matches the app's own existing 30-minute
// axios timeout convention for a single stage call (comfortably longer than
// any real single ffmpeg/upload operation) rather than the BullMQ default.
const LOCK_DURATION_MS = 40 * 60 * 1000;

// Starting values, to be tuned against real telemetry - see the pipeline
// orchestrator plan for the reasoning behind each. CPU-bound stages
// (transcode) stay low concurrency per-replica and scale via replica count
// instead; I/O/network-bound stages get more concurrency per-replica.
const STAGE_JOB_OPTIONS = {
    SEARCH: { concurrency: 2, attempts: 2, backoff: { type: 'exponential', delay: 30000 } },
    INGEST: { concurrency: 2, attempts: 2, backoff: { type: 'fixed', delay: 5000 } },
    METADATA: { concurrency: 3, attempts: 3, backoff: { type: 'exponential', delay: 10000 } },
    SUBTITLES: { concurrency: 2, attempts: 2, backoff: { type: 'exponential', delay: 15000 } },
    // attempts:2 (not 1) - now that partial-batch failures fail loudly
    // (see TranscoderWorker.js), a retry costs little: already-transcoded
    // files are skipped via their own existsSync check, so a retry only
    // reprocesses whatever actually failed last time.
    TRANSCODE: { concurrency: 1, attempts: 2, backoff: { type: 'fixed', delay: 60000 } },
    CLOUDSYNC: { concurrency: 2, attempts: 3, backoff: { type: 'exponential', delay: 15000 } }
};

const queueCache = new Map();

function getPipelineQueue(stage) {
    const queueName = STAGE_QUEUE_NAMES[stage];
    if (!queueName) {
        throw new Error(`Unknown pipeline stage: ${stage}`);
    }
    if (!queueCache.has(stage)) {
        queueCache.set(stage, new Queue(queueName, { connection: getPipelineRedisConnection() }));
    }
    return queueCache.get(stage);
}

module.exports = {
    STAGE_ORDER,
    NEXT_STAGE,
    STAGE_QUEUE_NAMES,
    STAGE_JOB_OPTIONS,
    LOCK_DURATION_MS,
    getPipelineQueue
};
