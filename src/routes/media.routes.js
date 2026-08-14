// src/routes/media.routes.js
// Media catalog discovery, paginated queries, subtitle streams, and B2 presigned asset routers.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const { getLibrary } = require('../services/db');
const { loadHomeFeedWithFallback, normalizeCard } = require('../services/HomeFeedService');
const { rebuildSeriesManifest } = require('../services/SeriesIndexService');
const { loadIndex, searchIndex, getSeriesByImdbId } = require('../services/TvSeriesIndexService');
const MovieTitleIndexService = require('../services/MovieTitleIndexService');
const SeriesSubscriptionService = require('../services/SeriesSubscriptionService');
const metadataProvider = require('../services/MetadataProvider');
const ProfileService = require('../services/ProfileService');
const { requireAuth, getActiveUser } = require('../middleware/auth');
const {
    GROUP_GLOBAL,
    buildMyLibraryCollection,
    canUserSeeMedia,
    getGroupsFromMedia
} = require('../services/LibraryAccessService');
const { versionCoverUrl, tvCoverUrl } = require('../services/CoverUrlService');
const { toCdnUrl } = require('../services/CdnAssetService');
const {
    getSeriesRoots,
    resolveMovieFolderPath,
    resolveSeriesFolderPath,
    resolveRelativePathInSeriesRoots,
    listSeriesFolders
} = require('../services/StoragePathResolver');

const MediaService = require('../services/MediaService');

const TV_COVER_DIR = path.join(__dirname, '../../metadata/tv-covers');
const CATALOG_DATA_DIR = path.join(__dirname, '../../metadata');
const CATALOG_DATA_DIR_CANDIDATES = [
    String(process.env.CATALOG_DATA_DIR || '').trim(),
    '/app/catalog-metadata',
    CATALOG_DATA_DIR
].filter(Boolean);
const CATALOG_COVER_DIR = path.join(__dirname, '../../public/images/catalog-covers');

const CATALOG_LABEL_OVERRIDES = {
    weekly_fresh_100: 'Weekly Fresh 100',
    top_100_all_time: 'Top 100 of All Time',
    critics_choices: 'Critics Choice',
    master_popular_2000: 'Master Popular 2000',
    top_50_action: 'Top 50 Action',
    top_50_comedy: 'Top 50 Comedy',
    top_50_drama: 'Top 50 Drama',
    top_50_horror: 'Top 50 Horror',
    top_50_romance: 'Top 50 Romance',
    top_50_sci_fi: 'Top 50 Sci-Fi',
    top_50_thriller: 'Top 50 Thriller',
    movie_trending_50: 'Trending Movies',
    movie_popular_50: 'Popular Movies',
    movie_new_50: 'New Movies',
    popular_1980s: 'Best of 1980s',
    popular_1990s: 'Best of 1990s',
    popular_2000s: 'Best of 2000s',
    popular_2010s: 'Best of 2010s',
    popular_2020s: 'Best of 2020s',
    popular_1920s: 'Best of 1920s',
    popular_1930s: 'Best of 1930s',
    popular_1940s: 'Best of 1940s',
    popular_1950s: 'Best of 1950s',
    popular_1960s: 'Best of 1960s',
    popular_1970s: 'Best of 1970s'
};

const TV_CATALOG_LABEL_OVERRIDES = {
    trending_50: 'Trending This Week',
    popular_50: 'Popular TV',
    currently_airing_30: 'Currently Airing',
    comedy_50: 'Top TV Comedy',
    drama_50: 'Top TV Drama',
    family_50: 'Top TV Family'
};

function normalizeSearchText(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleCaseWords(value = '') {
    return String(value || '')
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function toCatalogSlug(fileName = '') {
    const base = String(fileName || '')
        .replace(/^catalog_/i, '')
        .replace(/\.json$/i, '')
        .replace(/_trimmed$/i, '');
    return base.toLowerCase();
}

function catalogDisplayName(slug = '') {
    if (CATALOG_LABEL_OVERRIDES[slug]) return CATALOG_LABEL_OVERRIDES[slug];
    return titleCaseWords(slug);
}

function getCatalogSortWeight(slug = '') {
    if (slug === 'movie_trending_50') return 2;
    if (slug === 'movie_popular_50') return 3;
    if (slug === 'movie_new_50') return 4;
    if (slug === 'weekly_fresh_100') return 5;
    if (slug === 'top_100_all_time') return 10;
    if (slug === 'critics_choices') return 20;
    if (slug === 'master_popular_2000') return 30;

    const top50Genre = String(slug).match(/^top_50_(.+)$/);
    if (top50Genre) {
        const genreOrder = ['action', 'comedy', 'drama', 'horror', 'romance', 'sci_fi', 'thriller'];
        const idx = genreOrder.indexOf(top50Genre[1]);
        return idx >= 0 ? 40 + idx : 49;
    }

    const decade = String(slug).match(/popular_(\d{4})s$/);
    if (decade) return 100 + parseInt(decade[1], 10);
    return 1000;
}

function getCatalogIcon(slug = '') {
    if (slug === 'movie_trending_50') return '🔥';
    if (slug === 'movie_popular_50') return '📈';
    if (slug === 'movie_new_50') return '🆕';
    if (slug === 'weekly_fresh_100') return '🆕';
    if (slug.includes('critics')) return '⭐';
    if (slug.includes('top_100')) return '🏆';
    if (slug.startsWith('top_50_')) return '🎭';
    if (slug.includes('popular_')) return '🎬';
    return '📚';
}

function toTvCatalogSlug(fileName = '') {
    const base = String(fileName || '')
        .replace(/^catalog_tv_/i, '')
        .replace(/\.json$/i, '');
    return base.toLowerCase();
}

function tvCatalogDisplayName(slug = '') {
    if (TV_CATALOG_LABEL_OVERRIDES[slug]) return TV_CATALOG_LABEL_OVERRIDES[slug];
    return titleCaseWords(String(slug || '').replace(/^tv_/, ''));
}

function getTvCatalogSortWeight(slug = '') {
    if (slug === 'trending_50') return 5;
    if (slug === 'popular_50') return 10;
    if (slug === 'currently_airing_30') return 15;
    if (slug === 'comedy_50') return 20;
    if (slug === 'drama_50') return 25;
    if (slug === 'family_50') return 30;
    return 1000;
}

function getTvCatalogIcon(slug = '') {
    if (slug.includes('trending')) return '🔥';
    if (slug.includes('popular')) return '📈';
    if (slug.includes('airing')) return '📺';
    if (slug.includes('comedy')) return '😂';
    if (slug.includes('drama')) return '🎭';
    if (slug.includes('family')) return '👨‍👩‍👧';
    return '📚';
}

function listCatalogFilesByDirectory() {
    return CATALOG_DATA_DIR_CANDIDATES.map((dirPath) => {
        if (!fs.existsSync(dirPath)) return { dirPath, files: [] };

        const files = fs.readdirSync(dirPath)
            .filter(name => /^catalog_.*\.json$/i.test(name));
        return { dirPath, files };
    });
}

function listTvCatalogFilesByDirectory() {
    return CATALOG_DATA_DIR_CANDIDATES.map((dirPath) => {
        if (!fs.existsSync(dirPath)) return { dirPath, files: [] };

        const files = fs.readdirSync(dirPath)
            .filter(name => /^catalog_tv_.*\.json$/i.test(name));
        return { dirPath, files };
    });
}

function pickCatalogDirectoryForSlug(slug = '') {
    const safe = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '');
    if (!safe) return null;

    for (const dirPath of CATALOG_DATA_DIR_CANDIDATES) {
        const preferredTrimmed = path.join(dirPath, `catalog_${safe}_trimmed.json`);
        if (fs.existsSync(preferredTrimmed)) return { dirPath, filePath: preferredTrimmed };

        const fallbackLegacy = path.join(dirPath, `catalog_${safe}.json`);
        if (fs.existsSync(fallbackLegacy)) return { dirPath, filePath: fallbackLegacy };
    }

    return null;
}

function readCatalogJsonBySlug(slug = '') {
    const safe = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '');
    if (!safe) return null;

    const selected = pickCatalogDirectoryForSlug(safe);
    const filePath = selected?.filePath;
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;

    try {
        const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return Array.isArray(payload) ? payload : [];
    } catch (_err) {
        return [];
    }
}

function readTvCatalogJsonBySlug(slug = '') {
    const safe = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '');
    if (!safe) return null;

    for (const dirPath of CATALOG_DATA_DIR_CANDIDATES) {
        const filePath = path.join(dirPath, `catalog_tv_${safe}.json`);
        if (!fs.existsSync(filePath)) continue;
        try {
            const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return Array.isArray(payload) ? payload : [];
        } catch (_err) {
            return [];
        }
    }

    return null;
}

function getCatalogCoverUrl(imdbId = '') {
    const normalized = normalizeMovieImdbId(imdbId);
    if (!normalized) return '';
    const coverPath = path.join(CATALOG_COVER_DIR, `${normalized}.jpg`);
    if (fs.existsSync(coverPath)) {
        return versionCoverUrl(`/images/catalog-covers/${normalized}.jpg`);
    }
    return '';
}

function buildLibraryMovieIndexes(localRows = []) {
    const byImdb = new Map();
    const byTitleYear = new Map();

    for (const item of localRows) {
        const imdb = normalizeMovieImdbId(item.imdbId);
        if (imdb && !byImdb.has(imdb)) {
            byImdb.set(imdb, item);
        }

        const titleKey = normalizeSearchText(item.title || '');
        const yearKey = String(item.year || '').trim();
        if (titleKey && yearKey) {
            const fullKey = `${titleKey}|${yearKey}`;
            if (!byTitleYear.has(fullKey)) byTitleYear.set(fullKey, item);
        }
    }

    return { byImdb, byTitleYear };
}

function buildLibrarySeriesIndexes(localRows = []) {
    const byImdb = new Map();
    const byTitle = new Map();

    for (const item of localRows) {
        const imdb = formatImdbId(item.imdbId || item.imdb_id || '');
        if (imdb && !byImdb.has(imdb)) {
            byImdb.set(imdb, item);
        }

        const titleKey = normalizeSearchText(item.title || '');
        if (titleKey && !byTitle.has(titleKey)) {
            byTitle.set(titleKey, item);
        }
    }

    return { byImdb, byTitle };
}

function firstNonEmptyString(values = []) {
    for (const value of values) {
        const clean = String(value || '').trim();
        if (clean) return clean;
    }
    return '';
}

function pickMovieImdbId(item = {}) {
    return firstNonEmptyString([
        item.imdbId,
        item.imdbID,
        item.imdb_code,
        item.metadata?.imdbId,
        item.enrichment?.imdbId
    ]);
}

function normalizeMovieImdbId(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw.startsWith('tt')) return raw;
    return `tt${raw}`;
}

function scoreLocalMovieMatch(item, queryNorm) {
    const titleNorm = normalizeSearchText(item.title || '');
    const folderNorm = normalizeSearchText(item.id || item.folder || '');
    const yearText = String(item.year || '').trim();
    const imdbNorm = normalizeSearchText(item.imdbId || '');

    let score = 0;
    if (titleNorm === queryNorm) score += 250;
    if (titleNorm.startsWith(queryNorm)) score += 160;
    if (titleNorm.includes(queryNorm)) score += 120;
    if (folderNorm.includes(queryNorm)) score += 70;
    if (imdbNorm && imdbNorm.includes(queryNorm)) score += 100;
    if (yearText && queryNorm.includes(String(yearText))) score += 25;
    return score;
}

function buildLocalMovieCatalogRows(library) {
    const movies = Array.isArray(library?.movies) ? library.movies : [];
    return movies
        .filter(item => {
            const id = String(item.id || '').toLowerCase();
            const type = String(item.contentType || '').toLowerCase();
            if (type === 'series') return false;
            if (id.startsWith('series/')) return false;
            return true;
        })
        .map(item => {
            const imdbId = normalizeMovieImdbId(pickMovieImdbId(item));
            return {
                id: item.id,
                title: item.title || item.id || 'Unknown',
                year: item.year || '',
                imdbId,
                cover: versionCoverUrl(item.cover || ''),
                href: `/player.html?id=${encodeURIComponent(item.id || '')}`,
                contentType: 'movie',
                source: 'local-library'
            };
        });
}

function mapCatalogMovieToResult(item = {}, localMap = new Map()) {
    const imdbId = MovieTitleIndexService.normalizeImdbId(item.imdbId || '');
    const localRow = localMap.get(imdbId) || null;
    return {
        imdbId,
        title: item.title || item.name || '',
        year: item.year || '',
        rating: item.rating || item.averageRating || 0,
        votes: item.votes || item.numVotes || 0,
        genres: Array.isArray(item.genres) ? item.genres : String(item.genres || '').split(',').map(v => v.trim()).filter(Boolean),
        searchText: item.searchText || '',
        source: item.source || 'imdb-catalog',
        inLibrary: Boolean(localRow),
        localItem: localRow ? {
            id: localRow.id,
            title: localRow.title,
            year: localRow.year,
            imdbId: localRow.imdbId,
            cover: versionCoverUrl(localRow.cover),
            href: localRow.href,
            contentType: localRow.contentType
        } : null
    };
}

function indexLocalMovieKeys(localRows = []) {
    const imdbSet = new Set();
    const titleYearSet = new Set();

    localRows.forEach((item) => {
        const imdb = normalizeMovieImdbId(item.imdbId);
        if (imdb) imdbSet.add(imdb);

        const titleKey = normalizeSearchText(item.title || '');
        const yearKey = String(item.year || '').trim();
        if (titleKey && yearKey) {
            titleYearSet.add(`${titleKey}|${yearKey}`);
        }
    });

    return { imdbSet, titleYearSet };
}

function formatImdbId(imdbId) {
    const raw = String(imdbId || '').trim();
    if (!raw) return '';
    return raw.startsWith('tt') ? raw : `tt${raw}`;
}

function withCover(item) {
    const formattedId = formatImdbId(item.imdbId || '');
    return {
        ...item,
        imdbId: formattedId,
        cover: tvCoverUrl(formattedId)
    };
}

function resolveSeriesEpisodeVideoPath(showFolder, seasonNumber, episodeNumber) {
    const showPath = resolveSeriesFolderPath(showFolder, { mustExist: true });
    if (!fs.existsSync(showPath)) return null;

    let seriesData;
    try {
        seriesData = rebuildSeriesManifest(showPath, {
            showFolderName: showFolder,
            write: false
        });
    } catch (_err) {
        return null;
    }

    const seasons = seriesData.seasons || {};
    const seasonEntry = seasons[String(seasonNumber)] || null;
    const episodes = Array.isArray(seasonEntry?.episodes) ? seasonEntry.episodes : [];
    const target = episodes.find(ep => Number(ep.episodeNumber) === Number(episodeNumber) && ep.localRelativePath);
    if (!target?.localRelativePath) return null;

    const absolutePath = resolveRelativePathInSeriesRoots(target.localRelativePath);
    return fs.existsSync(absolutePath) ? absolutePath : null;
}

function findSourceVideoInFolder(folderPath) {
    const candidates = fs.readdirSync(folderPath).filter(file => /\.(mkv|mp4|m4v|avi|mov|wmv)$/i.test(file));
    if (!candidates.length) return null;

    const preferred = candidates.find(file => /\.web\.mp4$/i.test(file));
    return preferred || candidates[0];
}

function sanitizeVideoFileName(fileName) {
    const normalized = path.basename(String(fileName || '').trim());
    if (!normalized) return '';
    if (normalized.includes('..')) return '';
    if (!/\.(mkv|mp4|m4v|avi|mov|wmv)$/i.test(normalized)) return '';
    return normalized;
}

function detectVideoMime(videoPath) {
    const ext = path.extname(String(videoPath || '')).toLowerCase();
    if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
    if (ext === '.mkv') return 'video/x-matroska';
    if (ext === '.avi') return 'video/x-msvideo';
    if (ext === '.mov') return 'video/quicktime';
    return 'application/octet-stream';
}

function streamLocalVideoFile(req, res, videoPath) {
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const contentType = detectVideoMime(videoPath);

    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType
    };

    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers);
        res.end();
        return;
    }

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;

        res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunkSize
        });
        fs.createReadStream(videoPath, { start, end }).pipe(res);
        return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': fileSize });
    fs.createReadStream(videoPath).pipe(res);
}

// Video codecs MP4 can legally carry. Anything else gets muxed into Matroska so we
// never have to re-encode video just to switch an audio track.
const MP4_MUXABLE_VIDEO_CODECS = new Set(['h264', 'hevc', 'av1', 'vp9', 'mpeg4', 'mpeg2video', 'mjpeg', 'h263']);
// Audio we can stream to a browser untouched. Everything else is downmixed to stereo AAC.
const COPYABLE_AUDIO_CODECS = new Set(['aac', 'mp3']);

const AUDIO_CACHE_MAX_BYTES = Math.max(1, Number(process.env.AUDIO_PLAYBACK_CACHE_MAX_GB) || 150) * 1024 * 1024 * 1024;
const AUDIO_CACHE_MAX_CONCURRENT = Math.max(1, Number(process.env.AUDIO_PLAYBACK_CACHE_CONCURRENCY) || 2);
// Never evict something a client could still be mid-stream on.
const AUDIO_CACHE_EVICT_GRACE_MS = 30 * 60 * 1000;

