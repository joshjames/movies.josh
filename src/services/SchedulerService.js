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

// Idempotent: BullMQ dedupes repeatable jobs sharing the same jobId + repeat
// config, so calling this on every SchedulerWorker startup just confirms the
// schedule instead of creating duplicates.
async function ensureMetadataMirrorSchedule() {
    const queue = getMetadataMirrorQueue();
    try {
        await queue.add(
            'sync',
            {},
            {
                jobId: METADATA_MIRROR_JOB_ID,
                repeat: { every: METADATA_MIRROR_INTERVAL_MS },
                removeOnComplete: { count: 20 },
                removeOnFail: { count: 20 }
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
