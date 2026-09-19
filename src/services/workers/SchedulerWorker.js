// src/services/workers/SchedulerWorker.js
// Dedicated always-on process (its own container, see docker-compose.yml's
// scheduler-worker service) driving this app's BullMQ jobs. Starts with the
// metadata-mirror job: mirrors metadata.json/subtitles/covers/etc from this
// (primary) region down to every registered satellite, replacing the
// host-level rsync cron that did this before - same rsync-based transfer,
// now owned by the app and triggered by BullMQ's repeatable-job scheduling
// instead of an external crontab entry.
'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { Worker } = require('bullmq');
const { getSchedulerRedisConnection } = require('../BullMQConnection');
const {
    METADATA_MIRROR_QUEUE_NAME,
    ensureMetadataMirrorSchedule,
    TV_AUTO_GET_QUEUE_NAME,
    ensureTvAutoGetSchedule,
    IMDB_REFRESH_QUEUE_NAME,
    ensureImdbRefreshSchedule
} = require('../SchedulerService');
const SeriesAutoGetService = require('../SeriesAutoGetService');
const logger = require('../logger');

const SSH_KEY_PATH = process.env.SCHEDULER_SYNC_SSH_KEY || '/app/.ssh/id_ed25519_scheduler_sync';

// "name=sshTarget" pairs, comma-separated, e.g.
// "sydney=epic@10.100.0.2,tokyo=epic@10.100.0.3" - add one entry per future
// satellite, nothing else here needs to change.
function parseSatelliteTargets() {
    const raw = String(process.env.SATELLITE_SYNC_TARGETS || 'sydney=epic@10.100.0.2').trim();
    return raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const [name, sshTarget] = entry.split('=').map((s) => s.trim());
            return { name, sshTarget };
        })
        .filter((t) => t.name && t.sshTarget);
}

// Deliberately excludes actual video payloads (large, and served instead by
// cloudsync/cloud-fallback playback) by extension - same as the host cron
// script this replaces.
const VIDEO_EXCLUDE_ARGS = ['.mp4', '.MP4', '.mkv', '.MKV', '.mpg', '.MPG', '.mpeg', '.MPEG', '.avi', '.AVI', '.m4v', '.M4V', '.ts', '.TS', '.webm', '.WEBM']
    .flatMap((ext) => ['--exclude', `*${ext}`]);

// [container source path] -> [satellite's own host path]. The destination
// is the satellite's real filesystem, written by the remote rsync server
// process spawned over SSH - not through any container mount on that side.
// Every source path here is already mounted into this container via the
// same x-app-common volumes every other service shares (see
// docker-compose.yml), so no new mounts were needed beyond the SSH key.
const SYNC_LEGS = [
    { label: 'movies', src: '/app/storage/movies', dest: '/home/epic/movies', excludeVideo: true },
    { label: 'series', src: '/app/storage/series', dest: '/data/blockchain/media/Series', excludeVideo: true },
    { label: 'catalog-metadata', src: '/app/catalog-metadata', dest: '/home/epic/movie-streamer/metadata', excludeVideo: false },
    { label: 'user-profiles', src: '/app/metadata', dest: '/home/epic/movie-streamer-data', excludeVideo: false },
    { label: 'archive', src: '/app/archive', dest: '/home/epic/tobedel', excludeVideo: false },
    { label: 'subliminal-config', src: '/root/.config/subliminal', dest: '/home/epic/.config/subliminal', excludeVideo: false }
];

function runRsyncLeg(target, leg) {
    return new Promise((resolve) => {
        const args = [
            '-az', '--no-owner', '--no-group',
            // Without this, a rename/removal on the primary (e.g. the TV
            // show renamer tool) never reaches the satellite - rsync only
            // ever adds/updates, so the old name just accumulates forever
            // alongside the new one. Confirmed live before enabling this:
            // combined with --exclude below (and rsync's default behavior of
            // never deleting excluded files unless --delete-excluded is also
            // given), video files are never candidates for deletion here -
            // only stale non-video leftovers (old folder names, old episode/
            // subtitle filenames) are, which is exactly what this needs to
            // clean up.
            '--delete',
            '-e', `ssh -i ${SSH_KEY_PATH} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new`,
            ...(leg.excludeVideo ? VIDEO_EXCLUDE_ARGS : []),
            `${leg.src}/`,
            `${target.sshTarget}:${leg.dest}/`
        ];

        execFile('rsync', args, { timeout: 120000 }, (err, _stdout, stderr) => {
            if (err) {
                resolve({ target: target.name, leg: leg.label, success: false, error: (stderr || '').trim() || err.message });
            } else {
                resolve({ target: target.name, leg: leg.label, success: true });
            }
        });
    });
}

// Repo root (same scripts/*.js the admin "Refresh IMDb Data" button already
// runs via this exact execFile pattern - see admin.routes.js's
// runNodeScript()) - reused here rather than refactored into a shared
// util, since it's a two-line wrapper and this is its only other caller.
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

