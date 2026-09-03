const crypto = require('crypto');
const redis = require('redis');
const logger = require('./logger');

const DEFAULT_REDIS_HOST = process.env.REDIS_HOST || 'redis';
const DEFAULT_REDIS_PORT = process.env.REDIS_PORT || '6379';
// Job persistence is a write path, so it must target the writable primary
// (REDIS_WRITE_URL), not REDIS_URL/REDIS_READ_URL - on a satellite region
// those point at a local read replica that rejects writes outright (see
// db.js's cross-geo split comment). Same bug class as TorrentService.js /
// AcquisitionQuotaService.js.
const BASE_REDIS_URL = process.env.REDIS_WRITE_URL || process.env.REDIS_URL || `redis://${DEFAULT_REDIS_HOST}:${DEFAULT_REDIS_PORT}/3`;
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

async function hydrateJobsFromRedis() {
  if (!redisConnected || !redisClient) return;

  try {
    let loaded = 0;
    for await (const scanEntry of redisClient.scanIterator({ MATCH: `${JOB_PREFIX}*`, COUNT: 200 })) {
      const keys = Array.isArray(scanEntry) ? scanEntry : [scanEntry];
      for (const key of keys) {
        if (typeof key !== 'string') {
          logger.warn(`⚠️ Failed hydrating queue entry (non-string key): ${JSON.stringify(key)}`);
          continue;
        }

        try {
          const raw = await redisClient.get(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (!parsed || !parsed.id) continue;
          jobs.set(parsed.id, parsed);
          loaded += 1;
        } catch (entryErr) {
          logger.warn(`⚠️ Failed hydrating queue entry ${key}: ${entryErr.message}`);
        }
      }
    }

    if (loaded > 0) {
      logger.info(`♻️ Queue state restored from Redis: ${loaded} job(s) rehydrated.`);
    }
  } catch (err) {
    logger.warn(`⚠️ Queue rehydration skipped: ${err.message}`);
  }
}

// Rebuild the local `jobs` Map from a fresh Redis scan. This is the source of
// truth refresh used by every read function below, so that a job created,
// updated, or removed by ANOTHER process (a different container) is reflected
// here too - not just whatever this process happened to load at boot or
// write itself. It's a full clear-and-rebuild (not a merge) so that jobs
// deleted elsewhere actually disappear from the local view as well.
async function refreshJobsFromRedis() {
  if (!isRedisFeatureEnabled() || !redisConnected || !redisClient) return;

  try {
    const freshJobs = new Map();
    for await (const scanEntry of redisClient.scanIterator({ MATCH: `${JOB_PREFIX}*`, COUNT: 200 })) {
      const keys = Array.isArray(scanEntry) ? scanEntry : [scanEntry];
      for (const key of keys) {
        if (typeof key !== 'string') {
          logger.warn(`⚠️ Failed refreshing queue entry (non-string key): ${JSON.stringify(key)}`);
          continue;
        }

        try {
          const raw = await redisClient.get(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (!parsed || !parsed.id) continue;
          freshJobs.set(parsed.id, parsed);
        } catch (entryErr) {
          logger.warn(`⚠️ Failed refreshing queue entry ${key}: ${entryErr.message}`);
        }
      }
    }

    jobs.clear();
    for (const [id, job] of freshJobs) {
      jobs.set(id, job);
    }
  } catch (err) {
    logger.warn(`⚠️ Queue refresh from Redis skipped: ${err.message}`);
  }
}

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
        await hydrateJobsFromRedis();
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

async function createJob(input = {}) {
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
    await syncJobToRedis(job);
  }
  return job;
}

async function getJob(id) {
  await refreshJobsFromRedis();
  return jobs.get(id) || null;
}

async function getAllJobs() {
  await refreshJobsFromRedis();
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

async function updateJob(job, patch = {}) {
  await refreshJobsFromRedis();
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
    await syncJobToRedis(next);
  }
  return next;
}

async function getNextRunnableJob(jobList) {
  const list = jobList || await getAllJobs();
  return list
    .filter(job => job.status === 'QUEUED')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
}

async function removeJob(id) {
  jobs.delete(id);
  if (redisConnected && redisClient) {
    await removeJobFromRedis(id);
  }
}

async function getFailedJobs() {
  await refreshJobsFromRedis();
  return Array.from(jobs.values()).filter(job => job.status === 'FAILED');
}

async function getCompletedJobs() {
  await refreshJobsFromRedis();
  return Array.from(jobs.values()).filter(job => job.status === 'COMPLETE');
}

async function getActiveJobs() {
  await refreshJobsFromRedis();
  return Array.from(jobs.values()).filter(job => ['QUEUED', 'PROCESSING', 'WAITING'].includes(job.status));
}

async function getJobsByStatus(status) {
  await refreshJobsFromRedis();
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
