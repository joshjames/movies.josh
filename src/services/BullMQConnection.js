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

function buildSchedulerRedisUrl() {
    try {
        const parsed = new URL(BASE_REDIS_URL);
        parsed.pathname = `/${SCHEDULER_REDIS_DB}`;
        return parsed.toString();
    } catch (_err) {
        return BASE_REDIS_URL;
    }
}

let sharedConnection = null;

function getSchedulerRedisConnection() {
    if (!sharedConnection) {
        sharedConnection = new IORedis(buildSchedulerRedisUrl(), {
            // Required by BullMQ - it manages its own retry/backoff semantics
            // and will throw at startup if this isn't set to null.
            maxRetriesPerRequest: null
        });
    }
    return sharedConnection;
}

module.exports = { getSchedulerRedisConnection, buildSchedulerRedisUrl };
