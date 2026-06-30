const crypto = require('crypto');
const redis = require('redis');
const logger = require('./logger');

const BASE_REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/3';
const QUEUE_REDIS_DB = process.env.QUEUE_REDIS_DB || '4';
const JOB_PREFIX = process.env.QUEUE_REDIS_PREFIX || 'joshflix:queue:job:';

function buildQueueRedisUrl() {
  if (process.env.QUEUE_REDIS_URL) return process.env.QUEUE_REDIS_URL;
  try {
    const parsed = new URL(BASE_REDIS_URL);
    parsed.pathname = `/${QUEUE_REDIS_DB}`;
    return parsed.toString();
  } catch (_err) {
    // Fallback: use provided URL as-is if parse fails.
    return BASE_REDIS_URL;
  }
}

function isRedisFeatureEnabled() {
  const raw = String(process.env.ENABLE_REDIS || '').trim().toLowerCase();
  // Default to enabled unless explicitly turned off.
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

const REDIS_URL = buildQueueRedisUrl();

let redisClient = null;
let redisConnected = false;

const jobs = new Map();

// Initialize Redis connection (non-blocking, optional)
async function initRedis() {
  if (!isRedisFeatureEnabled()) {
    logger.debug('⏭️ Queue Redis explicitly disabled (ENABLE_REDIS=false). Operating in memory-only mode.');
        return;
    }

    try {
        redisClient = redis.createClient({ url: REDIS_URL });
        redisClient.on('error', (err) => {
            logger.warn(`⚠️ Redis connection error: ${err.message}. Queue falling back to in-memory.`);
            redisConnected = false;
        });
        redisClient.on('connect', () => {
          const dbIndex = (() => {
            try {
              return new URL(REDIS_URL).pathname.replace('/', '') || '0';
            } catch (_e) {
              return 'unknown';
            }
          })();
          logger.info(`✅ Queue Redis connected. Durable job state active [DB: ${dbIndex}] [Prefix: ${JOB_PREFIX}]`);
            redisConnected = true;
        });
        await redisClient.connect();
    } catch (err) {
        logger.warn(`⚠️ Redis initialization skipped: ${err.message}. Queue operating in memory-only mode.`);
        redisClient = null;
        redisConnected = false;
    }
}

async function syncJobToRedis(job) {
    if (!redisConnected || !redisClient) return;
    try {
        await redisClient.set(
            `${JOB_PREFIX}${job.id}`,
            JSON.stringify(job),
            { EX: 86400 }
        );
    } catch (err) {
        logger.warn(`⚠️ Failed syncing job to Redis: ${err.message}`);
    }
}

async function removeJobFromRedis(id) {
    if (!redisConnected || !redisClient) return;
    try {
        await redisClient.del(`${JOB_PREFIX}${id}`);
    } catch (err) {
        logger.warn(`⚠️ Failed removing job from Redis: ${err.message}`);
    }
}

function createJob(input = {}) {
  const id = input.id || `job_${crypto.randomBytes(6).toString('hex')}`;
  const job = {
    id,
    status: input.status || 'QUEUED',
    currentStep: input.currentStep || 'INGEST',
    imdbId: input.imdbId || null,
    contentType: input.contentType || 'movie',
    payload: input.payload || {},
    history: input.history || [{ step: 'QUEUED', timestamp: new Date().toISOString() }],
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    error: null
  };

  jobs.set(id, job);
  if (redisConnected && redisClient) {
    syncJobToRedis(job).catch(err => logger.error(`Error syncing new job to Redis: ${err.message}`));
  }
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function getAllJobs() {
  return Array.from(jobs.values());
}

function getJobSnapshot(job) {
  return {
    id: job.id,
    status: job.status,
    currentStep: job.currentStep,
    imdbId: job.imdbId,
    contentType: job.contentType,
    payload: job.payload,
    history: job.history,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error
  };
}

function updateJob(job, patch = {}) {
  const existing = jobs.get(job.id);
  if (!existing) return null;

  const next = {
    ...existing,
    ...patch,
    payload: { ...existing.payload, ...(patch.payload || {}) },
    history: patch.history || existing.history,
    updatedAt: new Date().toISOString()
  };

  jobs.set(job.id, next);
  if (redisConnected && redisClient) {
    syncJobToRedis(next).catch(err => logger.error(`Error syncing updated job to Redis: ${err.message}`));
  }
  return next;
}

function getNextRunnableJob(jobList = getAllJobs()) {
  return jobList
    .filter(job => job.status === 'QUEUED')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
}

function removeJob(id) {
  jobs.delete(id);
  if (redisConnected && redisClient) {
    removeJobFromRedis(id).catch(err => logger.warn(`Failed deleting job from Redis: ${err.message}`));
  }
}

function getFailedJobs() {
  return Array.from(jobs.values()).filter(job => job.status === 'FAILED');
}

function getCompletedJobs() {
  return Array.from(jobs.values()).filter(job => job.status === 'COMPLETE');
}

function getActiveJobs() {
  return Array.from(jobs.values()).filter(job => ['QUEUED', 'PROCESSING', 'WAITING'].includes(job.status));
}

function getJobsByStatus(status) {
  return Array.from(jobs.values()).filter(job => job.status === status);
}

module.exports = {
  initRedis,
  createJob,
  getJob,
  getAllJobs,
  getJobSnapshot,
  updateJob,
  getNextRunnableJob,
  removeJob,
  getFailedJobs,
  getCompletedJobs,
  getActiveJobs,
  getJobsByStatus,
  isRedisConnected: () => redisConnected
};
