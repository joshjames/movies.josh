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

// Unlike the three jobs above, this queue's consumer Worker does NOT run in
// the central scheduler-worker container - it runs inside PipelineWorker.js/
// PipelineRunner.js's own dedicated pipeline-runner container, since that's
// where checkPipelineCompletions()'s qBittorrent/worker-container network
// access already lives, and there's no reason to fold a separately-scaled
// container into scheduler-worker just to centralize a queue definition.
// This module still owns the queue name + schedule-ensuring call for
// consistency - see docs/scheduled-tasks.md for the full pattern writeup.
const PIPELINE_TICK_QUEUE_NAME = 'pipeline-tick';
const PIPELINE_TICK_JOB_ID = 'pipeline-tick-repeatable';

async function ensurePipelineTickSchedule(intervalMs) {
    const safeInterval = Math.max(1000, parseInt(intervalMs, 10) || 10000);
    await ensureRepeatableJob(PIPELINE_TICK_QUEUE_NAME, PIPELINE_TICK_JOB_ID, safeInterval, 'tick');
}

// Layer 1 of the "rows are JSON files" browse/home-page redesign - builds
// the public/shared rows (Top on Netflix, Popular, Recently Added, etc.)
// from TMDb + the local library. Daily by default, same reasoning as
// imdb-refresh: the underlying data (what's popular/streaming) doesn't
// meaningfully change faster than once a day.
const PUBLIC_ROWS_QUEUE_NAME = 'public-rows-refresh';
const PUBLIC_ROWS_JOB_ID = 'public-rows-refresh-repeatable';
const PUBLIC_ROWS_INTERVAL_MS = Math.max(60 * 60 * 1000, parseInt(process.env.PUBLIC_ROWS_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000);

async function ensurePublicRowsSchedule() {
    await ensureRepeatableJob(PUBLIC_ROWS_QUEUE_NAME, PUBLIC_ROWS_JOB_ID, PUBLIC_ROWS_INTERVAL_MS, 'build-rows');
}

// Bulk B2->R2 migration (2026-10-12 storage migration - see
// CloudStorageService.js and /home/epic/.claude/plans/peppy-dancing-yao.md).
// Two jobs: a slow "build" pass that walks the library for anything not yet
// provider:'r2' and tops up a small persistent queue file, and a fast
// "sweep" pass that pops a few items off it per tick - that batch size +
// interval IS the rate limit, deliberately conservative given the B2
// network incident this migration is a response to.
const R2_MIGRATION_BUILD_QUEUE_NAME = 'r2-migration-build';
const R2_MIGRATION_BUILD_JOB_ID = 'r2-migration-build-repeatable';
const R2_MIGRATION_BUILD_INTERVAL_MS = Math.max(60 * 60 * 1000, parseInt(process.env.R2_MIGRATION_BUILD_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000);

async function ensureR2MigrationBuildSchedule() {
    await ensureRepeatableJob(R2_MIGRATION_BUILD_QUEUE_NAME, R2_MIGRATION_BUILD_JOB_ID, R2_MIGRATION_BUILD_INTERVAL_MS, 'build-queue');
}

const R2_MIGRATION_SWEEP_QUEUE_NAME = 'r2-migration-sweep';
const R2_MIGRATION_SWEEP_JOB_ID = 'r2-migration-sweep-repeatable';
const R2_MIGRATION_SWEEP_INTERVAL_MS = Math.max(10 * 1000, parseInt(process.env.R2_MIGRATION_SWEEP_INTERVAL_MS, 10) || 30 * 1000);

async function ensureR2MigrationSweepSchedule() {
    await ensureRepeatableJob(R2_MIGRATION_SWEEP_QUEUE_NAME, R2_MIGRATION_SWEEP_JOB_ID, R2_MIGRATION_SWEEP_INTERVAL_MS, 'sweep');
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
    ensureImdbRefreshSchedule,
    PIPELINE_TICK_QUEUE_NAME,
    ensurePipelineTickSchedule,
    PUBLIC_ROWS_QUEUE_NAME,
    ensurePublicRowsSchedule,
    R2_MIGRATION_BUILD_QUEUE_NAME,
    R2_MIGRATION_BUILD_INTERVAL_MS,
    ensureR2MigrationBuildSchedule,
    R2_MIGRATION_SWEEP_QUEUE_NAME,
    R2_MIGRATION_SWEEP_INTERVAL_MS,
    ensureR2MigrationSweepSchedule
};