// cachePath -> in-flight Promise. Browsers fire many range requests at a fresh <video> src;
// without this every one of them would spawn its own ffmpeg against the same output.
const audioCacheInFlight = new Map();
let audioCacheActiveJobs = 0;
const audioCacheQueue = [];

function getAudioTrackCacheDir() {
    const configured = String(process.env.AUDIO_PLAYBACK_CACHE_DIR || '').trim();
    if (configured) return configured;
    return path.join('/tmp', 'joshflix-audio-cache');
}

function probeVideoStream(videoPath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'json',
        videoPath
    ], { encoding: 'utf8' });

    if (probe.status !== 0) return null;
    try {
        const parsed = JSON.parse(probe.stdout || '{}');
        return Array.isArray(parsed.streams) ? (parsed.streams[0] || null) : null;
    } catch (_err) {
        return null;
    }
}

// Decides container + codec strategy up front so the cache key matches what we actually write.
function planAudioSelectedPlayback(videoPath, streamIndex) {
    const videoStream = probeVideoStream(videoPath);
    const videoCodec = String(videoStream?.codec_name || '').toLowerCase();
    const container = MP4_MUXABLE_VIDEO_CODECS.has(videoCodec) ? 'mp4' : 'mkv';

    const audioStream = probeAudioStreams(videoPath).find(s => Number(s.index) === Number(streamIndex));
    const audioCodec = String(audioStream?.codec_name || '').toLowerCase();
    const channels = Number(audioStream?.channels) || 0;
    const canCopyAudio = COPYABLE_AUDIO_CODECS.has(audioCodec) && channels > 0 && channels <= 2;

    const stat = fs.statSync(videoPath);
    const cacheKey = crypto.createHash('sha1')
        .update(`${videoPath}|${streamIndex}|${stat.size}|${Math.floor(stat.mtimeMs)}|${container}|${canCopyAudio ? 'copy' : 'aac2'}`)
        .digest('hex');

    return {
        container,
        canCopyAudio,
        cachePath: path.join(getAudioTrackCacheDir(), `${cacheKey}.${container}`)
    };
}

function buildAudioSelectedFfmpegArgs(videoPath, streamIndex, plan, tempPath) {
    const args = [
        '-y',
        '-v', 'error',
        '-i', videoPath,
        '-map', '0:v:0',
        '-map', `0:${streamIndex}`,
        '-sn', '-dn',
        '-map_chapters', '-1',
        '-c:v', 'copy',
        '-max_muxing_queue_size', '1024'
    ];

    if (plan.canCopyAudio) {
        args.push('-c:a', 'copy');
    } else {
        args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    }

    if (plan.container === 'mp4') {
        args.push('-movflags', '+faststart');
    } else {
        args.push('-f', 'matroska');
    }

    args.push(tempPath);
    return args;
}

function runFfmpegAsync(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', args);
        // ffmpeg is chatty on long files; keep only the tail so we never buffer unboundedly.
        let stderrTail = '';
        child.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8000);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderrTail.trim() || `ffmpeg exited with code ${code}`));
        });
    });
}

// Simple FIFO gate so a burst of track switches can't spawn one ffmpeg per request.
function acquireAudioCacheSlot() {
    if (audioCacheActiveJobs < AUDIO_CACHE_MAX_CONCURRENT) {
        audioCacheActiveJobs += 1;
        return Promise.resolve();
    }
    return new Promise(resolve => audioCacheQueue.push(resolve));
}

function releaseAudioCacheSlot() {
    const next = audioCacheQueue.shift();
    if (next) next();
    else audioCacheActiveJobs = Math.max(0, audioCacheActiveJobs - 1);
}

// LRU trim. Cache entries are full-size video copies, so an unbounded dir eats the disk.
function pruneAudioTrackCache(protectedPath) {
    try {
        const cacheDir = getAudioTrackCacheDir();
        const entries = fs.readdirSync(cacheDir)
            .filter(name => /\.(mp4|mkv)$/i.test(name))
            .map((name) => {
                const filePath = path.join(cacheDir, name);
                try {
                    const stat = fs.statSync(filePath);
                    return { filePath, size: stat.size, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs };
                } catch (_err) {
                    return null;
                }
            })
            .filter(Boolean);

        let total = entries.reduce((sum, entry) => sum + entry.size, 0);
        if (total <= AUDIO_CACHE_MAX_BYTES) return;

        const now = Date.now();
        const evictable = entries
            .filter(entry => entry.filePath !== protectedPath)
            .filter(entry => (now - Math.max(entry.atimeMs, entry.mtimeMs)) > AUDIO_CACHE_EVICT_GRACE_MS)
            .sort((a, b) => Math.max(a.atimeMs, a.mtimeMs) - Math.max(b.atimeMs, b.mtimeMs));

        for (const entry of evictable) {
            if (total <= AUDIO_CACHE_MAX_BYTES) break;
            try {
                fs.unlinkSync(entry.filePath);
                total -= entry.size;
                console.log(`🧹 Evicted audio-track cache entry ${path.basename(entry.filePath)} (${(entry.size / 1e9).toFixed(2)} GB)`);
            } catch (_err) {
                /* another worker may have already reclaimed it */
            }
        }
    } catch (_err) {
        /* pruning is best-effort and must never fail a playback request */
    }
}

async function ensureAudioSelectedPlaybackFile(videoPath, streamIndex) {
    const cacheDir = getAudioTrackCacheDir();
    await fsPromises.mkdir(cacheDir, { recursive: true });

    const plan = planAudioSelectedPlayback(videoPath, streamIndex);
    const { cachePath } = plan;

    if (fs.existsSync(cachePath)) {
        // Touch for LRU ordering; a hit shouldn't look stale to the pruner.
        try { fs.utimesSync(cachePath, new Date(), fs.statSync(cachePath).mtime); } catch (_err) { /* non-fatal */ }
        return cachePath;
    }

    const pending = audioCacheInFlight.get(cachePath);
    if (pending) return pending;

    const job = (async () => {
        await acquireAudioCacheSlot();
        // Extension must be the real container: ffmpeg picks its muxer from the suffix.
        const tempPath = path.join(cacheDir, `.building-${process.pid}-${crypto.randomBytes(6).toString('hex')}.${plan.container}`);
        try {
            if (fs.existsSync(cachePath)) return cachePath;

            const started = Date.now();
            await runFfmpegAsync(buildAudioSelectedFfmpegArgs(videoPath, streamIndex, plan, tempPath));
            if (!fs.existsSync(tempPath)) {
                throw new Error('ffmpeg reported success but produced no output file.');
            }

            await fsPromises.rename(tempPath, cachePath);
            console.log(`🎧 Built audio-track cache (stream ${streamIndex}, ${plan.container}, audio ${plan.canCopyAudio ? 'copy' : 'aac'}) in ${((Date.now() - started) / 1000).toFixed(1)}s for ${path.basename(videoPath)}`);
            pruneAudioTrackCache(cachePath);
            return cachePath;
        } finally {
            try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_err) { /* non-fatal */ }
            releaseAudioCacheSlot();
        }
    })();

    audioCacheInFlight.set(cachePath, job);
    try {
        return await job;
    } finally {
        audioCacheInFlight.delete(cachePath);
    }
}

function findSidecarSubtitleForVideo(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.parse(videoPath).name;
    const preferred = [
        `${base}.English.srt`,
        `${base}.en.srt`,
        `${base}.srt`,
        `${base}.English.vtt`,
        `${base}.en.vtt`,
        `${base}.vtt`,
        'English.srt',
        'English.vtt'
    ];

    for (const name of preferred) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
    }

    const anySubtitle = fs.readdirSync(dir).find(file => /\.(srt|vtt)$/i.test(file));
    return anySubtitle ? path.join(dir, anySubtitle) : null;
}

function extractEmbeddedSubtitle(videoPath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type:stream_tags=language,title',
        '-of', 'json',
        videoPath
    ], { encoding: 'utf8' });

    if (probe.status !== 0) return null;

    let parsed;
    try {
        parsed = JSON.parse(probe.stdout || '{}');
    } catch (_err) {
        return null;
    }

    const subtitleStreams = Array.isArray(parsed.streams)
        ? parsed.streams.filter(s => s.codec_type === 'subtitle')
        : [];
    if (!subtitleStreams.length) return null;

    const english = subtitleStreams.find(s => {
        const lang = String(s.tags?.language || '').toLowerCase();
        return lang === 'en' || lang === 'eng';
    });
    const selected = english || subtitleStreams[0];
    const streamIndex = selected?.index;
    if (!Number.isFinite(streamIndex)) return null;

    const dir = path.dirname(videoPath);
    const base = path.parse(videoPath).name;
    const srtPath = path.join(dir, `${base}.English.srt`);

    const extractSrt = spawnSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'srt',
        srtPath
    ], { encoding: 'utf8' });

    if (extractSrt.status === 0 && fs.existsSync(srtPath)) {
        return srtPath;
    }

    const vttPath = path.join(dir, `${base}.English.vtt`);
    const extractVtt = spawnSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'webvtt',
        vttPath
    ], { encoding: 'utf8' });

    if (extractVtt.status === 0 && fs.existsSync(vttPath)) {
        return vttPath;
    }

    return null;
}

function subtitleToWebVtt(rawContent, extname) {
    if (String(extname || '').toLowerCase() === '.vtt') {
        return rawContent.startsWith('WEBVTT') ? rawContent : `WEBVTT\n\n${rawContent}`;
    }

    return "WEBVTT\n\n" + rawContent
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

function preferredSubtitleLanguages() {
    const raw = String(process.env.SUBTITLE_PREFERRED_LANGS || 'en,eng,english').trim();
    return raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
}

function normalizeSubtitleToken(value = '') {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseEmbeddedSubtitleFileMeta(fileName) {
    const parsed = String(fileName || '').match(/\.sub\.(\d+)\.([a-z]{2,3})\.(srt|vtt)$/i);
    if (!parsed) return null;
    return {
        streamIndex: parseInt(parsed[1], 10),
        lang: String(parsed[2] || '').toLowerCase(),
        ext: String(parsed[3] || '').toLowerCase()
    };
}

function probeSubtitleStreams(videoPath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired',
        '-of', 'json',
        videoPath
    ], { encoding: 'utf8' });

    if (probe.status !== 0) return [];

    let parsed;
    try {
        parsed = JSON.parse(probe.stdout || '{}');
    } catch (_err) {
        return [];
    }

    return Array.isArray(parsed.streams)
        ? parsed.streams.filter(s => s.codec_type === 'subtitle')
        : [];
}

function probeAudioStreams(videoPath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type,codec_name,channels,channel_layout:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired',
        '-of', 'json',
        videoPath
    ], { encoding: 'utf8' });

    if (probe.status !== 0) return [];

    let parsed;
    try {
        parsed = JSON.parse(probe.stdout || '{}');
    } catch (_err) {
        return [];
    }

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    return streams.filter(s => s.codec_type === 'audio');
}

function listAudioTracksForVideo(videoPath) {
    const streams = probeAudioStreams(videoPath);
    return streams.map((stream, idx) => {
        const lang = String(stream?.tags?.language || 'und').toLowerCase();
        const title = String(stream?.tags?.title || '').trim();
        const codec = String(stream?.codec_name || 'audio').toUpperCase();
        const channels = Number(stream?.channels) || 0;
        const channelLayout = String(stream?.channel_layout || '').trim();
        const channelLabel = channelLayout || (channels > 0 ? `${channels}ch` : '');
        const defaultFlag = Number(stream?.disposition?.default) === 1;
        const forcedFlag = Number(stream?.disposition?.forced) === 1;

        const labelParts = [
            lang.toUpperCase(),
            title || null,
            codec,
            channelLabel || null,
            defaultFlag ? 'default' : null,
            forcedFlag ? 'forced' : null
        ].filter(Boolean);

        return {
            id: idx,
            streamIndex: Number(stream?.index),
            lang,
            title,
            codec,
            channels,
            channelLayout,
            isDefault: defaultFlag,
            isForced: forcedFlag,
            label: labelParts.join(' • ')
        };
    });
}

function extractEmbeddedSubtitleStream(videoPath, stream, baseName) {
    const streamIndex = stream?.index;
    if (!Number.isFinite(streamIndex)) return null;

    const dir = path.dirname(videoPath);
    const lang = String(stream?.tags?.language || 'und').toLowerCase().slice(0, 3);
    const outSrt = path.join(dir, `${baseName}.sub.${streamIndex}.${lang}.srt`);
    const outVtt = path.join(dir, `${baseName}.sub.${streamIndex}.${lang}.vtt`);

    if (fs.existsSync(outSrt)) return outSrt;
    if (fs.existsSync(outVtt)) return outVtt;

    const srtExtract = spawnSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'srt',
        outSrt
    ], { encoding: 'utf8' });

    if (srtExtract.status === 0 && fs.existsSync(outSrt)) return outSrt;

    const vttExtract = spawnSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'webvtt',
        outVtt
    ], { encoding: 'utf8' });

    if (vttExtract.status === 0 && fs.existsSync(outVtt)) return outVtt;
    return null;
}

function extractEmbeddedSubtitleSet(videoPath, maxTracks = 8) {
    const streams = probeSubtitleStreams(videoPath).slice(0, maxTracks);
    const baseName = path.parse(videoPath).name;
    const extracted = [];

    for (const stream of streams) {
        const outPath = extractEmbeddedSubtitleStream(videoPath, stream, baseName);
        if (outPath) extracted.push(outPath);
    }

    return extracted;
}

function listSubtitleCandidatesForVideo(videoPath, options = {}) {
    const dir = path.dirname(videoPath);
    const base = path.parse(videoPath).name;
    const includeEmbedded = options.includeEmbedded !== false;

    if (includeEmbedded) {
        extractEmbeddedSubtitleSet(videoPath, parseInt(process.env.SUBTITLE_MAX_TRACKS || '8', 10) || 8);
    }

    const files = fs.readdirSync(dir)
        .filter(file => /\.(srt|vtt)$/i.test(file))
        .sort((a, b) => a.localeCompare(b));
    const candidates = [];

    for (const file of files) {
        const filePath = path.join(dir, file);
        const fileToken = normalizeSubtitleToken(file);
        const looksRelatedToVideo = file.startsWith(`${base}.`) || file === 'English.srt' || file === 'English.vtt' || fileToken.includes(normalizeSubtitleToken(base));
        if (!looksRelatedToVideo) continue;

        const embeddedMeta = parseEmbeddedSubtitleFileMeta(file);
        const langHint = embeddedMeta?.lang || (() => {
            if (/\beng(lish)?\b/i.test(file)) return 'eng';
            if (/\bhin(di)?\b/i.test(file)) return 'hin';
            if (/\bspa(nish)?\b/i.test(file)) return 'spa';
            return 'und';
        })();

        candidates.push({
            file,
            filePath,
            relativePath: file,
            ext: path.extname(file).toLowerCase(),
            langHint,
            streamIndex: embeddedMeta?.streamIndex ?? null,
            token: fileToken
        });
    }

    const seen = new Set();
    return candidates.filter(item => {
        if (seen.has(item.filePath)) return false;
        seen.add(item.filePath);
        return true;
    });
}

function listSubtitleCandidatesForDirectory(dirPath, options = {}) {
    if (!dirPath || !fs.existsSync(dirPath)) return [];

    const baseHintRaw = String(options.baseHint || '').trim();
    const baseHint = baseHintRaw ? path.parse(baseHintRaw).name : '';
    const normalizedBaseHint = normalizeSubtitleToken(baseHint);
    const files = fs.readdirSync(dirPath)
        .filter(file => /\.(srt|vtt)$/i.test(file))
        .sort((a, b) => a.localeCompare(b));

    const candidates = [];
    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileToken = normalizeSubtitleToken(file);

        if (normalizedBaseHint) {
            const looksRelatedToHint = file.startsWith(`${baseHint}.`)
                || file === 'English.srt'
                || file === 'English.vtt'
                || fileToken.includes(normalizedBaseHint);
            if (!looksRelatedToHint) continue;
        }

        const langHint = (() => {
            if (/\beng(lish)?\b/i.test(file)) return 'eng';
            if (/\bhin(di)?\b/i.test(file)) return 'hin';
            if (/\bspa(nish)?\b/i.test(file)) return 'spa';
            return 'und';
        })();

        candidates.push({
            file,
            filePath,
            relativePath: file,
            ext: path.extname(file).toLowerCase(),
            langHint,
            streamIndex: null,
            token: fileToken
        });
    }

    return candidates;
}

function scoreSubtitleCandidate(candidate) {
    const langs = preferredSubtitleLanguages();
    let score = 0;
    if (langs.includes(String(candidate.langHint || '').toLowerCase())) score += 80;
    if (/\beng(lish)?\b/.test(candidate.token)) score += 50;
    if (/\b(default)\b/.test(candidate.token)) score += 20;
    if (/\b(forced|signs|songs|commentary|sdh|hi)\b/.test(candidate.token)) score -= 35;
    if (candidate.streamIndex !== null) score += 60;
    if (candidate.streamIndex === null && /(^|\.)english\.(srt|vtt)$/i.test(String(candidate.file || ''))) score -= 15;
    return score;
}

