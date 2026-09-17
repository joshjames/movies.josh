// src/services/SchedulerService.js
// Central home for this app's BullMQ-backed recurring jobs. Starts with just
// the metadata-mirror job (replacing the host-level rsync cron) - the first,
// lowest-stakes piece of a broader move off ad-hoc setInterval loops and
// host cron jobs, onto one queueing/scheduling backbone. See
// SchedulerWorker.js for the job's actual processor.
'use strict';

const { Queue } = require('bullmq');
const { getSchedulerRedisConnection } = require('./BullMQConnection');
const logger = require('./logger');

const METADATA_MIRROR_QUEUE_NAME = 'metadata-mirror';
const METADATA_MIRROR_JOB_ID = 'metadata-mirror-repeatable';
const METADATA_MIRROR_INTERVAL_MS = parseInt(process.env.METADATA_MIRROR_INTERVAL_MS, 10) || 30000;

function getMetadataMirrorQueue() {
    return new Queue(METADATA_MIRROR_QUEUE_NAME, { connection: getSchedulerRedisConnection() });
}

// Idempotent: upsertJobScheduler updates the existing scheduler in place when
// one already exists under this ID, so calling this on every SchedulerWorker
// startup just confirms the schedule instead of creating duplicates.
//
// NOTE: BullMQ v5+ removed `repeat` as a `Queue.add()` option entirely - it's
// silently ignored there now (the job just runs once, no error), so
// `upsertJobScheduler` is the only thing that actually registers a recurring
// job. Worth remembering since the old add-with-repeat pattern still shows up
// in plenty of BullMQ examples/tutorials online.
async function ensureMetadataMirrorSchedule() {
    const queue = getMetadataMirrorQueue();
    try {
        await queue.upsertJobScheduler(
            METADATA_MIRROR_JOB_ID,
            { every: METADATA_MIRROR_INTERVAL_MS },
            {
                name: 'sync',
                data: {},
                opts: {
                    removeOnComplete: { count: 20 },
                    removeOnFail: { count: 20 }
                }
            }
        );
        logger.info(`[Scheduler] metadata-mirror repeatable job ensured (every ${METADATA_MIRROR_INTERVAL_MS}ms).`);
    } finally {
        await queue.close();
    }
}

module.exports = {
    METADATA_MIRROR_QUEUE_NAME,
    METADATA_MIRROR_INTERVAL_MS,
    getMetadataMirrorQueue,
    ensureMetadataMirrorSchedule
};
