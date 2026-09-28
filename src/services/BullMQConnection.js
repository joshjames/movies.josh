// src/services/BullMQConnection.js
// Shared ioredis connection for every BullMQ queue/worker in the app.
// Always targets the primary region's Redis (REDIS_WRITE_URL, falling back
// to REDIS_URL on the primary itself where that's unset) - same convention
// PipelineQueueService.js already uses, so scheduling stays centrally
// driven from one place regardless of which region a process runs in.
// Uses a dedicated DB index, separate from the library cache (DB 3) and the
// hand-rolled pipeline job store (DB 4), so BullMQ's own keyspace never
// collides with either.
'use strict';

const IORedis = require('ioredis');

const BASE_REDIS_URL = process.env.REDIS_WRITE_URL || process.env.REDIS_URL || 'redis://redis:6379/3';
const SCHEDULER_REDIS_DB = parseInt(process.env.SCHEDULER_REDIS_DB, 10) || 5;
// Separate DB from the scheduler's (5): the pipeline stage queues run orders
// of magnitude more jobs than the 4 low-frequency periodic jobs living there,
// and keeping them apart matches the existing DB-3/4/5 partitioning - one
// concern's monitoring/backups never gets noisy with another's.
const PIPELINE_REDIS_DB = parseInt(process.env.PIPELINE_REDIS_DB, 10) || 6;

function buildRedisUrlForDb(dbIndex) {
    try {
        const parsed = new URL(BASE_REDIS_URL);
        parsed.pathname = `/${dbIndex}`;
        return parsed.toString();
    } catch (_err) {
        return BASE_REDIS_URL;
    }
}

function buildSchedulerRedisUrl() {
    return buildRedisUrlForDb(SCHEDULER_REDIS_DB);
}

function buildPipelineRedisUrl() {
    return buildRedisUrlForDb(PIPELINE_REDIS_DB);
}

let sharedSchedulerConnection = null;
let sharedPipelineConnection = null;

function getSchedulerRedisConnection() {
    if (!sharedSchedulerConnection) {
        sharedSchedulerConnection = new IORedis(buildSchedulerRedisUrl(), {
            // Required by BullMQ - it manages its own retry/backoff semantics
            // and will throw at startup if this isn't set to null.
            maxRetriesPerRequest: null
        });
    }
    return sharedSchedulerConnection;
}

function getPipelineRedisConnection() {
    if (!sharedPipelineConnection) {
        sharedPipelineConnection = new IORedis(buildPipelineRedisUrl(), {
            maxRetriesPerRequest: null
        });
    }
    return sharedPipelineConnection;
}

module.exports = {
    getSchedulerRedisConnection,
    buildSchedulerRedisUrl,
    getPipelineRedisConnection,
    buildPipelineRedisUrl
};
