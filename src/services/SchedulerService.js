// src/services/SchedulerService.js
// Central home for this app's BullMQ-backed recurring jobs - the ongoing
// move off ad-hoc setInterval loops and host cron jobs onto one
// queueing/scheduling backbone. See SchedulerWorker.js for the jobs'
// actual processors (all run in the one scheduler-worker container).
'use strict';

const { Queue } = require('bullmq');
const { getSchedulerRedisConnection } = require('./BullMQConnection');
const logger = require('./logger');

// Idempotent: upsertJobScheduler updates the existing scheduler in place when
// one already exists under this ID, so calling this on every SchedulerWorker
// startup just confirms the schedule instead of creating duplicates.
//
// NOTE: BullMQ v5+ removed `repeat` as a `Queue.add()` option entirely - it's
// silently ignored there now (the job just runs once, no error), so
// `upsertJobScheduler` is the only thing that actually registers a recurring
// job. Worth remembering since the old add-with-repeat pattern still shows up
// in plenty of BullMQ examples/tutorials online.
async function ensureRepeatableJob(queueName, jobId, everyMs, jobName) {
    const queue = new Queue(queueName, { connection: getSchedulerRedisConnection() });
    try {
        await queue.upsertJobScheduler(
            jobId,
            { every: everyMs },
            {
                name: jobName,
                data: {},
                opts: {
                    removeOnComplete: { count: 20 },
                    removeOnFail: { count: 20 }
                }
            }
        );
        logger.info(`[Scheduler] ${queueName} repeatable job ensured (every ${everyMs}ms).`);
    } finally {
        await queue.close();
    }
}

const METADATA_MIRROR_QUEUE_NAME = 'metadata-mirror';
const METADATA_MIRROR_JOB_ID = 'metadata-mirror-repeatable';
const METADATA_MIRROR_INTERVAL_MS = parseInt(process.env.METADATA_MIRROR_INTERVAL_MS, 10) || 30000;

async function ensureMetadataMirrorSchedule() {
    await ensureRepeatableJob(METADATA_MIRROR_QUEUE_NAME, METADATA_MIRROR_JOB_ID, METADATA_MIRROR_INTERVAL_MS, 'sync');
}

// Same cadence the old setInterval used (TV_AUTO_GET_WORKER_INTERVAL_MS,
// default 15min) - migrating the trigger mechanism first, the "smarter than
// blind polling" redesign is a separate follow-up.
const TV_AUTO_GET_QUEUE_NAME = 'tv-auto-get';
const TV_AUTO_GET_JOB_ID = 'tv-auto-get-repeatable';
const TV_AUTO_GET_INTERVAL_MS = Math.max(60 * 1000, parseInt(process.env.TV_AUTO_GET_WORKER_INTERVAL_MS, 10) || 15 * 60 * 1000);

async function ensureTvAutoGetSchedule() {
    await ensureRepeatableJob(TV_AUTO_GET_QUEUE_NAME, TV_AUTO_GET_JOB_ID, TV_AUTO_GET_INTERVAL_MS, 'check-due-rules');
}

// Was manual-trigger-only (admin Operations panel). Default daily - IMDb's
// own bulk datasets are themselves only updated daily, so anything tighter
// than that just re-downloads ~1GB+ for no new data.
const IMDB_REFRESH_QUEUE_NAME = 'imdb-refresh';
const IMDB_REFRESH_JOB_ID = 'imdb-refresh-repeatable';
const IMDB_REFRESH_INTERVAL_MS = Math.max(60 * 60 * 1000, parseInt(process.env.IMDB_REFRESH_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000);

async function ensureImdbRefreshSchedule() {
    await ensureRepeatableJob(IMDB_REFRESH_QUEUE_NAME, IMDB_REFRESH_JOB_ID, IMDB_REFRESH_INTERVAL_MS, 'refresh');
}

module.exports = {
    METADATA_MIRROR_QUEUE_NAME,
    METADATA_MIRROR_INTERVAL_MS,
    ensureMetadataMirrorSchedule,
    TV_AUTO_GET_QUEUE_NAME,
    TV_AUTO_GET_INTERVAL_MS,
    ensureTvAutoGetSchedule,
    IMDB_REFRESH_QUEUE_NAME,
    IMDB_REFRESH_INTERVAL_MS,
    ensureImdbRefreshSchedule
};
