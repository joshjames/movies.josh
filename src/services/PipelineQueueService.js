const crypto = require('crypto');
const redis = require('redis');
const logger = require('./logger');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const JOB_PREFIX = 'pipeline:job:';

let redisClient = null;
let redisConnected = false;

const jobs = new Map();

// Initialize Redis connection (non-blocking, optional)
async function initRedis() {
    if (!process.env.ENABLE_REDIS || process.env.ENABLE_REDIS === 'false') {
        logger.debug('⏭️ Redis disabled. Queue operating in memory-only mode.');
        return;
    }

    try {
        redisClient = redis.createClient({ url: REDIS_URL });
        redisClient.on('error', (err) => {
            logger.warn(`⚠️ Redis connection error: ${err.message}. Queue falling back to in-memory.`);
            redisConnected = false;
        });
        redisClient.on('connect', () => {
            logger.info('✅ Redis connected. Queue state is now durable.');
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
    status: 'QUEUED',
    currentStep: 'INGEST',
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
    .filter(job => ['QUEUED', 'WAITING'].includes(job.status))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
}

function removeJob(id) {
  jobs.delete(id);
  if (redisConnected && redisClient) {
    removeJobFromRedis(id).catch(err => logger.warn(`Failed deleting job from Redis: ${err.message}`));
  }
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
  isRedisConnected: () => redisConnected
};