function pickSubtitleCandidate(candidates, query = {}) {
    if (!candidates.length) return null;

    const preferredRelativePath = String(query.preferredRelativePath || query.preferred || '').trim();
    if (preferredRelativePath) {
        const preferred = candidates.find(item => String(item.relativePath || item.file || '').trim() === preferredRelativePath);
        if (preferred) return preferred;
    }

    const requestedTrack = parseInt(query.track, 10);
    if (Number.isFinite(requestedTrack)) {
        const byStreamIndex = candidates.find(item => item.streamIndex === requestedTrack);
        if (byStreamIndex) return byStreamIndex;
        const byArrayIndex = candidates[requestedTrack];
        if (byArrayIndex) return byArrayIndex;
    }

    const requestedLang = String(query.lang || '').trim().toLowerCase();
    if (requestedLang) {
        const byLang = candidates.find(item => String(item.langHint || '').toLowerCase() === requestedLang || item.token.includes(requestedLang));
        if (byLang) return byLang;
    }

    return [...candidates].sort((a, b) => scoreSubtitleCandidate(b) - scoreSubtitleCandidate(a))[0];
}

function decodePossiblyEncodedValue(value) {
    let output = String(value || '').trim();
    if (!output) return '';

    for (let i = 0; i < 3; i += 1) {
        try {
            const decoded = decodeURIComponent(output);
            if (decoded === output) break;
            output = decoded;
        } catch (_err) {
            break;
        }
    }

    return output.replace(/%2f/ig, '/').trim();
}

function normalizeMediaIdInput(mediaId) {
    return decodePossiblyEncodedValue(mediaId).replace(/^\/+/, '');
}