function runNodeScript(scriptName, args = []) {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(REPO_ROOT, 'scripts', scriptName);
        execFile(process.execPath, [scriptPath, ...args], {
            cwd: REPO_ROOT,
            maxBuffer: 50 * 1024 * 1024,
            timeout: 30 * 60 * 1000 // the IMDb TSV downloads are large; give it real headroom
        }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error((stderr || '').trim() || err.message));
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

async function processImdbRefreshJob() {
    // --force: without it, update-imdb-data.js skips re-downloading a file
    // that already exists on disk - harmless on a freshly-deployed
    // container (nothing exists yet) but would silently turn every run
    // after the first in this container's lifetime into a no-op, since
    // .data/ persists across job runs even though it doesn't survive a
    // redeploy. A scheduled "refresh" must always actually refresh.
    const updateResult = await runNodeScript('update-imdb-data.js', ['--force']);
    const buildResult = await runNodeScript('build-imdb-catalogs.js', []);
    // build-tmdb-catalogs.js reads metadata/tv-show-index.json - the file
    // build-imdb-catalogs.js just (re)wrote above - so it has to run after,
    // not on its own independent schedule where it could run against a
    // stale or (on a fresh deploy) not-yet-existing index. No CLI args of
    // its own; TMDb credentials come from .env like everything else here.
    const tmdbResult = await runNodeScript('build-tmdb-catalogs.js', []);
    return {
        updateOutputLines: updateResult.stdout.trim() ? updateResult.stdout.trim().split('\n').length : 0,
        buildOutputLines: buildResult.stdout.trim() ? buildResult.stdout.trim().split('\n').length : 0,
        tmdbOutputLines: tmdbResult.stdout.trim() ? tmdbResult.stdout.trim().split('\n').length : 0
    };
}

async function processMetadataMirrorJob() {
    const targets = parseSatelliteTargets();
    const results = [];

    for (const target of targets) {
        // Sequential per target/leg - keeps concurrent rsync/ssh processes
        // bounded, and matches the original cron script's own behavior of
        // logging one leg's failure without aborting the rest.
        for (const leg of SYNC_LEGS) {
            const result = await runRsyncLeg(target, leg);
            results.push(result);
            if (!result.success) {
                logger.warn(`[Scheduler] metadata-mirror leg '${leg.label}' -> ${target.name} failed: ${result.error}`);
            }
        }
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
        throw new Error(`${failed.length}/${results.length} sync leg(s) failed: ${failed.map((f) => `${f.target}/${f.leg}`).join(', ')}`);
    }

    return { syncedLegs: results.length, targets: targets.map((t) => t.name) };
}

async function main() {
    await ensureMetadataMirrorSchedule();
    await ensureTvAutoGetSchedule();
    await ensureImdbRefreshSchedule();

    const metadataMirrorWorker = new Worker(
        METADATA_MIRROR_QUEUE_NAME,
        async (job) => {
            logger.debug(`[Scheduler] Running metadata-mirror job ${job.id}`);
            return processMetadataMirrorJob();
        },
        { connection: getSchedulerRedisConnection(), concurrency: 1 }
    );

    metadataMirrorWorker.on('completed', (job) => {
        logger.debug(`[Scheduler] metadata-mirror job ${job.id} completed.`);
    });
    metadataMirrorWorker.on('failed', (job, err) => {
        logger.error(`[Scheduler] metadata-mirror job ${job?.id} failed: ${err.message}`);
    });

    // Trigger-mechanism migration only for now (setInterval -> BullMQ
    // repeatable job, same cadence) - processDueRules() itself is untouched.
    // The "check known air dates instead of blind polling" redesign is a
    // separate follow-up once we know what EZTV/TMDb actually give us.
    const tvAutoGetWorker = new Worker(
        TV_AUTO_GET_QUEUE_NAME,
        async (job) => {
            logger.debug(`[Scheduler] Running tv-auto-get job ${job.id}`);
            return SeriesAutoGetService.processDueRules();
        },
        { connection: getSchedulerRedisConnection(), concurrency: 1 }
    );

    tvAutoGetWorker.on('completed', (job, result) => {
        if (result?.queuedCount > 0 || result?.scannedRules > 0) {
            logger.info(`[Scheduler] tv-auto-get job ${job.id} completed - scanned=${result.scannedRules} queued=${result.queuedCount}`);
        } else {
            logger.debug(`[Scheduler] tv-auto-get job ${job.id} completed.`);
        }
    });
    tvAutoGetWorker.on('failed', (job, err) => {
        logger.error(`[Scheduler] tv-auto-get job ${job?.id} failed: ${err.message}`);
    });

    // Was manual-trigger-only via the admin Operations panel (IMDb) or not
    // wired into any trigger at all (TMDb - previously only ever run by
    // hand via `npm run build:catalogs:tmdb`); same scripts, same execFile
    // pattern, chained in the one job now since TMDb's catalog build reads
    // the IMDb catalog build's own output file.
    const imdbRefreshWorker = new Worker(
        IMDB_REFRESH_QUEUE_NAME,
        async (job) => {
            logger.info(`[Scheduler] Running imdb-refresh job ${job.id} (downloads can take several minutes)...`);
            return processImdbRefreshJob();
        },
        { connection: getSchedulerRedisConnection(), concurrency: 1 }
    );

    imdbRefreshWorker.on('completed', (job, result) => {
        logger.info(`[Scheduler] imdb-refresh job ${job.id} completed - update=${result.updateOutputLines} lines, build=${result.buildOutputLines} lines, tmdb=${result.tmdbOutputLines} lines.`);
    });
    imdbRefreshWorker.on('failed', (job, err) => {
        logger.error(`[Scheduler] imdb-refresh job ${job?.id} failed: ${err.message}`);
    });

    logger.info('[Scheduler] SchedulerWorker started - metadata-mirror, tv-auto-get, and imdb-refresh queues active.');
}

main().catch((err) => {
    logger.error(`[Scheduler] SchedulerWorker fatal startup error: ${err.message}`);
    process.exit(1);
});
