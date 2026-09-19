# Scheduled & Orchestrated Tasks — Architecture

## Why this doc

This app used to run every recurring job as its own bare `setInterval` loop,
scattered across whichever file happened to own that job, each with its own
ad-hoc retry/locking story. Starting 2026-09-17 these are being migrated
one at a time onto **BullMQ** (Redis-backed queues), for one queueing/
scheduling backbone instead of N different bespoke ones, and so a future
admin dashboard can show one view of every task's status/history/retries
instead of grepping container logs per job.

This doc is the standard pattern to follow for any *new* recurring or
orchestrated task, and the map of what's already migrated vs what's still
on the old model. Written from the actual code, not from the original
design intent - if something here stops matching the code, trust the code
and fix this doc.

## The pattern

Every BullMQ-backed job in this app follows the same shape:

1. **A shared Redis connection** - `BullMQConnection.js`'s
   `getSchedulerRedisConnection()`. Always an `ioredis` client (BullMQ
   requires `ioredis`, not the `redis` package the rest of the app uses),
   always pointed at the *primary* region's Redis (`REDIS_WRITE_URL`, same
   convention as `PipelineQueueService.js`), always DB index 5 - kept
   separate from the library cache (DB 3) and the pipeline job store (DB 4)
   so BullMQ's own keyspace never collides with either. `maxRetriesPerRequest:
   null` is required by BullMQ itself; leaving it unset throws at Worker
   startup.

2. **A schedule-ensuring function in `SchedulerService.js`** - every job gets
   a `QUEUE_NAME` constant, a fixed `JOB_ID` for its repeatable schedule, an
   interval (usually env-overridable), and an `ensureXSchedule()` function
   that calls the shared `ensureRepeatableJob(queueName, jobId, everyMs,
   jobName)` helper. This is the ONLY place that registers a queue's
   recurring schedule.

   **BullMQ v5+ removed `repeat` as a `Queue.add()` option** - passing it
   is silently ignored (the job just runs once, no error). The only thing
   that actually creates a recurring schedule is `queue.upsertJobScheduler()`,
   which `ensureRepeatableJob()` already wraps. Every new job must go through
   it - don't reach for `queue.add(name, data, { repeat })` from a tutorial,
   it doesn't do what it looks like it does on this BullMQ version.

   `upsertJobScheduler` is idempotent by job ID, so calling `ensureXSchedule()`
   on every container startup just confirms the existing schedule rather than
   creating duplicates - no separate "has this been set up before" check
   needed anywhere.

3. **A `Worker` instance that actually processes the job.** This is the one
   part that does NOT have a single fixed location - see "Two topologies"
   below for where a given job's `Worker` should live.

## Two topologies

**A) Centralized, in `scheduler-worker`** - the default. Most scheduled jobs
have no meaningful reason to run in their own container: they're periodic,
independent, and don't need dedicated scaling. These all run as separate
`Worker` instances inside the one `scheduler-worker` container/process
(`src/services/workers/SchedulerWorker.js`), which does nothing else -
`main()` there calls every job's `ensureXSchedule()` then constructs one
`Worker` per queue. Use this for a new job unless you have a specific reason
not to.

**B) In-place, inside an existing dedicated worker container** - for a job
whose actual work has to run somewhere specific for reasons unrelated to
scheduling (network reachability, resource isolation, independent
restart/scaling). The pipeline tick is the current example: its `Worker`
runs inside `PipelineWorker.js`, consumed by the `pipeline-runner` container,
NOT inside `scheduler-worker` - because `checkPipelineCompletions()` needs
that container's own reachability to qBittorrent and the per-stage worker
containers, and pipeline-runner already exists as its own independently
deployed/scaled container. Folding it into `scheduler-worker` would buy
nothing except a less clear architecture. `SchedulerService.js` still owns
the queue name and schedule-ensuring call either way - only the `Worker`
construction moves.

When adding a job, default to (A). Only reach for (B) if the job's actual
work is already tightly coupled to a specific existing container.

## Current inventory

| Job | Queue name | Interval | Worker runs in | What it does |
|---|---|---|---|---|
| Metadata mirror | `metadata-mirror` | 30s (`METADATA_MIRROR_INTERVAL_MS`) | `scheduler-worker` | rsyncs metadata/subtitles/covers/etc from LA to every satellite (replaced a host cron) |
| TV auto-get | `tv-auto-get` | 15min (`TV_AUTO_GET_WORKER_INTERVAL_MS`) | `scheduler-worker` | tiered EZTV/qBittorrent-search acquisition for subscribed shows' new episodes |
| IMDb refresh | `imdb-refresh` | daily (`IMDB_REFRESH_INTERVAL_MS`) | `scheduler-worker` | downloads IMDb TSV datasets, rebuilds the IMDb catalog, then chains into the TMDb catalog build (same job, since the TMDb step reads the IMDb step's own output) |
| Pipeline tick | `pipeline-tick` | 10s (`PIPELINE_POLL_INTERVAL_MS`) | `pipeline-runner` (in-place, topology B) | runs `checkPipelineCompletions()` - the pipeline orchestrator's heartbeat (see "Pipeline chain" below) |

Each queue/schedule constant lives in `SchedulerService.js`; each `scheduler-worker`-hosted job's actual processor lives in `SchedulerWorker.js`.

## Adding a new scheduled job (recipe)

1. In `SchedulerService.js`: add `MY_JOB_QUEUE_NAME`, a fixed job ID, an
   interval constant (env-overridable, with a sane floor via `Math.max`),
   and an `ensureMyJobSchedule()` that calls `ensureRepeatableJob(...)`.
   Export all three.
2. Decide topology A or B (see above). For A (the default): in
   `SchedulerWorker.js`, call your new `ensureMyJobSchedule()` inside
   `main()`, then construct a `new Worker(MY_JOB_QUEUE_NAME, async (job) =>
   {...}, { connection: getSchedulerRedisConnection(), concurrency: 1 })`
   with `completed`/`failed` log listeners, following the existing three as
   a template.
3. Don't set `attempts`/backoff unless the job specifically needs retries
   within a single tick - a failed repeatable job just tries again on its
   next scheduled tick regardless, which is usually the right behavior for
   a periodic task.
4. Make sure whatever the job actually calls **throws on real failure**
   rather than swallowing its own errors - see the pipeline tick's history
   below for why this matters.
5. Test locally with `forceAll`-style manual triggers where the underlying
   function supports it (e.g. `processDueRules({ forceAll: true })`) before
   relying on the schedule alone.

## Pipeline chain - migration status

The core content pipeline (torrent completion -> ingest -> metadata ->
subtitles -> transcode -> cloudsync -> library) is the most load-bearing
part of the app, so it's being migrated last and in phases rather than all
at once - see the design note this doc is meant to accompany (memory:
`project_pipeline_bullmq_design`, or ask a future session to recall it).

**Phase 1 (done)**: only the *trigger* moved to BullMQ. `PipelineWorker.js`'s
`startPipelineWorker()` used to be a raw `setInterval(checkPipelineCompletions,
intervalMs)`; it's now a `pipeline-tick` BullMQ repeatable job (topology B,
runs inside `pipeline-runner`). `checkPipelineCompletions()` itself,
`PipelineQueueService.js`'s Redis job-blob store, and the HTTP-orchestrated
per-stage worker chain (`processNextJob()` POSTing to ingest/metadata/
subtitle/transcoder/cloudsync-worker in turn) are all completely unchanged.

This phase also fixed a real bug it exposed: `checkPipelineCompletions()`'s
top-level `catch` used to swallow every error silently (not even logged) -
a tick that failed for any reason (Redis down, qBittorrent unreachable)
looked identical to a tick with nothing to do. It now logs and rethrows,
so a real failure shows up as a failed BullMQ job instead of vanishing.

**Not yet done** - individual pipeline jobs (one per piece of content moving
through ingest->cloudsync) are still plain Redis-blob records in
`PipelineQueueService.js`, not first-class BullMQ jobs. That's a bigger,
riskier change (it's read/written by several other routes beyond the
pipeline worker itself - the admin queue UI, retry/alternate-source
endpoints, `SeriesAutoGetService.js`) and is deliberately deferred until
there's a concrete reason to take it on, rather than migrated pre-emptively.