function normalizeShowFolderInput(showFolder) {
    const normalized = normalizeMediaIdInput(showFolder);
    return normalized.replace(/^series\//i, '');
}

function normalizeSeriesLookupKey(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function deriveSeriesTitleFromFolder(folderName = '') {
    return String(folderName || '')
        .replace(/\.[a-z0-9]{2,4}$/i, '')
        .replace(/\bMeGusta\b/gi, '')
        .replace(/\bingest\b/gi, '')
        .replace(/\bSeason[\s._-]?\d{1,3}\b/gi, '')
        .replace(/\bS\d{1,2}E\d{1,3}\b/gi, '')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function resolveSeriesShowFolder(showFolder) {
    const cleanFolder = normalizeShowFolderInput(showFolder);
    if (!cleanFolder) return null;

    const directPath = resolveSeriesFolderPath(cleanFolder, { mustExist: true });
    if (fs.existsSync(directPath) && fs.lstatSync(directPath).isDirectory()) {
        return { folder: cleanFolder, path: directPath };
    }

    const library = await getLibrary();
    const shows = Array.isArray(library.shows) ? library.shows : [];
    const lookupKey = normalizeSeriesLookupKey(cleanFolder);
    const titleHint = normalizeSeriesLookupKey(deriveSeriesTitleFromFolder(cleanFolder));

    const directMatch = shows.find(item => {
        const itemId = String(item?.id || '');
        if (itemId === `series/${cleanFolder}`) return true;

        const itemFolder = normalizeShowFolderInput(String(item?.sourcePath ? path.basename(item.sourcePath) : ''));
        return itemFolder === cleanFolder;
    });

    if (directMatch) {
        const canonicalFolder = normalizeShowFolderInput(String(directMatch.sourcePath ? path.basename(directMatch.sourcePath) : ''))
            || normalizeShowFolderInput(String(directMatch.id || '').replace(/^series\//i, ''))
            || cleanFolder;
        const canonicalPath = resolveSeriesFolderPath(canonicalFolder, { mustExist: true });
        if (fs.existsSync(canonicalPath) && fs.lstatSync(canonicalPath).isDirectory()) {
            return { folder: canonicalFolder, path: canonicalPath };
        }
    }

    const titleMatches = shows.filter(item => {
        const itemTitle = normalizeSeriesLookupKey(item?.title || '');
        const itemImdb = normalizeSeriesLookupKey(item?.imdbId || item?.imdb_id || '');
        const itemFolder = normalizeSeriesLookupKey(normalizeShowFolderInput(String(item?.sourcePath ? path.basename(item.sourcePath) : item?.id || '')));
        return Boolean(
            (lookupKey && (itemFolder === lookupKey || itemFolder.includes(lookupKey) || lookupKey.includes(itemFolder))) ||
            (titleHint && (itemTitle === titleHint || itemTitle.includes(titleHint) || titleHint.includes(itemTitle))) ||
            (itemImdb && itemImdb === lookupKey)
        );
    });

    if (titleMatches.length === 1) {
        const item = titleMatches[0];
        const canonicalFolder = normalizeShowFolderInput(String(item?.sourcePath ? path.basename(item.sourcePath) : item?.id || ''))
            || normalizeShowFolderInput(String(item?.id || '').replace(/^series\//i, ''))
            || cleanFolder;
        const canonicalPath = resolveSeriesFolderPath(canonicalFolder, { mustExist: true });
        if (fs.existsSync(canonicalPath) && fs.lstatSync(canonicalPath).isDirectory()) {
            return { folder: canonicalFolder, path: canonicalPath };
        }
    }

    return null;
}

function findMetadataPathForVideo(videoPath) {
    let currentDir = path.dirname(videoPath);
    const roots = getSeriesRoots().map(rootPath => path.resolve(rootPath));

    while (currentDir && roots.some(root => currentDir.startsWith(root))) {
        const candidate = path.join(currentDir, 'metadata.json');
        if (fs.existsSync(candidate)) return candidate;

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
    }

    const localCandidate = path.join(path.dirname(videoPath), 'metadata.json');
    if (fs.existsSync(localCandidate)) return localCandidate;
    return null;
}

function readMediaMetadataForVideo(videoPath) {
    if (!videoPath) return { metadata: {}, metaPath: null };
    const metaPath = findMetadataPathForVideo(videoPath);
    if (!metaPath) return { metadata: {}, metaPath: null };

    try {
        return {
            metadata: JSON.parse(fs.readFileSync(metaPath, 'utf-8')),
            metaPath
        };
    } catch (_err) {
        return { metadata: {}, metaPath };
    }
}

function readMediaMetadataForMovieFolder(folderPath) {
    if (!folderPath || !fs.existsSync(folderPath)) return { metadata: {}, metaPath: null };
    const metaPath = path.join(folderPath, 'metadata.json');
    if (!fs.existsSync(metaPath)) return { metadata: {}, metaPath: null };

    try {
        return {
            metadata: JSON.parse(fs.readFileSync(metaPath, 'utf-8')),
            metaPath
        };
    } catch (_err) {
        return { metadata: {}, metaPath };
    }
}

function resolveSubtitleContextForRequest(mediaId, season, episode, requestedFile) {
    const videoPath = resolveVideoPathForMediaRequest(mediaId, season, episode, requestedFile);
    if (videoPath && fs.existsSync(videoPath)) {
        const { metadata } = readMediaMetadataForVideo(videoPath);
        return {
            mode: 'video',
            videoPath,
            folderPath: path.dirname(videoPath),
            metadata,
            baseHint: path.basename(videoPath)
        };
    }

    const normalizedMediaId = normalizeMediaIdInput(mediaId);
    if (normalizedMediaId.startsWith('series/')) {
        return null;
    }

    const movieFolder = resolveMovieFolderPath(normalizedMediaId);
    if (!movieFolder || !fs.existsSync(movieFolder)) {
        return null;
    }

    const { metadata } = readMediaMetadataForMovieFolder(movieFolder);
    return {
        mode: 'folder',
        videoPath: null,
        folderPath: movieFolder,
        metadata,
        baseHint: requestedFile
    };
}

function resolveVideoPathForMediaRequest(mediaId, season, episode, requestedFile) {
    mediaId = normalizeMediaIdInput(mediaId);

    if (mediaId.startsWith('series/') && Number.isFinite(season) && Number.isFinite(episode)) {
        const showFolder = mediaId.replace(/^series\//, '');
        return resolveSeriesEpisodeVideoPath(showFolder, season, episode);
    }

    const folderPath = resolveMovieFolderPath(mediaId);
    if (!fs.existsSync(folderPath)) return null;
    const explicitFile = sanitizeVideoFileName(requestedFile);
    if (explicitFile) {
        const explicitPath = path.join(folderPath, explicitFile);
        if (fs.existsSync(explicitPath)) return explicitPath;
    }

    const sourceVideo = findSourceVideoInFolder(folderPath);
    return sourceVideo ? path.join(folderPath, sourceVideo) : null;
}

function readMovieMetadataIfPresent(mediaId) {
    const movieFolder = resolveMovieFolderPath(mediaId);
    if (!movieFolder || !fs.existsSync(movieFolder)) return null;

    const metaFilePath = path.join(movieFolder, 'metadata.json');
    if (!fs.existsSync(metaFilePath)) return null;

    try {
        return JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function getNestedValue(source, keyPath) {
    if (!source || !keyPath) return undefined;
    return String(keyPath)
        .split('.')
        .reduce((acc, segment) => (acc && Object.prototype.hasOwnProperty.call(acc, segment) ? acc[segment] : undefined), source);
}

function firstNonEmptyValue(source, candidates = []) {
    for (const keyPath of candidates) {
        const value = getNestedValue(source, keyPath);
        if (Array.isArray(value) && value.length > 0) {
            return value;
        }
        const clean = String(value || '').trim();
        if (clean) return clean;
    }
    return '';
}

function splitPeopleList(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(',');
    return [...new Set(source.map(item => String(item || '').trim()).filter(Boolean))];
}

function buildShortSynopsis(fullText) {
    const clean = String(fullText || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (clean.length <= 240) return clean;
    const sentenceEnd = clean.indexOf('. ');
    if (sentenceEnd > 60 && sentenceEnd < 220) {
        return `${clean.slice(0, sentenceEnd + 1).trim()}…`;
    }
    return `${clean.slice(0, 237).trim()}…`;
}

function normalizeHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) return '';
    return raw;
}

function readRatingFromArray(ratings = [], sourceName = '') {
    const rows = Array.isArray(ratings) ? ratings : [];
    const lookup = String(sourceName || '').toLowerCase();
    const matched = rows.find((row) => String(row?.Source || row?.source || '').toLowerCase() === lookup);
    return String(matched?.Value || matched?.value || '').trim();
}

function normalizeRottenTomatoesScore(value) {
    const clean = String(value || '').trim();
    if (!clean) return '';
    if (/%$/.test(clean)) return clean;
    const numeric = Number(clean);
    if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 100) {
        return `${Math.round(numeric)}%`;
    }
    return clean;
}

function buildMediaDetailsPayload({
    id = '',
    contentType = 'movie',
    title = '',
    year = '',
    genre = '',
    cover = '',
    href = '',
    metadata = {}
} = {}) {
    const synopsisFull = firstNonEmptyValue(metadata, ['synopsis', 'plot', 'Plot', 'overview', 'description']);
    const imdbId = formatImdbId(firstNonEmptyValue(metadata, ['imdbId', 'imdb_id', 'imdbID', 'metadata.imdbId', 'metadata.imdb_id', 'metadata.imdbID']));

    const actors = splitPeopleList(firstNonEmptyValue(metadata, ['actors', 'Actors', 'cast', 'credits.actors']));
    const writers = splitPeopleList(firstNonEmptyValue(metadata, ['writer', 'writers', 'Writer', 'credits.writers']));
    const directors = splitPeopleList(firstNonEmptyValue(metadata, ['director', 'directors', 'Director', 'credits.directors']));

    const ratingsArray = Array.isArray(metadata?.ratings)
        ? metadata.ratings
        : (Array.isArray(metadata?.Ratings) ? metadata.Ratings : []);

    const imdbScore = firstNonEmptyValue(metadata, ['imdbScore', 'imdbRating', 'rating', 'enrichment.imdbScore'])
        || readRatingFromArray(ratingsArray, 'Internet Movie Database');
    const imdbVotes = firstNonEmptyValue(metadata, ['imdbVotes', 'popularity', 'enrichment.popularity']);

    const rtScore = normalizeRottenTomatoesScore(
        firstNonEmptyValue(metadata, ['ratings.rottenTomatoes.score', 'rottenTomatoesScore'])
        || readRatingFromArray(ratingsArray, 'Rotten Tomatoes')
    );

    const imdbLink = normalizeHttpUrl(firstNonEmptyValue(metadata, ['ratings.imdb.url', 'links.imdb']))
        || (imdbId ? `https://www.imdb.com/title/${imdbId}/` : '');
    const rtLink = normalizeHttpUrl(firstNonEmptyValue(metadata, ['ratings.rottenTomatoes.url', 'links.rottenTomatoes', 'links.rotten_tomatoes']));
    const trailerUrl = normalizeHttpUrl(firstNonEmptyValue(metadata, ['trailerUrl', 'trailer', 'links.trailer', 'enrichment.trailerUrl', 'videos.trailer']));

    return {
        id: String(id || '').trim(),
        contentType: contentType === 'series' ? 'series' : 'movie',
        title: String(title || firstNonEmptyValue(metadata, ['title', 'Title']) || '').trim(),
        year: String(year || firstNonEmptyValue(metadata, ['year', 'Year']) || '').trim(),
        genre: String(genre || firstNonEmptyValue(metadata, ['genre', 'Genre', 'enrichment.genre']) || '').trim(),
        cover: String(cover || '').trim(),
        href: String(href || '').trim(),
        imdbId,
        synopsis: {
            short: buildShortSynopsis(synopsisFull),
            full: String(synopsisFull || '').trim()
        },
        credits: {
            actors,
            writers,
            directors
        },
        ratings: {
            imdb: {
                score: String(imdbScore || '').trim(),
                votes: String(imdbVotes || '').trim(),
                url: imdbLink
            },
            rottenTomatoes: {
                score: String(rtScore || '').trim(),
                url: rtLink
            }
        },
        trailer: {
            url: trailerUrl
        },
        links: {
            imdb: imdbLink,
            rottenTomatoes: rtLink,
            trailer: trailerUrl
        },
        updatedAt: String(firstNonEmptyValue(metadata, ['updatedAt', 'pipelineState.lastUpdated']) || '').trim()
    };
}

function isRemoteAllocatedMovie(mediaId) {
    if (String(mediaId || '').startsWith('series/')) return false;
    const metadata = readMovieMetadataIfPresent(mediaId);
    return String(metadata?.storage?.location || '').toLowerCase() === 'remote';
}

// Series equivalent of isRemoteAllocatedMovie(): looks up the one episode's
// own `storage` block (per-episode, unlike a movie's single folder-level
// storage field) via the same rebuildSeriesManifest() merge every other
// series lookup uses, so it can never disagree with what series.json holds.
function findEpisodeStorage(showFolder, seasonNumber, episodeNumber) {
    const showPath = resolveSeriesFolderPath(showFolder, { mustExist: true });
    if (!showPath || !fs.existsSync(showPath)) return null;

    let seriesData;
    try {
        seriesData = rebuildSeriesManifest(showPath, { showFolderName: showFolder, write: false });
    } catch (_err) {
        return null;
    }

    const seasonEntry = (seriesData.seasons || {})[String(seasonNumber)] || null;
    const episodes = Array.isArray(seasonEntry?.episodes) ? seasonEntry.episodes : [];
    const target = episodes.find(ep => Number(ep.episodeNumber) === Number(episodeNumber));
    return target?.storage || null;
}

function isRemoteAllocatedEpisode(showFolder, seasonNumber, episodeNumber) {
    const storage = findEpisodeStorage(showFolder, seasonNumber, episodeNumber);
    return String(storage?.location || '').toLowerCase() === 'remote';
}

// Episode equivalent of MediaService.getPlaybackUrl() for movies - tries each
// profile best-first since a fresh episode may only have 1080p synced yet.
async function resolveEpisodeCloudPlaybackUrl(showFolder, seasonNumber, episodeNumber) {
    const storage = findEpisodeStorage(showFolder, seasonNumber, episodeNumber);
    if (!storage || storage.location !== 'remote') return null;

    for (const profile of ['1080p', '720p', '480p']) {
        const url = await MediaService.getPlaybackUrl({ storage }, profile, null);
        if (url) return url;
    }
    return null;
}

function isAllowedRemoteStreamUrl(inputUrl) {
    try {
        const parsed = new URL(String(inputUrl || ''));
        if (parsed.protocol !== 'https:') return false;
        const host = String(parsed.hostname || '').toLowerCase();
        return host.endsWith('.backblazeb2.com') || host === 's3.us-west-004.backblazeb2.com';
    } catch (_err) {
        return false;
    }
}

function normalizeEpisodeSearchToken(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
}

function readShowMetadataTitle(showPath, fallbackTitle) {
    const metaPath = path.join(showPath, 'metadata.json');
    if (!fs.existsSync(metaPath)) return fallbackTitle;
    try {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        return metadata.title || fallbackTitle;
    } catch (_err) {
        return fallbackTitle;
    }
}

function sanitizeSeriesRelativePath(input = '') {
    const candidate = String(input || '').trim().replace(/\\\\/g, '/');
    if (!candidate) return '';
    if (candidate.startsWith('/')) return '';
    if (candidate.includes('..')) return '';
    return path.posix.normalize(candidate);
}

function normalizeEpisodeManagerUpdate(update = {}) {
    return {
        seasonNumber: Number(update.seasonNumber),
        episodeNumber: Number(update.episodeNumber),
        title: String(update.title || '').trim(),
        localRelativePath: sanitizeSeriesRelativePath(update.localRelativePath || ''),
        subtitleRelativePath: sanitizeSeriesRelativePath(update.subtitleRelativePath || ''),
        released: String(update.released || '').trim(),
        plot: String(update.plot || '').trim(),
        imdbRating: String(update.imdbRating || '').trim()
    };
}

async function isPrivilegedMediaAdmin(req) {
    const activeUser = String(getActiveUser(req) || '').toLowerCase().trim();
    if (!activeUser) return false;
    if (activeUser === 'josh' || activeUser.startsWith('josh@')) return true;

    try {
        const config = await ProfileService.readData(activeUser, 'config', {});
        return config?.isAdmin === true;
    } catch (_err) {
        return false;
    }
}

function resolveEpisodeEntry(seriesData, seasonNumber, episodeNumber) {
    const seasonKey = String(seasonNumber || '').trim();
    const episodeNum = Number(episodeNumber);
    if (!seasonKey || !Number.isFinite(episodeNum) || episodeNum <= 0) return null;

    const episodes = Array.isArray(seriesData?.seasons?.[seasonKey]?.episodes)
        ? seriesData.seasons[seasonKey].episodes
        : [];
    return episodes.find((ep) => Number(ep?.episodeNumber) === episodeNum) || null;
}

function absoluteToSeriesRelativePath(absolutePath) {
    const normalizedAbsolute = path.resolve(String(absolutePath || ''));
    const roots = getSeriesRoots().map((root) => path.resolve(root));

    for (const root of roots) {
        const prefix = `${root}${path.sep}`;
        if (normalizedAbsolute.startsWith(prefix)) {
            return path.relative(root, normalizedAbsolute).split(path.sep).join('/');
        }
    }

    return '';
}

function probeVideoDiagnostics(videoPath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration,bit_rate,size:stream=index,codec_type,codec_name,channels,channel_layout,width,height,avg_frame_rate:stream_tags=language,title',
        '-of', 'json',
        videoPath
    ], { encoding: 'utf8' });

    if (probe.status !== 0) {
        const stderr = String(probe.stderr || probe.stdout || '').trim();
        throw new Error(stderr || 'ffprobe failed for episode video.');
    }

    const parsed = JSON.parse(probe.stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStreams = streams
        .filter((stream) => stream.codec_type === 'video')
        .map((stream) => ({
            index: Number(stream.index),
            codec: String(stream.codec_name || '').toLowerCase(),
            width: Number(stream.width) || 0,
            height: Number(stream.height) || 0,
            resolution: Number(stream.width) > 0 && Number(stream.height) > 0
                ? `${Number(stream.width)}x${Number(stream.height)}`
                : 'unknown',
            frameRate: String(stream.avg_frame_rate || ''),
            language: String(stream.tags?.language || 'und').toLowerCase(),
            title: String(stream.tags?.title || '')
        }));
    const audioStreams = streams
        .filter((stream) => stream.codec_type === 'audio')
        .map((stream) => ({
            index: Number(stream.index),
            codec: String(stream.codec_name || '').toLowerCase(),
            channels: Number(stream.channels) || 0,
            channelLayout: String(stream.channel_layout || ''),
            language: String(stream.tags?.language || 'und').toLowerCase(),
            title: String(stream.tags?.title || '')
        }));

    const browserSafeAudio = new Set(['aac', 'mp3']);
    const requiresDownmix = audioStreams.some((stream) => !browserSafeAudio.has(stream.codec) || (stream.channels > 2));
    const primaryVideo = videoStreams[0] || null;

    return {
        file: path.basename(videoPath),
        path: videoPath,
        videoCodec: primaryVideo?.codec || null,
        videoResolution: primaryVideo?.resolution || null,
        videoStreams,
        format: {
            durationSec: Number(parsed?.format?.duration || 0),
            bitRate: Number(parsed?.format?.bit_rate || 0),
            sizeBytes: Number(parsed?.format?.size || 0)
        },
        streams,
        audioStreams,
        requiresDownmix,
        primaryVideo
    };
}

function runEpisodeAudioDownmixTranscode(videoPath) {
    const source = path.resolve(String(videoPath || ''));
    const parsed = path.parse(source);
    const stem = String(parsed.name || '').replace(/\.web$/i, '');
    const outputPath = path.join(parsed.dir, `${stem}.web.mp4`);
    const tempOutputPath = path.join(parsed.dir, `${stem}.web.audiofix.tmp.mp4`);

    const subtitleExtraction = extractEmbeddedSubtitlesForEpisode(source);

    const args = [
        '-y',
        '-i', source,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '160k',
        '-movflags', '+faststart',
        tempOutputPath
    ];

    const transcode = spawnSync('ffmpeg', args, { encoding: 'utf8' });
    if (transcode.status !== 0 || !fs.existsSync(tempOutputPath)) {
        const stderr = String(transcode.stderr || transcode.stdout || '').trim();
        throw new Error(stderr || 'ffmpeg downmix transcode failed.');
    }

    if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
    }
    fs.renameSync(tempOutputPath, outputPath);

    return {
        source,
        outputPath,
        sourceReplaced: path.resolve(outputPath) === source,
        subtitleExtraction
    };
}

function inferSubtitleLanguage(stream = {}) {
    const lang = String(stream?.tags?.language || '').trim().toLowerCase();
    if (lang) return lang;
    const title = String(stream?.tags?.title || '').toLowerCase();
    if (title.includes('english')) return 'eng';
    return 'und';
}

function normalizeSubtitleLangToken(value = '') {
    const token = String(value || '').trim().toLowerCase();
    if (token === 'en' || token === 'eng' || token === 'english') return 'eng';
    if (!token) return 'und';
    return token.slice(0, 3);
}

function exportSubtitleStreamToPath(videoPath, streamIndex, outPathBase) {
    const outSrt = `${outPathBase}.srt`;
    const outVtt = `${outPathBase}.vtt`;

    const srtExtract = spawnSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'srt',
        outSrt
    ], { encoding: 'utf8' });

    if (srtExtract.status === 0 && fs.existsSync(outSrt)) {
        return { path: outSrt, format: 'srt' };
    }

    const vttExtract = spawnSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'webvtt',
        outVtt
    ], { encoding: 'utf8' });

    if (vttExtract.status === 0 && fs.existsSync(outVtt)) {
        return { path: outVtt, format: 'vtt' };
    }

    return null;
}

function extractEmbeddedSubtitlesForEpisode(videoPath) {
    const source = path.resolve(String(videoPath || ''));
    if (!fs.existsSync(source)) return { exported: [], defaultRelativePath: null, backupDir: null };

    const subtitleStreams = probeSubtitleStreams(source);
    if (!Array.isArray(subtitleStreams) || subtitleStreams.length === 0) {
        return { exported: [], defaultRelativePath: null, backupDir: null };
    }

    const dir = path.dirname(source);
    const parsed = path.parse(source);
    const baseName = String(parsed.name || '').replace(/\.web$/i, '');
    const subsDir = path.join(dir, 'subs');
    fs.mkdirSync(subsDir, { recursive: true });

    const streams = subtitleStreams
        .map((stream) => ({
            stream,
            streamIndex: Number(stream?.index),
            lang: normalizeSubtitleLangToken(inferSubtitleLanguage(stream)),
            isDefault: Number(stream?.disposition?.default) === 1,
            isEnglish: ['eng', 'en'].includes(normalizeSubtitleLangToken(inferSubtitleLanguage(stream)))
        }))
        .filter((row) => Number.isFinite(row.streamIndex));

    if (!streams.length) {
        return { exported: [], defaultRelativePath: null, backupDir: absoluteToSeriesRelativePath(subsDir) || null };
    }

    const defaultCandidate = streams.find((row) => row.isDefault && row.isEnglish)
        || streams.find((row) => row.isEnglish)
        || streams.find((row) => row.isDefault)
        || streams[0];

    const exported = [];
    let defaultRelativePath = null;

    for (const row of streams) {
        const isDefaultSubtitle = row.streamIndex === defaultCandidate.streamIndex;
        const outBase = isDefaultSubtitle
            ? path.join(dir, 'English')
            : path.join(subsDir, `${baseName}.sub.${row.streamIndex}.${row.lang}`);

        const extracted = exportSubtitleStreamToPath(source, row.streamIndex, outBase);
        if (!extracted) continue;

        const relativePath = absoluteToSeriesRelativePath(extracted.path) || null;
        exported.push({
            streamIndex: row.streamIndex,
            lang: row.lang,
            isDefault: isDefaultSubtitle,
            relativePath
        });

        if (isDefaultSubtitle) {
            defaultRelativePath = relativePath;
        }
    }

    return {
        exported,
        defaultRelativePath,
        backupDir: absoluteToSeriesRelativePath(subsDir) || null
    };
}

function detectEpisodeVideoHeight(videoPath) {
    const diagnostics = probeVideoDiagnostics(videoPath);
    const videoStreams = Array.isArray(diagnostics?.streams)
        ? diagnostics.streams.filter((stream) => stream.codec_type === 'video')
        : [];
    const widths = videoStreams.map((stream) => Number(stream.width) || 0).filter((w) => w > 0);
    const heights = videoStreams.map((stream) => Number(stream.height) || 0).filter((h) => h > 0);
    const maxWidth = widths.length ? Math.max(...widths) : 0;
    const maxHeight = heights.length ? Math.max(...heights) : 0;
    return {
        diagnostics,
        maxWidth,
        maxHeight,
        isHighResLike:
            maxWidth >= 3000 ||
            maxHeight >= 1600 ||
            maxWidth >= 1920 ||
            maxHeight >= 1080 ||
            /\b(2160p|4k|uhd)\b/i.test(path.basename(String(videoPath || '')))
    };
}

function runEpisodeProfileTranscode(videoPath, profile = '1080p', options = {}) {
    const targetProfile = String(profile || '').trim().toLowerCase();
    if (!['1080p', '720p'].includes(targetProfile)) {
        throw new Error(`Unsupported profile target: ${targetProfile}`);
    }

    const forceReprocess = options?.forceReprocess === true || String(options?.forceReprocess || '').toLowerCase() === 'true';

    const source = path.resolve(String(videoPath || ''));
    const parsed = path.parse(source);
    const stem = String(parsed.name || '').replace(/\.web$/i, '');

    if (targetProfile === '1080p') {
        const videoState = detectEpisodeVideoHeight(source);
        if (!videoState.isHighResLike && !forceReprocess) {
            throw new Error('1080p build requires a source at least 1920-wide or 1080-high unless force is enabled.');
        }

        const outputPath = path.join(parsed.dir, `${stem}.web.mp4`);
        const tempOutputPath = path.join(parsed.dir, `${stem}.web.profile1080.tmp.mp4`);

        const ffmpegArgs = [
            '-y',
            '-i', source,
            '-map', '0:v:0',
            '-map', '0:a:0',
            '-vf', 'scale=-2:1080:sws_flags=lanczos',
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '22',
            '-c:a', 'aac',
            '-ac', '2',
            '-b:a', '192k',
            '-movflags', '+faststart',
            tempOutputPath
        ];

        const transcode = spawnSync('ffmpeg', ffmpegArgs, { encoding: 'utf8' });
        if (transcode.status !== 0 || !fs.existsSync(tempOutputPath)) {
            const stderr = String(transcode.stderr || transcode.stdout || '').trim();
            throw new Error(stderr || 'ffmpeg 1080p profile transcode failed.');
        }

        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        fs.renameSync(tempOutputPath, outputPath);
        return {
            profile: '1080p',
            source,
            outputPath,
            sourceWas4k: videoState.maxWidth >= 3000 || videoState.maxHeight >= 1600,
            sourceWasHighRes: videoState.isHighResLike,
            maxWidth: videoState.maxWidth,
            maxHeight: videoState.maxHeight,
            forceReprocess
        };
    }

    const preferred1080 = path.join(parsed.dir, `${stem}.web.mp4`);
    const inputPath = fs.existsSync(preferred1080) ? preferred1080 : source;
    const outputPath = path.join(parsed.dir, `${stem}.720p.mp4`);

    const ffmpegArgs = [
        '-y',
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', '0:a:0',
        '-vf', 'scale=-2:720:sws_flags=lanczos',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '25',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputPath
    ];

    const transcode = spawnSync('ffmpeg', ffmpegArgs, { encoding: 'utf8' });
    if (transcode.status !== 0 || !fs.existsSync(outputPath)) {
        const stderr = String(transcode.stderr || transcode.stdout || '').trim();
        throw new Error(stderr || 'ffmpeg 720p profile transcode failed.');
    }

    return {
        profile: '720p',
        source,
        inputPath,
        outputPath,
        forceReprocess
    };
}

function buildEpisodeManagerItems(showFolder, showPath, seriesData) {
    const seasons = seriesData?.seasons || {};
    const items = [];

    Object.keys(seasons)
        .sort((a, b) => Number(a) - Number(b))
        .forEach((seasonKey) => {
            const seasonNumber = Number(seasonKey);
            const episodes = Array.isArray(seasons[seasonKey]?.episodes) ? seasons[seasonKey].episodes : [];

            episodes.forEach((ep) => {
                const episodeNumber = Number(ep.episodeNumber);
                const localRelativePath = sanitizeSeriesRelativePath(ep.localRelativePath || '');
                const subtitleRelativePath = sanitizeSeriesRelativePath(ep.subtitleRelativePath || '');
                const videoPath = localRelativePath ? resolveRelativePathInSeriesRoots(localRelativePath) : '';
                const subtitleCandidates = (videoPath && fs.existsSync(videoPath))
                    ? listSubtitleCandidatesForVideo(videoPath, { includeEmbedded: false }).map((candidate) => ({
                        file: candidate.file,
                        relativePath: sanitizeSeriesRelativePath(candidate.relativePath || ''),
                        lang: candidate.langHint || ''
                    }))
                    : [];

                items.push({
                    seasonNumber,
                    episodeNumber,
                    title: ep.title || `Episode ${episodeNumber}`,
                    released: ep.released || '',
                    plot: ep.plot || '',
                    imdbRating: ep.imdbRating || '',
                    available: Boolean(ep.available),
                    localRelativePath,
                    subtitleRelativePath,
                    videoFile: localRelativePath ? path.basename(localRelativePath) : '',
                    subtitleCandidates
                });
            });
        });

    return {
        showFolder,
        showPath,
        totalSeasons: String(seriesData?.totalSeasons || '0'),
        count: items.length,
        items
    };
}

async function buildTvSeasonBrowser(imdbId) {
    const cleanImdbId = formatImdbId(imdbId);
    if (!cleanImdbId) return null;

    const indexItem = getSeriesByImdbId(cleanImdbId);
    const fallbackTitle = String(indexItem?.title || indexItem?.originalTitle || '').trim();
    const fallbackYear = String(indexItem?.startYear || '').trim();

    const metadataLookup = await metadataProvider.fetchMetadataWithFallback({
        imdbId: cleanImdbId,
        title: fallbackTitle,
        year: fallbackYear,
        contentType: 'series'
    });

    const metadata = metadataLookup?.data && metadataLookup.data.Response === 'True'
        ? metadataLookup.data
        : null;

    if (!metadata) return null;

    const totalSeasons = Number.isFinite(parseInt(metadata.totalSeasons, 10)) ? parseInt(metadata.totalSeasons, 10) : null;
    const maxProbeSeasons = totalSeasons && totalSeasons > 0 ? totalSeasons : 25;
    const showTitle = String(metadata.Title || fallbackTitle || '').trim();
    const seasons = [];
    let emptyStreak = 0;

    for (let seasonNumber = 1; seasonNumber <= maxProbeSeasons; seasonNumber += 1) {
        const episodes = await metadataProvider.fetchSeasonEpisodesWithFallback({
            imdbId: cleanImdbId,
            title: showTitle,
            season: seasonNumber,
            tmdbId: metadata.tmdbId || null
        });

        if (!Array.isArray(episodes) || episodes.length === 0) {
            if (!totalSeasons && seasons.length > 0) {
                emptyStreak += 1;
                if (emptyStreak >= 2) break;
            }
            continue;
        }

        emptyStreak = 0;
        const normalizedEpisodes = episodes
            .map((episode) => ({
                episodeNumber: Number(episode.Episode),
                title: String(episode.Title || '').trim() || `Episode ${episode.Episode}`,
                released: String(episode.Released || '').trim() || 'Unknown',
                imdbRating: String(episode.imdbRating || '').trim() || 'N/A'
            }))
            .filter((episode) => Number.isFinite(episode.episodeNumber) && episode.episodeNumber > 0)
            .sort((a, b) => a.episodeNumber - b.episodeNumber);

        seasons.push({
            seasonNumber,
            totalEpisodes: normalizedEpisodes.length,
            episodes: normalizedEpisodes
        });
    }

    const episodeCount = seasons.reduce((sum, season) => sum + season.totalEpisodes, 0);

    return {
        imdbId: cleanImdbId,
        title: showTitle,
        originalTitle: String(metadata.originalTitle || showTitle || '').trim(),
        startYear: String(metadata.Year || fallbackYear || '').trim(),
        endYear: String(metadata.endYear || '').trim(),
        plot: String(metadata.Plot || '').trim(),
        genres: String(metadata.Genre || '').trim(),
        cover: tvCoverUrl(cleanImdbId),
        provider: metadataLookup.provider || 'unknown',
        totalSeasons: String(totalSeasons || seasons.length || 0),
        episodeCount,
        seasons
    };
}

// =========================================================================
// ENDPOINTS
// =========================================================================

// GET: /api/library (Serves the entire dashboard instantly out of memory)
router.get('/library', async (req, res) => {
    try {
        const library = await getLibrary();
        return res.json({ success: true, library });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/home-feed (Serves the pre-generated home page collections cache)
router.get('/home-feed', (req, res) => {
    res.set('Cache-Control', 'private, max-age=5, stale-while-revalidate=10');
    const homeFeed = loadHomeFeedWithFallback();
    if (!homeFeed) {
        return res.status(503).json({
            success: false,
            error: 'Home feed cache missing. Ask admin to regenerate the home feed.'
        });
    }

    const activeUser = getActiveUser(req);

    return getLibrary()
        .then(async (library) => {
            const allLibraryRows = [
                ...(Array.isArray(library?.movies) ? library.movies : []),
                ...(Array.isArray(library?.shows) ? library.shows : [])
            ];

            const validLibraryIds = new Set(allLibraryRows.map(item => String(item?.id || '')).filter(Boolean));

            const visibleLibraryRows = allLibraryRows.filter((item) => canUserSeeMedia(item, activeUser));
            const visibleLibraryIds = new Set(visibleLibraryRows.map((item) => String(item?.id || '')).filter(Boolean));

            const globalLibraryIds = new Set(
                allLibraryRows
                    .filter((item) => getGroupsFromMedia(item).includes(GROUP_GLOBAL))
                    .map((item) => String(item?.id || ''))
                    .filter(Boolean)
            );

            const myLibraryCollection = buildMyLibraryCollection(library, activeUser, { limit: 18 });
            myLibraryCollection.cards = (myLibraryCollection.cards || []).map((item) => normalizeCard(item));

            let myShowsCollection = null;
            if (activeUser) {
                const subscriptions = await SeriesSubscriptionService.readSubscriptions(activeUser);
                myShowsCollection = SeriesSubscriptionService.buildMyShowsCollection(library, activeUser, {
                    limit: 18,
                    subscriptions: subscriptions.items
                });
                if (myShowsCollection) {
                    myShowsCollection.cards = (myShowsCollection.cards || []).map((item) => normalizeCard(item));
                }
            }

            const existing = Array.isArray(homeFeed.collections) ? homeFeed.collections : [];
            const withoutExistingMyShelf = existing
                .filter((collection) => collection.id !== 'my-library-row')
                .filter((collection) => collection.id !== 'my-shows-row')
                .map((collection) => {
                    const cards = Array.isArray(collection.cards) ? collection.cards : [];

                    if (collection.id === 'recently-added-row') {
                        return {
                            ...collection,
                            cards: cards.filter((card) => {
                                const cardId = String(card?.id || '');
                                return validLibraryIds.has(cardId) && globalLibraryIds.has(cardId);
                            })
                        };
                    }

                    return {
                        ...collection,
                        cards: cards.filter((card) => {
                            const cardId = String(card?.id || '');
                            return validLibraryIds.has(cardId) && visibleLibraryIds.has(cardId);
                        })
                    };
                });
            const first = withoutExistingMyShelf[0] || null;
            const tail = withoutExistingMyShelf.slice(1);

            const collectionsWithPersonalShelves = [];
            if (first) {
                collectionsWithPersonalShelves.push(first);
            }
            collectionsWithPersonalShelves.push(myLibraryCollection);
            if (myShowsCollection && Array.isArray(myShowsCollection.cards) && myShowsCollection.cards.length > 0) {
                collectionsWithPersonalShelves.push(myShowsCollection);
            }
            collectionsWithPersonalShelves.push(...tail);

            const collections = collectionsWithPersonalShelves;

            return res.json({
                success: true,
                feed: {
                    ...homeFeed,
                    collections
                }
            });
        })
        .catch((err) => {
            return res.status(500).json({ success: false, error: err.message });
        });
});

router.get('/tv-shows/search', async (req, res) => {
    try {
        const query = String(req.query.q || req.query.query || '').trim();
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 40, 100));
        const localOnly = ['1', 'true', 'yes', 'local'].includes(String(req.query.localOnly || req.query.source || '').toLowerCase());
        const index = loadIndex();
        let items = searchIndex(query, limit).map(withCover);
        let source = 'local-index';

        // Container deployments may not have the generated local index file.
        // For non-empty queries, fall back to OMDb search so TV browse still works.
        if (!localOnly && items.length === 0 && query) {
            const apiKey = process.env.OMDB_API_KEY || '84196d01';
            const omdbRes = await axios.get(
                `http://www.omdbapi.com/?apikey=${apiKey}&s=${encodeURIComponent(query)}&type=series`,
                { timeout: 8000 }
            );

            const fallback = Array.isArray(omdbRes.data?.Search) ? omdbRes.data.Search : [];
            items = fallback
                .slice(0, limit)
                .map(row => {
                    const yearRaw = String(row.Year || '');
                    const [startYear, endYear] = yearRaw.split('-');
                    return withCover({
                        imdbId: row.imdbID,
                        title: row.Title,
                        originalTitle: row.Title,
                        startYear: startYear || '',
                        endYear: endYear || '',
                        genres: '',
                        averageRating: 0,
                        numVotes: 0,
                        episodeCount: 0,
                        isAdult: false
                    });
                });

            if (items.length > 0) {
                source = 'omdb-fallback';
            }
        }

        const library = await getLibrary();
        const localShows = Array.isArray(library?.shows) ? library.shows : [];
        const seriesIndex = buildLibrarySeriesIndexes(localShows);

        const mappedItems = items.map((item) => {
            const imdbId = formatImdbId(item.imdbId || '');
            const titleKey = normalizeSearchText(item.title || '');
            const localMatch = (imdbId && seriesIndex.byImdb.get(imdbId)) || seriesIndex.byTitle.get(titleKey) || null;

            return {
                ...item,
                imdbId,
                inLibrary: Boolean(localMatch),
                localShowId: localMatch?.id || null,
                localHref: localMatch?.id ? `/series.html?id=${encodeURIComponent(localMatch.id)}` : null
            };
        });

        return res.json({
            success: true,
            source,
            updatedAt: index.updatedAt,
            totalItems: index.totalItems,
            count: mappedItems.length,
            items: mappedItems,
            missingBasics: index.totalItems === 0 && items.length === 0
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/tv-series/index', async (_req, res) => {
    try {
        const index = loadIndex();
        return res.json({
            success: true,
            ...index
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/tv-shows/:imdbId', (req, res) => {
    try {
        const item = getSeriesByImdbId(req.params.imdbId);
        if (!item) {
            return res.status(404).json({ success: false, error: 'Series not found in local index.' });
        }
        return res.json({ success: true, item: withCover(item) });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/tv-shows/:imdbId/episodes', async (req, res) => {
    try {
        const imdbId = formatImdbId(req.params.imdbId);
        if (!imdbId) {
            return res.status(400).json({ success: false, error: 'Invalid IMDb ID.' });
        }

        const browser = await buildTvSeasonBrowser(imdbId);
        if (!browser) {
            return res.status(404).json({ success: false, error: 'Series not found in IMDb metadata.' });
        }

        return res.json({
            success: true,
            ...browser
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/tv-shows/:imdbId/cover', async (req, res) => {
    try {
        const imdbId = formatImdbId(req.params.imdbId);
        if (!imdbId) {
            return res.status(400).send('Invalid IMDb ID');
        }

        const coverPath = path.join(TV_COVER_DIR, `${imdbId}.jpg`);
        if (fs.existsSync(coverPath)) {
            return res.sendFile(coverPath);
        }

        fs.mkdirSync(TV_COVER_DIR, { recursive: true });

        const apiKey = process.env.OMDB_API_KEY || '84196d01';
        const omdbRes = await axios.get(`http://www.omdbapi.com/?apikey=${apiKey}&i=${encodeURIComponent(imdbId)}`, {
            timeout: 8000
        });
        const posterUrl = omdbRes.data?.Poster;

        if (!posterUrl || posterUrl === 'N/A') {
            return res.status(404).send('No cover found');
        }

        const imageRes = await axios.get(posterUrl, {
            responseType: 'arraybuffer',
            timeout: 12000
        });
        await fsPromises.writeFile(coverPath, Buffer.from(imageRes.data));
        return res.sendFile(coverPath);
    } catch (_err) {
        return res.status(404).send('No cover found');
    }
});

// GET: /api/movies (High-Performance Paginated Catalog Discovery utilizing Redis lookups)
// =========================================================================
// 🎬 UNIFIED MEDIA CATALOG ROUTE (Surfaces Both Movies & TV Shows)
// =========================================================================
router.get('/movies', async (req, res) => {
    try {
        // Safe extraction from your actual hot-cache database layout
        const library = await getLibrary();
        const activeUser = getActiveUser(req);
        const cachedMovies = (library.movies || []).filter((item) => canUserSeeMedia(item, activeUser));
        const cachedShows = (library.shows || []).filter((item) => canUserSeeMedia(item, activeUser));

        // Normalize data flags: ensure TV Shows have their flag set for index.html mapping
        const normalizedShows = cachedShows.map(show => ({
            ...show,
            contentType: 'series',
            // Map keys if your front end is looking for media.id vs show path matching
            cover: show.cover || show.poster || `/movie-assets/series/${encodeURIComponent(show.id.replace('series/', ''))}/cover.jpg`
        }));

        // Combine both internal asset segments into a flat layout matching index.html execution blocks
        const combinedCatalog = [...cachedMovies, ...normalizedShows].map(item => {
            const versionKey = encodeURIComponent(item.updatedAt || library.lastScan || Date.now());
            // Route local movie-assets covers through the CDN when the sync job has
            // confirmed the object is synced; toCdnUrl returns '' otherwise, leaving
            // the origin path untouched.
            const coverBase = toCdnUrl(item.cover) || item.cover;
            const separator = (coverBase || '').includes('?') ? '&' : '?';
            return {
                ...item,
                cover: coverBase ? `${coverBase}${separator}v=${versionKey}` : coverBase
            };
        });

        // Perform clean alphabetic ordering so collections don't randomly flip positions
        combinedCatalog.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 24; 
        
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;

        const paginatedCatalog = combinedCatalog.slice(startIndex, endIndex);

        res.json({
            totalMovies: combinedCatalog.length, // Matches frontend object unpacking key expectation
            totalPages: Math.ceil(combinedCatalog.length / limit),
            currentPage: page,
            movies: paginatedCatalog
        });
    } catch (err) {
        console.error("❌ Unified library catalog processing breakdown:", err);
        res.status(500).json({ success: false, error: "Failed to assemble structured movie matrix blocks." });
    }
});

router.get('/movies/search/unified', async (req, res) => {
    try {
        const query = String(req.query.q || req.query.query || '').trim();
        const queryNorm = normalizeSearchText(query);
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const remoteLimit = Math.max(1, Math.min(parseInt(req.query.remoteLimit, 10) || 24, 50));
        const localLimit = Math.max(1, Math.min(parseInt(req.query.localLimit, 10) || 8, 50));
        const remoteMode = String(req.query.remoteMode || 'always').toLowerCase();

        const genre = String(req.query.genre || '').trim();
        const minimumRating = String(req.query.minimum_rating || req.query.minimumRating || '').trim();
        const sortBy = String(req.query.sort_by || req.query.sortBy || 'date_added').trim();

        const library = await getLibrary();
        const localRows = buildLocalMovieCatalogRows(library);

        const builtIndexMatches = queryNorm
            ? MovieTitleIndexService.searchIndex(query, localLimit)
            : [];

        const localMatchMap = new Map(localRows.map(item => [normalizeMovieImdbId(item.imdbId || ''), item]));

        const localResultsFromBuiltIndex = builtIndexMatches.map((item) => {
            const imdbId = normalizeMovieImdbId(item.imdbId || '');
            const localRow = localMatchMap.get(imdbId) || null;
            return {
                ...item,
                type: 'movie',
                inLibrary: Boolean(localRow),
                href: localRow?.href || null,
                source: 'imdb-catalog'
            };
        });

        const localMatches = localResultsFromBuiltIndex;

        const shouldFetchRemote = remoteMode === 'always'
            || (remoteMode === 'on_local_empty' && localMatches.length === 0)
            || (!queryNorm && remoteMode !== 'never');

        let remoteResults = [];
        let remoteTotal = 0;
        let remotePageLimit = remoteLimit;

        if (shouldFetchRemote) {
            const ytsUrl = 'https://movies-api.accel.li/api/v2/list_movies.json';
            const apiParams = {
                page,
                limit: remoteLimit,
                order_by: 'desc',
                sort_by: sortBy || 'date_added'
            };

            if (query) apiParams.query_term = query;
            if (genre && genre.toLowerCase() !== 'all') apiParams.genre = genre.toLowerCase();
            if (minimumRating && minimumRating !== '0') apiParams.minimum_rating = minimumRating;

            const ytsRes = await axios.get(ytsUrl, { params: apiParams, timeout: 12000 });
            const ytsData = ytsRes?.data?.data || {};
            const remoteRows = Array.isArray(ytsData.movies) ? ytsData.movies : [];
            remoteTotal = Number(ytsData.movie_count || 0);
            remotePageLimit = Number(ytsData.limit || remoteLimit) || remoteLimit;

            const localKeys = indexLocalMovieKeys(localRows);

            remoteResults = remoteRows.map((movie) => {
                const imdbId = normalizeMovieImdbId(movie.imdb_code || movie.imdbId || '');
                const titleKey = normalizeSearchText(movie.title || '');
                const yearKey = String(movie.year || '').trim();
                const inLibrary = Boolean(
                    (imdbId && localKeys.imdbSet.has(imdbId))
                    || (titleKey && yearKey && localKeys.titleYearSet.has(`${titleKey}|${yearKey}`))
                );

                return {
                    title: movie.title,
                    year: movie.year,
                    imdbId,
                    imdbRating: movie.rating,
                    runtime: movie.runtime,
                    cover: movie.medium_cover_image || movie.large_cover_image || '',
                    torrents: Array.isArray(movie.torrents) ? movie.torrents : [],
                    inLibrary,
                    source: 'remote-yts'
                };
            });
        }

        return res.json({
            success: true,
            query,
            localCount: localMatches.length,
            localResults: localMatches,
            remoteFetched: shouldFetchRemote,
            remoteCount: remoteResults.length,
            remoteTotal,
            remotePage: page,
            remotePageLimit,
            remoteResults
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/movies/search/index', async (req, res) => {
    try {
        const query = String(req.query.q || req.query.query || '').trim();
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 30, 100));
        const localOnly = ['1', 'true', 'yes', 'local'].includes(String(req.query.localOnly || '').toLowerCase());
        const imdbId = MovieTitleIndexService.normalizeImdbId(req.query.imdbId || req.query.id || req.query.imdb || '');

        const library = await getLibrary();
        const localRows = buildLocalMovieCatalogRows(library);
        const localMap = new Map(localRows.map(item => [normalizeMovieImdbId(item.imdbId || ''), item]));

        let indexResults = [];
        if (imdbId) {
            const match = MovieTitleIndexService.getByImdbId(imdbId);
            if (match) indexResults = [match];
        } else if (query) {
            indexResults = MovieTitleIndexService.searchIndex(query, limit);
        }

        if (localOnly) {
            indexResults = indexResults.filter((item) => {
                const normalizedImdb = MovieTitleIndexService.normalizeImdbId(item.imdbId || '');
                return normalizedImdb && localMap.has(normalizedImdb);
            });
        }

        const items = indexResults.map((item) => mapCatalogMovieToResult(item, localMap));

        return res.json({
            success: true,
            source: 'imdb-catalog',
            query,
            count: items.length,
            items,
            localLibraryCount: localRows.length
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/catalogs/movies', async (_req, res) => {
    try {
        const dirEntries = listCatalogFilesByDirectory();
        const allCatalogFiles = dirEntries.flatMap(entry => entry.files.map(fileName => ({ fileName, dirPath: entry.dirPath })));

        if (!allCatalogFiles.length) {
            return res.json({ success: true, catalogs: [] });
        }

        const preferredBySlug = new Map();
        for (const entry of allCatalogFiles) {
            const slug = toCatalogSlug(entry.fileName);
            const isTrimmed = /_trimmed\.json$/i.test(entry.fileName);
            const current = preferredBySlug.get(slug);

            if (!current) {
                preferredBySlug.set(slug, { ...entry, slug, isTrimmed });
                continue;
            }

            if (!current.isTrimmed && isTrimmed) {
                preferredBySlug.set(slug, { ...entry, slug, isTrimmed });
            }
        }

        const catalogs = Array.from(preferredBySlug.values()).map((entry) => {
            const slug = entry.slug;
            const filePath = path.join(entry.dirPath, entry.fileName);
            let count = 0;

            try {
                const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                count = Array.isArray(raw) ? raw.length : 0;
            } catch (_err) {
                count = 0;
            }

            return {
                slug,
                title: catalogDisplayName(slug),
                count,
                icon: getCatalogIcon(slug),
                weight: getCatalogSortWeight(slug)
            };
        })
            .sort((a, b) => a.weight - b.weight || a.title.localeCompare(b.title))
            .map(({ weight, ...item }) => item);

        return res.json({ success: true, catalogs });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/catalogs/movies/:slug', async (req, res) => {
    try {
        const slug = String(req.params.slug || '').trim().toLowerCase();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 24, 100));

        const catalogRows = readCatalogJsonBySlug(slug);
        if (!catalogRows) {
            return res.status(404).json({ success: false, error: 'Catalog not found.' });
        }

        const library = await getLibrary();
        const localRows = buildLocalMovieCatalogRows(library);
        const index = buildLibraryMovieIndexes(localRows);

        const mapped = catalogRows.map((item) => {
            const imdbId = normalizeMovieImdbId(item.id || item.imdbId || '');
            const title = String(item.title || '').trim();
            const year = String(item.year || '').trim();

            const titleKey = normalizeSearchText(title);
            const byImdb = imdbId ? index.byImdb.get(imdbId) : null;
            const byTitleYear = titleKey && year ? index.byTitleYear.get(`${titleKey}|${year}`) : null;
            const localMatch = byImdb || byTitleYear || null;

            return {
                imdbId,
                title,
                year: item.year || '',
                rating: item.rating,
                votes: item.votes,
                genres: Array.isArray(item.genres) ? item.genres : [],
                cover: getCatalogCoverUrl(imdbId),
                localCover: localMatch?.id ? versionCoverUrl(`/movie-assets/${encodeURIComponent(localMatch.id)}/cover.jpg`) : '',
                inLibrary: Boolean(localMatch),
                localId: localMatch?.id || null,
                localHref: localMatch?.id ? `/player.html?id=${encodeURIComponent(localMatch.id)}` : null
            };
        });

        const total = mapped.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const start = (page - 1) * limit;
        const items = mapped.slice(start, start + limit);

        return res.json({
            success: true,
            slug,
            title: catalogDisplayName(slug),
            total,
            totalPages,
            page,
            limit,
            items
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/catalogs/movies/cover/:imdbId', async (req, res) => {
    try {
        const imdbId = normalizeMovieImdbId(req.params.imdbId || '');
        if (!imdbId) {
            return res.status(400).json({ success: false, error: 'Invalid IMDb ID.' });
        }

        const coverPath = path.join(CATALOG_COVER_DIR, `${imdbId}.jpg`);
        if (fs.existsSync(coverPath) && fs.statSync(coverPath).size > 0) {
            return res.sendFile(coverPath);
        }

        fs.mkdirSync(CATALOG_COVER_DIR, { recursive: true });

        let posterUrl = '';

        try {
            const apiKey = process.env.OMDB_API_KEY || '84196d01';
            const omdbRes = await axios.get(`http://www.omdbapi.com/?apikey=${apiKey}&i=${encodeURIComponent(imdbId)}`, {
                timeout: 8000
            });
            posterUrl = String(omdbRes.data?.Poster || '').trim();
            if (posterUrl === 'N/A') posterUrl = '';
        } catch (_omdbErr) {
            posterUrl = '';
        }

        if (!posterUrl) {
            const tmdbApiKey = String(process.env.THEMOVIEDB_API_KEY || '').trim();
            const tmdbBearer = String(process.env.THEMOVIEDB_API_READ_ACCESS_TOKEN || '').trim();
            const tmdbBase = String(process.env.TMDB_API_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');

            if (tmdbApiKey || tmdbBearer) {
                const tmdbHeaders = tmdbBearer ? { Authorization: `Bearer ${tmdbBearer}` } : {};
                const tmdbUrl = tmdbApiKey
                    ? `${tmdbBase}/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(tmdbApiKey)}&external_source=imdb_id`
                    : `${tmdbBase}/find/${encodeURIComponent(imdbId)}?external_source=imdb_id`;

                try {
                    const tmdbRes = await axios.get(tmdbUrl, { headers: tmdbHeaders, timeout: 9000 });
                    const movie = Array.isArray(tmdbRes.data?.movie_results) ? tmdbRes.data.movie_results[0] : null;
                    const posterPath = String(movie?.poster_path || '').trim();
                    if (posterPath) {
                        posterUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
                    }
                } catch (_tmdbErr) {
                    posterUrl = '';
                }
            }
        }

        if (!posterUrl || posterUrl === 'N/A') {
            return res.status(404).json({ success: false, error: 'Poster unavailable.' });
        }

        const imageRes = await axios.get(posterUrl, {
            responseType: 'arraybuffer',
            timeout: 12000
        });
        await fsPromises.writeFile(coverPath, Buffer.from(imageRes.data));
        return res.sendFile(coverPath);
    } catch (err) {
        return res.status(404).json({ success: false, error: err.message || 'Poster fetch failed.' });
    }
});

router.get('/catalogs/tv', async (_req, res) => {
    try {
        const dirEntries = listTvCatalogFilesByDirectory();
        const allCatalogFiles = dirEntries.flatMap(entry => entry.files.map(fileName => ({ fileName, dirPath: entry.dirPath })));

        if (!allCatalogFiles.length) {
            return res.json({ success: true, defaultSlug: null, catalogs: [] });
        }

        const catalogs = allCatalogFiles
            .map((entry) => {
                const slug = toTvCatalogSlug(entry.fileName);
                const filePath = path.join(entry.dirPath, entry.fileName);
                let count = 0;

                try {
                    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    count = Array.isArray(raw) ? raw.length : 0;
                } catch (_err) {
                    count = 0;
                }

                return {
                    slug,
                    title: tvCatalogDisplayName(slug),
                    count,
                    icon: getTvCatalogIcon(slug),
                    weight: getTvCatalogSortWeight(slug)
                };
            })
            .sort((a, b) => a.weight - b.weight || a.title.localeCompare(b.title))
            .map(({ weight, ...item }) => item);

        const defaultSlug = catalogs.find(item => item.slug === 'trending_50')?.slug || catalogs[0]?.slug || null;

        return res.json({ success: true, defaultSlug, catalogs });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/catalogs/tv/:slug', async (req, res) => {
    try {
        const slug = String(req.params.slug || '').trim().toLowerCase();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 100));

        const catalogRows = readTvCatalogJsonBySlug(slug);
        if (!catalogRows) {
            return res.status(404).json({ success: false, error: 'TV catalog not found.' });
        }

        const library = await getLibrary();
        const localShows = Array.isArray(library?.shows) ? library.shows : [];
        const seriesIndex = buildLibrarySeriesIndexes(localShows);

        const mapped = catalogRows.map((item) => {
            const imdbId = formatImdbId(item.imdbId || item.id || '');
            const fallbackCover = tvCoverUrl(imdbId);
            const title = String(item.title || item.name || '').trim();
            const localMatch = (imdbId && seriesIndex.byImdb.get(imdbId)) || seriesIndex.byTitle.get(normalizeSearchText(title)) || null;

            return {
                imdbId,
                tmdbId: item.tmdbId || null,
                title,
                originalTitle: String(item.originalTitle || '').trim(),
                startYear: String(item.startYear || '').trim(),
                endYear: String(item.endYear || '').trim(),
                genres: Array.isArray(item.genres) ? item.genres.join(', ') : String(item.genres || '').trim(),
                averageRating: Number(item.averageRating || item.rating || 0) || 0,
                numVotes: Number(item.numVotes || item.votes || 0) || 0,
                popularity: Number(item.popularity || 0) || 0,
                episodeCount: Number(item.episodeCount || 0) || 0,
                source: item.source || 'catalog',
                cover: String(item.cover || '').trim() || fallbackCover,
                inLibrary: Boolean(localMatch),
                localShowId: localMatch?.id || null,
                localHref: localMatch?.id ? `/series.html?id=${encodeURIComponent(localMatch.id)}` : null
            };
        });

        const total = mapped.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const start = (page - 1) * limit;
        const items = mapped.slice(start, start + limit);

        return res.json({
            success: true,
            slug,
            title: tvCatalogDisplayName(slug),
            total,
            totalPages,
            page,
            limit,
            items
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/tv-shows/:imdbId/library-status', async (req, res) => {
    try {
        const imdbId = formatImdbId(req.params.imdbId || '');
        if (!imdbId) {
            return res.status(400).json({ success: false, error: 'Invalid IMDb ID.' });
        }

        const library = await getLibrary();
        const shows = Array.isArray(library?.shows) ? library.shows : [];
        const localShow = shows.find((item) => formatImdbId(item.imdbId || item.imdb_id || '') === imdbId) || null;

        if (!localShow) {
            return res.json({
                success: true,
                imdbId,
                inLibrary: false,
                show: null,
                seasons: [],
                availableEpisodeKeys: []
            });
        }

        const sourceFolder = localShow?.sourcePath ? path.basename(localShow.sourcePath) : '';
        const fallbackFolder = normalizeShowFolderInput(String(localShow.id || '').replace(/^series\//i, ''));
        const showFolder = normalizeShowFolderInput(sourceFolder || fallbackFolder);
        const showPath = resolveSeriesFolderPath(showFolder, { mustExist: true });

        if (!showFolder || !showPath || !fs.existsSync(showPath)) {
            return res.json({
                success: true,
                imdbId,
                inLibrary: true,
                show: {
                    id: localShow.id || null,
                    title: localShow.title || '',
                    showFolder: showFolder || null,
                    localHref: localShow.id ? `/series.html?id=${encodeURIComponent(localShow.id)}` : null
                },
                seasons: [],
                availableEpisodeKeys: []
            });
        }

        const manifest = rebuildSeriesManifest(showPath, {
            showFolderName: showFolder,
            write: true
        });

        const seasons = [];
        const availableEpisodeKeys = [];
        const seasonBlocks = manifest?.seasons || {};

        Object.keys(seasonBlocks)
            .sort((a, b) => Number(a) - Number(b))
            .forEach((seasonKey) => {
                const seasonNumber = Number(seasonKey);
                const episodes = Array.isArray(seasonBlocks[seasonKey]?.episodes) ? seasonBlocks[seasonKey].episodes : [];
                const availableEpisodes = episodes
                    .filter((ep) => Boolean(ep?.available) || Boolean(String(ep?.localRelativePath || '').trim()))
                    .map((ep) => Number(ep.episodeNumber))
                    .filter((epNum) => Number.isFinite(epNum) && epNum > 0)
                    .sort((a, b) => a - b);

                availableEpisodes.forEach((epNum) => {
                    availableEpisodeKeys.push(`${seasonNumber}-${epNum}`);
                });

                seasons.push({
                    seasonNumber,
                    totalEpisodes: episodes.length,
                    availableCount: availableEpisodes.length,
                    availableEpisodes
                });
            });

        return res.json({
            success: true,
            imdbId,
            inLibrary: true,
            show: {
                id: localShow.id || null,
                title: localShow.title || '',
                showFolder,
                localHref: localShow.id ? `/series.html?id=${encodeURIComponent(localShow.id)}` : null
            },
            seasons,
            availableEpisodeKeys
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});



// GET: /api/movies/:id (Individual Stream Quality Switcher Profile Router)
router.get('/movies/:id', async (req, res) => {
    // Extract the user session or authentication token from the request
    //commented out till we fix the playback subscription checker
    // const userKey = getActiveUser(req);

    // if (!userKey) {
    //     return res.status(401).json({ error: 'Authentication required.' });
    // }

    // try {
    //     const sub = await ProfileService.getSubscriptionStatus(userKey);
    //     if (!sub.active) {
    //         return res.status(403).json({ 
    //             error: 'Subscription Required', 
    //             reason: sub.reason,
    //             redirectTo: '/subscribe.html?reason=trial_expired'
    //         });
    //     }
    // } catch (err) {
    //     return res.status(500).json({ error: 'Subscription verification failed.' });
    // }
    
    //rest of playback logic
    
    const movieId = req.params.id;
    const movieFolder = resolveMovieFolderPath(movieId);
    const infoFilePath = path.join(movieFolder, 'movie_info.json');
    const metaFilePath = path.join(movieFolder, 'metadata.json'); 

    const movieMetadata = readMovieMetadataIfPresent(movieId) || {};
    const attachDetails = (metadataSource = movieMetadata) => {
        streamPayload.details = buildMediaDetailsPayload({
            id: movieId,
            contentType: 'movie',
            title: streamPayload.title,
            year: metadataSource?.year || '',
            genre: metadataSource?.genre || metadataSource?.enrichment?.genre || '',
            cover: versionCoverUrl(metadataSource?.cover || ''),
            href: `/player.html?id=${encodeURIComponent(movieId)}`,
            metadata: metadataSource
        });
    };

    let streamPayload = {
        id: movieId,
        title: movieId.replace(/\./g, ' '), 
        file1080p: null,
        file720p: null,
        file480p: null,
        localFallback1080p: null,
        localFallback720p: null,
        localFallback480p: null
    };

    // Unpack local details if configured inside the storage path
    try {
        const rawData = await fsPromises.readFile(infoFilePath, 'utf8');
        const meta = JSON.parse(rawData);
        streamPayload.title = meta.title || streamPayload.title;
    } catch (e) {
        // Silent block bypass for clean fallback names
    }

    const rankLocalProfiles = (fileName) => {
        const lower = String(fileName || '').toLowerCase();
        if (!lower.endsWith('.mp4') && !lower.endsWith('.mkv') && !lower.endsWith('.m4v')) return 0;
        if (lower.endsWith('.web.mp4')) return 100;
        if (lower.includes('1080p')) return 90;
        if (lower.includes('720p')) return 70;
        if (lower.includes('480p')) return 50;
        return 80;
    };

    const pickBestLocalFiles = (files = []) => {
        const videos = files.filter(f => /\.(mp4|mkv|m4v)$/i.test(f));
        const web1080 = videos.find(f => f.endsWith('.web.mp4')) || null;
        const tagged1080 = videos.find(f => /1080p/i.test(f)) || null;
        const tagged720 = videos.find(f => /720p/i.test(f)) || null;
        const tagged480 = videos.find(f => /480p/i.test(f)) || null;

        const bestGeneral = [...videos].sort((a, b) => rankLocalProfiles(b) - rankLocalProfiles(a))[0] || null;

        return {
            local1080: web1080 || tagged1080 || bestGeneral,
            local720: tagged720 || null,
            local480: tagged480 || null
        };
    };

    // 🚨 CLOUD TRACKING CHECK: Check if the file lives in object storage before running local fs checks
    try {
        if (fs.existsSync(metaFilePath)) {
            const rawMeta = await fsPromises.readFile(metaFilePath, 'utf-8');
            const metaData = JSON.parse(rawMeta);
            
            if (metaData?.storage?.location === 'remote') {
                const files = await fsPromises.readdir(movieFolder).catch(() => []);
                const { local1080, local720, local480 } = pickBestLocalFiles(files);

                streamPayload.title = metaData.title || streamPayload.title;
                streamPayload.localFallback1080p = local1080 ? `/movie-assets/${movieId}/${local1080}` : null;
                streamPayload.localFallback720p = local720 ? `/movie-assets/${movieId}/${local720}` : null;
                streamPayload.localFallback480p = local480 ? `/movie-assets/${movieId}/${local480}` : null;
                streamPayload.file1080p = await MediaService.getPlaybackUrl(
                    metaData,
                    '1080p',
                    null
                );
                streamPayload.file720p = await MediaService.getPlaybackUrl(
                    metaData,
                    '720p',
                    null
                );
                streamPayload.file480p = await MediaService.getPlaybackUrl(
                    metaData,
                    '480p',
                    null
                );

                attachDetails(metaData);

                if (streamPayload.file1080p || streamPayload.file720p || streamPayload.file480p) {
                    return res.json(streamPayload);
                }

                if (streamPayload.localFallback1080p || streamPayload.localFallback720p || streamPayload.localFallback480p) {
                    streamPayload.file1080p = streamPayload.localFallback1080p;
                    streamPayload.file720p = streamPayload.localFallback720p;
                    streamPayload.file480p = streamPayload.localFallback480p;
                    streamPayload.fallbackReason = 'remote_unavailable';
                    attachDetails(metaData);
                    return res.json(streamPayload);
                }

                return res.status(503).json({ success: false, error: 'No remote or local playable profile is currently available.' });
            }
        }
    } catch (err) {
        // Fail over quietly to evaluate standard disk lookups
    }

    // Standard Local File Checking Core
    try {
        await fsPromises.access(movieFolder);
    } catch {
        return res.status(404).json({ status: 'error', message: 'Movie cluster destination missing.' });
    }

    const expectedOutputs = {
        '1080p': `${movieId}.web.mp4`,      
        '720p': `${movieId}.720p.mp4`,      
        '480p': `${movieId}.480p.mp4`       
    };

    const allFiles = await fsPromises.readdir(movieFolder).catch(() => []);
    const pickedLocal = pickBestLocalFiles(allFiles);

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['1080p']));
        streamPayload.file1080p = `/movie-assets/${movieId}/${expectedOutputs['1080p']}`;
    } catch {
        try {
            const files = await fsPromises.readdir(movieFolder);
            const sourceMp4 = files.find(f => f.endsWith('.mp4') && !f.includes('720p') && !f.includes('480p'));
            if (sourceMp4) streamPayload.file1080p = `/movie-assets/${movieId}/${sourceMp4}`;
        } catch {}
    }

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['720p']));
        streamPayload.file720p = `/movie-assets/${movieId}/${expectedOutputs['720p']}`;
    } catch {
        if (pickedLocal.local720) {
            streamPayload.file720p = `/movie-assets/${movieId}/${pickedLocal.local720}`;
        }
    }

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['480p']));
        streamPayload.file480p = `/movie-assets/${movieId}/${expectedOutputs['480p']}`;
    } catch {
        if (pickedLocal.local480) {
            streamPayload.file480p = `/movie-assets/${movieId}/${pickedLocal.local480}`;
        }
    }

    if (!streamPayload.file1080p) {
        if (pickedLocal.local1080) {
            streamPayload.file1080p = `/movie-assets/${movieId}/${pickedLocal.local1080}`;
        } else {
            streamPayload.file1080p = `/movie-assets/${movieId}`;
        }
    }

    attachDetails(movieMetadata);

    res.json(streamPayload);
});

router.get('/media/details', async (req, res) => {
    try {
        const rawId = String(req.query.id || '').trim();
        const rawType = String(req.query.type || '').trim().toLowerCase();
        if (!rawId) {
            return res.status(400).json({ success: false, error: 'Missing media id.' });
        }

        const normalizedId = normalizeMediaIdInput(rawId);
        const inferredType = rawType === 'series' || normalizedId.startsWith('series/') ? 'series' : 'movie';

        if (inferredType === 'series') {
            const lookupFolder = normalizeShowFolderInput(normalizedId);
            const resolved = await resolveSeriesShowFolder(lookupFolder);
            if (!resolved) {
                return res.status(404).json({ success: false, error: 'Series not found.' });
            }

            const showFolder = resolved.folder;
            const showPath = resolved.path;
            const { metadata } = readMediaMetadataForMovieFolder(showPath);

            const library = await getLibrary();
            const showRows = Array.isArray(library?.shows) ? library.shows : [];
            const showRow = showRows.find((item) => String(item?.id || '') === `series/${showFolder}`) || {};

            const details = buildMediaDetailsPayload({
                id: `series/${showFolder}`,
                contentType: 'series',
                title: metadata?.title || showRow?.title || showFolder,
                year: metadata?.year || showRow?.year || '',
                genre: metadata?.genre || metadata?.enrichment?.genre || showRow?.genre || '',
                cover: versionCoverUrl(showRow?.cover || `/movie-assets/series/${encodeURIComponent(showFolder)}/cover.jpg`),
                href: `/series.html?id=${encodeURIComponent(`series/${showFolder}`)}`,
                metadata
            });

            return res.json({ success: true, details });
        }

        const movieId = normalizedId.replace(/^series\//i, '');
        const movieFolder = resolveMovieFolderPath(movieId);
        if (!movieFolder || !fs.existsSync(movieFolder)) {
            return res.status(404).json({ success: false, error: 'Movie not found.' });
        }

        const metadata = readMovieMetadataIfPresent(movieId) || {};
        const library = await getLibrary();
        const movieRows = Array.isArray(library?.movies) ? library.movies : [];
        const movieRow = movieRows.find((item) => String(item?.id || '') === movieId) || {};

        const details = buildMediaDetailsPayload({
            id: movieId,
            contentType: 'movie',
            title: metadata?.title || movieRow?.title || movieId.replace(/\./g, ' '),
            year: metadata?.year || movieRow?.year || '',
            genre: metadata?.genre || metadata?.enrichment?.genre || movieRow?.genre || '',
            cover: versionCoverUrl(movieRow?.cover || ''),
            href: `/player.html?id=${encodeURIComponent(movieId)}`,
            metadata
        });

        return res.json({ success: true, details });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/series/:showFolder (Unified Series Hierarchy Aggregator)
router.get('/series/:showFolder', async (req, res) => {
    try {
        const resolved = await resolveSeriesShowFolder(req.params.showFolder);
        if (!resolved) {
            return res.status(404).json({ error: "Serialized map targets are currently missing for this show cluster destination." });
        }

        const showFolder = resolved.folder;
        const showPath = resolved.path;

        const metaFile = path.join(showPath, 'metadata.json');
        const seriesFile = path.join(showPath, 'series.json');

        try {
            await fsPromises.access(metaFile);
        } catch {
            return res.status(404).json({ error: "Serialized map targets are currently missing for this show cluster destination." });
        }

        const rawMeta = await fsPromises.readFile(metaFile, 'utf-8');
        const metaData = JSON.parse(rawMeta);
        let seriesData = null;

        try {
            seriesData = rebuildSeriesManifest(showPath, {
                showFolderName: showFolder,
                write: true
            });
        } catch (_err) {
            const rawSeries = await fsPromises.readFile(seriesFile, 'utf-8');
            seriesData = JSON.parse(rawSeries);
        }

        res.json({
            id: `series/${showFolder}`,
            title: metaData.title,
            year: metaData.year,
            plot: metaData.plot,
            genre: metaData.genre,
            imdbId: formatImdbId(metaData.imdbId || metaData.imdb_id || metaData.imdbID || metaData.metadata?.imdbId || metaData.metadata?.imdb_id || metaData.metadata?.imdbID || '') || '',
            imdb_id: formatImdbId(metaData.imdbId || metaData.imdb_id || metaData.imdbID || metaData.metadata?.imdbId || metaData.metadata?.imdb_id || metaData.metadata?.imdbID || '') || '',
            poster: versionCoverUrl(`/movie-assets/series/${encodeURIComponent(showFolder)}/cover.jpg`),
            seasons: seriesData.seasons,
            totalSeasons: seriesData.totalSeasons,
            canonicalFolder: showFolder,
            details: buildMediaDetailsPayload({
                id: `series/${showFolder}`,
                contentType: 'series',
                title: metaData.title,
                year: metaData.year,
                genre: metaData.genre,
                cover: versionCoverUrl(`/movie-assets/series/${encodeURIComponent(showFolder)}/cover.jpg`),
                href: `/series.html?id=${encodeURIComponent(`series/${showFolder}`)}`,
                metadata: metaData
            })
        });
    } catch (err) {
        console.error("❌ Unified Series router failure:", err);
        res.status(500).json({ error: "Failed assembling compiled local series data arrays." });
    }
});

router.get('/series/:showFolder/episode-manager', async (req, res) => {
    try {
        const allowed = await isPrivilegedMediaAdmin(req);
        if (!allowed) {
            return res.status(403).json({ success: false, error: 'Admin privileges are required for Episode Manager.' });
        }

        const resolved = await resolveSeriesShowFolder(req.params.showFolder);
        if (!resolved) {
            return res.status(404).json({ success: false, error: 'Show folder not found.' });
        }

        const showFolder = resolved.folder;
        const showPath = resolved.path;
        const seriesData = rebuildSeriesManifest(showPath, {
            showFolderName: showFolder,
            write: true
        });

        const payload = buildEpisodeManagerItems(showFolder, showPath, seriesData);
        return res.json({ success: true, ...payload });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/series/:showFolder/episode-manager', async (req, res) => {
    try {
        const allowed = await isPrivilegedMediaAdmin(req);
        if (!allowed) {
            return res.status(403).json({ success: false, error: 'Admin privileges are required for Episode Manager.' });
        }

        const resolved = await resolveSeriesShowFolder(req.params.showFolder);
        if (!resolved) {
            return res.status(404).json({ success: false, error: 'Show folder not found.' });
        }

        const updatesRaw = Array.isArray(req.body?.updates) ? req.body.updates : [];
        if (!updatesRaw.length) {
            return res.status(400).json({ success: false, error: 'No episode updates supplied.' });
        }

        const showFolder = resolved.folder;
        const showPath = resolved.path;
        const normalizedUpdates = updatesRaw
            .map(normalizeEpisodeManagerUpdate)
            .filter((entry) => Number.isFinite(entry.seasonNumber) && Number.isFinite(entry.episodeNumber));

        if (!normalizedUpdates.length) {
            return res.status(400).json({ success: false, error: 'No valid episode updates supplied.' });
        }

        const seriesData = rebuildSeriesManifest(showPath, {
            showFolderName: showFolder,
            write: false
        });

        let changed = 0;
        for (const update of normalizedUpdates) {
            const seasonKey = String(update.seasonNumber);
            const episodes = Array.isArray(seriesData.seasons?.[seasonKey]?.episodes)
                ? seriesData.seasons[seasonKey].episodes
                : [];

            let target = episodes.find((ep) => Number(ep.episodeNumber) === update.episodeNumber);
            if (!target) {
                target = {
                    episodeNumber: update.episodeNumber,
                    title: `Episode ${update.episodeNumber}`,
                    released: 'Unknown',
                    plot: '',
                    imdbRating: 'N/A',
                    available: false,
                    localRelativePath: null,
                    remoteRelativePath: null
                };
                episodes.push(target);
                if (!seriesData.seasons[seasonKey]) {
                    seriesData.seasons[seasonKey] = {
                        seasonNumber: seasonKey,
                        episodes
                    };
                }
            }

            if (update.title) target.title = update.title;
            if (update.released) target.released = update.released;
            if (update.plot) target.plot = update.plot;
            if (update.imdbRating) target.imdbRating = update.imdbRating;

            if (update.localRelativePath) {
                const localPath = resolveRelativePathInSeriesRoots(update.localRelativePath);
                if (localPath && fs.existsSync(localPath)) {
                    target.localRelativePath = update.localRelativePath;
                    target.available = true;
                }
            }

            if (update.subtitleRelativePath) {
                const subtitlePath = resolveRelativePathInSeriesRoots(update.subtitleRelativePath);
                if (subtitlePath && fs.existsSync(subtitlePath)) {
                    target.subtitleRelativePath = update.subtitleRelativePath;
                }
            }

            changed += 1;
        }

        Object.keys(seriesData.seasons || {}).forEach((seasonKey) => {
            const eps = Array.isArray(seriesData.seasons[seasonKey]?.episodes)
                ? seriesData.seasons[seasonKey].episodes
                : [];
            eps.sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber));
            seriesData.seasons[seasonKey].episodes = eps;
        });

        const seasonNumbers = Object.keys(seriesData.seasons || {})
            .map((k) => Number(k))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        seriesData.totalSeasons = String(seasonNumbers[seasonNumbers.length - 1] || 0);

        await fsPromises.writeFile(path.join(showPath, 'series.json'), JSON.stringify(seriesData, null, 4), 'utf-8');

        const payload = buildEpisodeManagerItems(showFolder, showPath, seriesData);
        return res.json({ success: true, changed, ...payload });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/series/:showFolder/episode-manager/probe', async (req, res) => {
    try {
        const allowed = await isPrivilegedMediaAdmin(req);
        if (!allowed) {
            return res.status(403).json({ success: false, error: 'Admin privileges are required for Episode Manager.' });
        }

        const seasonNumber = parseInt(req.query.season, 10);
        const episodeNumber = parseInt(req.query.episode, 10);
        if (!Number.isFinite(seasonNumber) || seasonNumber <= 0 || !Number.isFinite(episodeNumber) || episodeNumber <= 0) {
            return res.status(400).json({ success: false, error: 'season and episode query params are required.' });
        }

        const resolved = await resolveSeriesShowFolder(req.params.showFolder);
        if (!resolved) {
            return res.status(404).json({ success: false, error: 'Show folder not found.' });
        }

        const seriesData = rebuildSeriesManifest(resolved.path, {
            showFolderName: resolved.folder,
            write: false
        });

        const entry = resolveEpisodeEntry(seriesData, seasonNumber, episodeNumber);
        const localRelativePath = sanitizeSeriesRelativePath(entry?.localRelativePath || '');
        const videoPath = localRelativePath ? resolveRelativePathInSeriesRoots(localRelativePath) : '';
        if (!videoPath || !fs.existsSync(videoPath)) {
            return res.status(404).json({ success: false, error: 'Episode video file not found for selected season/episode.' });
        }

        const probe = probeVideoDiagnostics(videoPath);
        return res.json({
            success: true,
            showFolder: resolved.folder,
            seasonNumber,
            episodeNumber,
            localRelativePath,
            probe,
            videoCodec: probe.videoCodec || null,
            videoResolution: probe.videoResolution || null
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/series/:showFolder/episode-manager/audio-fix', async (req, res) => {
    try {
        const allowed = await isPrivilegedMediaAdmin(req);
        if (!allowed) {
            return res.status(403).json({ success: false, error: 'Admin privileges are required for Episode Manager.' });
        }

        const seasonNumber = parseInt(req.body?.seasonNumber, 10);
        const episodeNumber = parseInt(req.body?.episodeNumber, 10);
        if (!Number.isFinite(seasonNumber) || seasonNumber <= 0 || !Number.isFinite(episodeNumber) || episodeNumber <= 0) {
            return res.status(400).json({ success: false, error: 'seasonNumber and episodeNumber are required.' });
        }

        const resolved = await resolveSeriesShowFolder(req.params.showFolder);
        if (!resolved) {
            return res.status(404).json({ success: false, error: 'Show folder not found.' });
        }

        const seriesData = rebuildSeriesManifest(resolved.path, {
            showFolderName: resolved.folder,
            write: false
        });

        const entry = resolveEpisodeEntry(seriesData, seasonNumber, episodeNumber);
        if (!entry) {
            return res.status(404).json({ success: false, error: 'Episode entry not found in series manifest.' });
        }

        const localRelativePath = sanitizeSeriesRelativePath(entry.localRelativePath || '');
        const sourceVideoPath = localRelativePath ? resolveRelativePathInSeriesRoots(localRelativePath) : '';
        if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) {
            return res.status(404).json({ success: false, error: 'Episode source video was not found on disk.' });
        }

        const beforeProbe = probeVideoDiagnostics(sourceVideoPath);
        const transcodeResult = runEpisodeAudioDownmixTranscode(sourceVideoPath);
        const updatedRelativePath = absoluteToSeriesRelativePath(transcodeResult.outputPath);
        if (!updatedRelativePath) {
            return res.status(500).json({ success: false, error: 'Unable to compute updated relative path for transcoded episode.' });
        }

        entry.localRelativePath = sanitizeSeriesRelativePath(updatedRelativePath);
        entry.available = true;
        if (transcodeResult?.subtitleExtraction?.defaultRelativePath) {
            entry.subtitleRelativePath = sanitizeSeriesRelativePath(transcodeResult.subtitleExtraction.defaultRelativePath);
        }

        await fsPromises.writeFile(path.join(resolved.path, 'series.json'), JSON.stringify(seriesData, null, 4), 'utf-8');

        const refreshedManifest = rebuildSeriesManifest(resolved.path, {
            showFolderName: resolved.folder,
            write: false
        });
        const refreshedEntry = resolveEpisodeEntry(refreshedManifest, seasonNumber, episodeNumber);
        const refreshedAbs = refreshedEntry?.localRelativePath ? resolveRelativePathInSeriesRoots(refreshedEntry.localRelativePath) : '';
        const afterProbe = refreshedAbs && fs.existsSync(refreshedAbs) ? probeVideoDiagnostics(refreshedAbs) : null;

        return res.json({
            success: true,
            showFolder: resolved.folder,
            seasonNumber,
            episodeNumber,
            sourceRelativePath: localRelativePath,
            outputRelativePath: entry.localRelativePath,
            subtitleExtraction: transcodeResult.subtitleExtraction,
            beforeProbe,
            afterProbe,
            message: 'Audio downmix transcode complete. Episode now points to browser-safe web profile.'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/series/:showFolder/episode-manager/transcode-profile', async (req, res) => {
    try {
        const allowed = await isPrivilegedMediaAdmin(req);
        if (!allowed) {
            return res.status(403).json({ success: false, error: 'Admin privileges are required for Episode Manager.' });
        }

        const seasonNumber = parseInt(req.body?.seasonNumber, 10);
        const episodeNumber = parseInt(req.body?.episodeNumber, 10);
        const profile = String(req.body?.profile || '').trim().toLowerCase();
        const forceReprocess = req.body?.forceReprocess === true || String(req.body?.forceReprocess || '').toLowerCase() === 'true';

        if (!Number.isFinite(seasonNumber) || seasonNumber <= 0 || !Number.isFinite(episodeNumber) || episodeNumber <= 0) {
            return res.status(400).json({ success: false, error: 'seasonNumber and episodeNumber are required.' });
        }
        if (!['1080p', '720p'].includes(profile)) {
            return res.status(400).json({ success: false, error: 'profile must be 1080p or 720p.' });
        }

        const resolved = await resolveSeriesShowFolder(req.params.showFolder);
        if (!resolved) {
            return res.status(404).json({ success: false, error: 'Show folder not found.' });
        }

        const seriesData = rebuildSeriesManifest(resolved.path, {
            showFolderName: resolved.folder,
            write: false
        });

        const entry = resolveEpisodeEntry(seriesData, seasonNumber, episodeNumber);
        if (!entry) {
            return res.status(404).json({ success: false, error: 'Episode entry not found in series manifest.' });
        }

        const localRelativePath = sanitizeSeriesRelativePath(entry.localRelativePath || '');
        const sourceVideoPath = localRelativePath ? resolveRelativePathInSeriesRoots(localRelativePath) : '';
        if (!sourceVideoPath || !fs.existsSync(sourceVideoPath)) {
            return res.status(404).json({ success: false, error: 'Episode source video was not found on disk.' });
        }

        const beforeProbe = probeVideoDiagnostics(sourceVideoPath);
    const transcodeResult = runEpisodeProfileTranscode(sourceVideoPath, profile, { forceReprocess });

        if (profile === '1080p') {
            const updatedRelativePath = absoluteToSeriesRelativePath(transcodeResult.outputPath);
            if (!updatedRelativePath) {
                return res.status(500).json({ success: false, error: 'Unable to compute updated relative path for 1080p output.' });
            }
            entry.localRelativePath = sanitizeSeriesRelativePath(updatedRelativePath);
            entry.available = true;
            await fsPromises.writeFile(path.join(resolved.path, 'series.json'), JSON.stringify(seriesData, null, 4), 'utf-8');
        }

        const refreshedManifest = rebuildSeriesManifest(resolved.path, {
            showFolderName: resolved.folder,
            write: false
        });
        const refreshedEntry = resolveEpisodeEntry(refreshedManifest, seasonNumber, episodeNumber);
        const refreshedAbs = refreshedEntry?.localRelativePath ? resolveRelativePathInSeriesRoots(refreshedEntry.localRelativePath) : '';
        const afterProbe = refreshedAbs && fs.existsSync(refreshedAbs) ? probeVideoDiagnostics(refreshedAbs) : null;

        return res.json({
            success: true,
            showFolder: resolved.folder,
            seasonNumber,
            episodeNumber,
            profile,
            sourceRelativePath: localRelativePath,
            outputRelativePath: absoluteToSeriesRelativePath(transcodeResult.outputPath),
            beforeProbe,
            afterProbe,
            transcode: transcodeResult,
            message: profile === '1080p'
                ? '1080p web profile built from 4K/UHD source and set as default episode path.'
                : '720p profile build completed.'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/series/episodes/search?q=air force wong&showFolder=Rick.and.Morty
router.get('/series/episodes/search', async (req, res) => {
    try {
        const query = String(req.query.q || '').trim();
        const showFolderFilter = String(req.query.showFolder || '').trim();
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));

        if (!query) {
            return res.status(400).json({ success: false, error: 'Missing search query.' });
        }

        const normalizedQuery = normalizeEpisodeSearchToken(query);
        const showFolders = [];

        if (showFolderFilter) {
            const showPath = resolveSeriesFolderPath(showFolderFilter, { mustExist: true });
            if (!fs.existsSync(showPath) || !fs.lstatSync(showPath).isDirectory()) {
                return res.status(404).json({ success: false, error: 'Show folder not found.' });
            }
            showFolders.push(showFolderFilter);
        } else {
            listSeriesFolders().forEach(entry => showFolders.push(entry.name));
        }

        const results = [];
        for (const showFolder of showFolders) {
            const showPath = resolveSeriesFolderPath(showFolder, { mustExist: true });
            let seriesData;

            try {
                seriesData = rebuildSeriesManifest(showPath, {
                    showFolderName: showFolder,
                    write: false
                });
            } catch (_err) {
                continue;
            }

            const showTitle = readShowMetadataTitle(showPath, showFolder.replace(/[._-]/g, ' '));
            const seasons = seriesData.seasons || {};

            Object.keys(seasons).forEach(seasonKey => {
                const episodes = Array.isArray(seasons[seasonKey]?.episodes) ? seasons[seasonKey].episodes : [];
                episodes.forEach(ep => {
                    const episodeTitle = ep.title || '';
                    const localRelativePath = ep.localRelativePath || '';
                    const fileName = localRelativePath ? path.basename(localRelativePath) : '';

                    const haystack = normalizeEpisodeSearchToken([
                        episodeTitle,
                        fileName,
                        `season ${seasonKey}`,
                        `episode ${ep.episodeNumber}`
                    ].filter(Boolean).join(' '));

                    if (!haystack.includes(normalizedQuery)) return;

                    results.push({
                        showFolder,
                        showTitle,
                        seasonNumber: Number(seasonKey),
                        episodeNumber: Number(ep.episodeNumber),
                        episodeTitle: episodeTitle || `Episode ${ep.episodeNumber}`,
                        available: Boolean(ep.available),
                        localRelativePath: localRelativePath || null
                    });
                });
            });

            if (results.length >= limit) break;
        }

        results.sort((a, b) => {
            if (a.showTitle !== b.showTitle) return a.showTitle.localeCompare(b.showTitle);
            if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
            return a.episodeNumber - b.episodeNumber;
        });

        return res.json({
            success: true,
            query,
            count: Math.min(results.length, limit),
            items: results.slice(0, limit)
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/raw-file/:id (Lightweight Video Ranger Seek Pipeline)
router.get('/raw-file/:id', async (req, res) => {
    try {
        const movieId = decodeURIComponent(req.params.id);
        const folderPath = resolveMovieFolderPath(movieId);

        try {
            await fsPromises.access(folderPath);
        } catch {
            return res.status(404).send('Movie asset folder directory not found.');
        }

        const files = await fsPromises.readdir(folderPath);
        let videoFile = files.find(f => f.endsWith('.web.mp4')) || files.find(f => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.m4v'));

        if (!videoFile) {
            return res.status(404).send('No playable video format container found.');
        }

        const fullVideoPath = path.join(folderPath, videoFile);
        const stat = await fsPromises.stat(fullVideoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4'
        };

        if (req.method === 'OPTIONS') {
            return res.writeHead(204, headers).end();
        }

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                ...headers,
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunksize,
            });
            fs.createReadStream(fullVideoPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { ...headers, 'Content-Length': fileSize });
            fs.createReadStream(fullVideoPath).pipe(res);
        }
    } catch (err) {
        console.error("💣 Direct stream controller fault:", err);
        if (!res.headersSent) res.status(500).send('Internal static streaming pipeline error.');
    }
});

router.get('/audio-tracks/:id', async (req, res) => {
    try {
        const mediaId = normalizeMediaIdInput(req.params.id);
        const allowLocalFallback = ['1', 'true', 'yes'].includes(String(req.query.allowLocalFallback || '').toLowerCase());
        if (isRemoteAllocatedMovie(mediaId) && !allowLocalFallback) {
            return res.status(409).json({
                success: false,
                error: 'This title is cloud-allocated. Audio track introspection is only available for local playback sources.'
            });
        }

        const season = parseInt(req.query.season, 10);
        const episode = parseInt(req.query.episode, 10);
        const requestedFile = String(req.query.file || '');

        const videoPath = resolveVideoPathForMediaRequest(mediaId, season, episode, requestedFile);
        if (!videoPath || !fs.existsSync(videoPath)) {
            return res.status(404).json({ success: false, error: 'No playable video target found for audio track inspection.' });
        }

        const tracks = listAudioTracksForVideo(videoPath);
        const defaultTrack = tracks.find(t => t.isDefault) || tracks[0] || null;

        return res.json({
            success: true,
            count: tracks.length,
            selectedDefault: defaultTrack?.streamIndex ?? null,
            videoFile: path.basename(videoPath),
            tracks
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/playback/:id', async (req, res) => {
    
    
    //code to check user subscription status is commented out for now as its breaking playback will fix soon.
    // const userKey = getActiveUser(req);

    // if (!userKey) {
    //     return res.status(401).send('Authentication required.');
    // }

    // try {
    //     const sub = await ProfileService.getSubscriptionStatus(userKey);
    //     if (!sub.active) {
    //         // Note: Since this endpoint is often consumed directly by an HTML5 <video> src attribute,
    //         // returning a 403 status code cleanly tells the player engine to stop fetching chunks.
    //         return res.status(403).json({ 
    //             error: 'Subscription Required', 
    //             reason: sub.reason,
    //             redirectTo: '/subscribe.html?reason=trial_expired'
    //         });
    //     }
    // } catch (err) {
    //     return res.status(500).send('Subscription verification failed.');
    // }
    
    try {
        const mediaId = normalizeMediaIdInput(req.params.id);
        const allowLocalFallback = ['1', 'true', 'yes'].includes(String(req.query.allowLocalFallback || '').toLowerCase());
        if (isRemoteAllocatedMovie(mediaId) && !allowLocalFallback) {
            return res.status(409).json({
                success: false,
                error: 'This title is cloud-allocated. Use the remote playback URL from /api/movies/:id.'
            });
        }

        const season = parseInt(req.query.season, 10);
        const episode = parseInt(req.query.episode, 10);
        const requestedFile = String(req.query.file || '');
        const requestedAudioTrack = parseInt(req.query.audioTrack, 10);

        // Episode equivalent of the movie cloud-allocation check above - unlike
        // movies (a separate JSON endpoint + frontend fetch), this redirects
        // straight to the signed URL so the <video> src never has to change.
        if (mediaId.startsWith('series/') && Number.isFinite(season) && Number.isFinite(episode) && !allowLocalFallback) {
            const showFolder = mediaId.replace(/^series\//, '');
            if (isRemoteAllocatedEpisode(showFolder, season, episode)) {
                const signedUrl = await resolveEpisodeCloudPlaybackUrl(showFolder, season, episode);
                if (signedUrl) {
                    return res.redirect(302, signedUrl);
                }
                // Signed URL generation failed (credentials issue, B2 outage, etc.) -
                // fall through to local serving below rather than hard-erroring.
            }
        }

        const videoPath = resolveVideoPathForMediaRequest(mediaId, season, episode, requestedFile);
        if (!videoPath || !fs.existsSync(videoPath)) {
            return res.status(404).send('No playable video target found.');
        }

        if (!Number.isFinite(requestedAudioTrack)) {
            return streamLocalVideoFile(req, res, videoPath);
        }

        const audioTracks = listAudioTracksForVideo(videoPath);
        const selectedAudio = audioTracks.find(track => track.streamIndex === requestedAudioTrack);
        if (!selectedAudio) {
            return res.status(400).json({ success: false, error: 'Requested audio track was not found in this video file.' });
        }

        try {
            const cachedPlaybackPath = await ensureAudioSelectedPlaybackFile(videoPath, selectedAudio.streamIndex);
            res.setHeader('X-Audio-Track-Selected', String(selectedAudio.streamIndex));
            return streamLocalVideoFile(req, res, cachedPlaybackPath);
        } catch (cacheErr) {
            // Deliberately not falling back to the original file: that silently serves the
            // wrong audio and makes a broken track switch look like a no-op to the user.
            console.error('💣 Audio-selected cache creation failed:', cacheErr.message);
            if (res.headersSent) return res.end();
            return res.status(503).json({
                success: false,
                error: 'Could not prepare the selected audio track for playback.',
                detail: cacheErr.message,
                audioTrack: selectedAudio.streamIndex
            });
        }
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/remote-playback?src=<signed-url>
// Relays remote object storage streams through same-origin to bypass browser CORS restrictions.
router.get('/remote-playback', async (req, res) => {
    try {
        const src = String(req.query.src || '').trim();
        if (!src) {
            return res.status(400).json({ success: false, error: 'Missing remote source URL.' });
        }

        if (!isAllowedRemoteStreamUrl(src)) {
            return res.status(400).json({ success: false, error: 'Remote source URL is not allowed.' });
        }

        const upstreamHeaders = {};
        if (req.headers.range) {
            upstreamHeaders.Range = req.headers.range;
        }

        const upstream = await axios.get(src, {
            responseType: 'stream',
            headers: upstreamHeaders,
            timeout: 30000,
            validateStatus: () => true
        });

        const status = upstream.status;
        if (status >= 400) {
            return res.status(status).json({
                success: false,
                error: `Upstream media returned status ${status}`
            });
        }

        const contentType = upstream.headers['content-type'] || 'video/mp4';
        const contentLength = upstream.headers['content-length'];
        const contentRange = upstream.headers['content-range'];
        const acceptRanges = upstream.headers['accept-ranges'] || 'bytes';

        res.status(status);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Accept-Ranges', acceptRanges);
        if (contentLength) res.setHeader('Content-Length', contentLength);
        if (contentRange) res.setHeader('Content-Range', contentRange);
        res.setHeader('Cache-Control', 'private, max-age=60');

        upstream.data.on('error', () => {
            if (!res.headersSent) {
                res.status(502).end('Remote stream relay failed.');
            } else {
                res.end();
            }
        });

        upstream.data.pipe(res);
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message || 'Remote playback relay failed.' });
    }
});

// GET: /api/subtitles/:id (Dynamic SRT-to-WebVTT Structural Sanitizer Engine)
router.get('/subtitles/:id/tracks', async (req, res) => {
    try {
        const mediaId = normalizeMediaIdInput(req.params.id);
        const season = parseInt(req.query.season, 10);
        const episode = parseInt(req.query.episode, 10);
        const requestedFile = String(req.query.file || '');
        const subtitleContext = resolveSubtitleContextForRequest(mediaId, season, episode, requestedFile);

        if (!subtitleContext) {
            return res.status(404).json({ success: false, error: 'No playable video target found for subtitle inspection.' });
        }

        const { metadata } = subtitleContext;

        const candidates = subtitleContext.mode === 'video'
            ? listSubtitleCandidatesForVideo(subtitleContext.videoPath, { includeEmbedded: true })
            : listSubtitleCandidatesForDirectory(subtitleContext.folderPath, { baseHint: subtitleContext.baseHint });
        const selectedDefault = String(metadata.subtitleSelection?.defaultRelativePath || metadata.subtitleDefault || '').trim();
        return res.json({
            success: true,
            count: candidates.length,
            tracks: candidates.map((item, idx) => ({
                id: idx,
                streamIndex: item.streamIndex,
                lang: item.langHint,
                file: item.file,
                relativePath: item.relativePath,
                isDefault: selectedDefault ? String(item.relativePath || item.file || '').trim() === selectedDefault : false,
                label: `${item.langHint.toUpperCase()}${item.streamIndex !== null ? ` (stream ${item.streamIndex})` : ''} - ${item.file}`
            }))
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/subtitles/:id', async (req, res) => {
    try {
        const mediaId = normalizeMediaIdInput(req.params.id);
        const season = parseInt(req.query.season, 10);
        const episode = parseInt(req.query.episode, 10);
        const requestedFile = String(req.query.file || '');

        const subtitleContext = resolveSubtitleContextForRequest(mediaId, season, episode, requestedFile);
        if (!subtitleContext) {
            return res.status(404).send('No video target found for subtitles.');
        }

        const { metadata } = subtitleContext;

        const candidates = subtitleContext.mode === 'video'
            ? listSubtitleCandidatesForVideo(subtitleContext.videoPath, { includeEmbedded: true })
            : listSubtitleCandidatesForDirectory(subtitleContext.folderPath, { baseHint: subtitleContext.baseHint });
        const selected = pickSubtitleCandidate(candidates, {
            ...req.query,
            preferredRelativePath: metadata.subtitleSelection?.defaultRelativePath || metadata.subtitleDefault || ''
        });
        const subtitlePath = selected?.filePath || null;

        if (!subtitlePath || !fs.existsSync(subtitlePath)) {
            return res.status(404).send('No subtitles found.');
        }

        const subtitleContent = await fsPromises.readFile(subtitlePath, 'utf-8');
        const vttContent = subtitleToWebVtt(subtitleContent, path.extname(subtitlePath));

        res.setHeader('Content-Type', 'text/vtt');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (selected?.file) res.setHeader('X-Subtitle-File', selected.file);
        if (selected?.langHint) res.setHeader('X-Subtitle-Lang', selected.langHint);
        res.status(200).send(vttContent);
    } catch (err) {
        console.error("💣 Subtitle engine failure:", err);
        res.status(500).send('Error processing subtitle asset.');
    }
});

module.exports = router;

// Exposed for integration tests around audio-track selection.
module.exports.__audioTrackInternals = {
    listAudioTracksForVideo,
    planAudioSelectedPlayback,
    ensureAudioSelectedPlaybackFile,
    getAudioTrackCacheDir,
    pruneAudioTrackCache
};