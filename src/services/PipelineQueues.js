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

// Starting values, to be tuned against real telemetry - see the pipeline
// orchestrator plan for the reasoning behind each. CPU-bound stages
// (transcode) stay low concurrency per-replica and scale via replica count
// instead; I/O/network-bound stages get more concurrency per-replica.
const STAGE_JOB_OPTIONS = {
    SEARCH: { concurrency: 2, attempts: 2, backoff: { type: 'exponential', delay: 30000 } },
    INGEST: { concurrency: 2, attempts: 2, backoff: { type: 'fixed', delay: 5000 } },
    METADATA: { concurrency: 3, attempts: 3, backoff: { type: 'exponential', delay: 10000 } },
    SUBTITLES: { concurrency: 2, attempts: 2, backoff: { type: 'exponential', delay: 15000 } },
    TRANSCODE: { concurrency: 1, attempts: 1, backoff: { type: 'fixed', delay: 60000 } },
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
    getPipelineQueue
};
