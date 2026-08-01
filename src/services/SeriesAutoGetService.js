const fs = require('fs');
const path = require('path');
const axios = require('axios');

const logger = require('./logger');
const ProfileService = require('./ProfileService');
const NotificationService = require('./NotificationService');
const TorrentService = require('./TorrentService');
const { getLibrary } = require('./db');
const { rebuildSeriesManifest } = require('./SeriesIndexService');
const { getSeriesByImdbId, loadIndex } = require('./TvSeriesIndexService');
const { resolveSeriesFolderPath } = require('./StoragePathResolver');
const { createJob, getAllJobs } = require('./PipelineQueueService');

const DATA_ROOT = path.join(__dirname, '../../movie-streamer-data');
const RULES_FILE = path.join(DATA_ROOT, 'tv-auto-get-rules.json');
const DEFAULT_CHECK_CYCLE_MINUTES = Math.max(5, Number(process.env.TV_AUTO_GET_DEFAULT_CHECK_CYCLE_MINUTES || 120));
const WORKER_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.TV_AUTO_GET_WORKER_INTERVAL_MS || 30 * 60 * 1000));
const WORKER_ENABLED = !['false', '0', 'no'].includes(String(process.env.ENABLE_TV_AUTO_GET_WORKER || 'true').trim().toLowerCase());

let workerTimer = null;
let workerRunning = false;

function ensureDataDir() {
    fs.mkdirSync(path.dirname(RULES_FILE), { recursive: true });
}

function normalizeImdbId(value = '') {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^[0-9]{5,10}$/.test(cleaned)) return '';
    return `tt${cleaned}`;
}

function normalizeFolderName(value = '') {
    const raw = String(value || '').trim().replace(/^series\//i, '');
    const clean = path.basename(raw);
    if (!clean || clean.includes('..')) return '';
    return clean;
}

function normalizeDayToken(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const map = {
        sunday: 'sun', sun: 'sun',
        monday: 'mon', mon: 'mon',
        tuesday: 'tue', tue: 'tue', tues: 'tue',
        wednesday: 'wed', wed: 'wed',
        thursday: 'thu', thu: 'thu', thurs: 'thu',
        friday: 'fri', fri: 'fri',
        saturday: 'sat', sat: 'sat'
    };
    return map[raw] || '';
}

function parseWords(value = '') {
    return String(value || '')
        .split(/[\n,]+/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
}

function inferQualityLabel(title = '') {
    const name = String(title || '').toLowerCase();
    if (/\b(2160p|4k|uhd)\b/.test(name)) return '2160p';
    if (/\b1080p\b/.test(name)) return '1080p';
    if (/\b720p\b/.test(name)) return '720p';
    if (/\b480p\b/.test(name)) return '480p';
    return 'unknown';
}

function parseSeasonEpisodeFromTitle(title = '') {
    const raw = String(title || '');
    const sxeMatches = Array.from(raw.matchAll(/s(\d{1,2})\s*e(\d{1,3})/gi));
    const sxe = sxeMatches.length ? sxeMatches[sxeMatches.length - 1] : null;
    if (sxe) {
        return {
            season: parseInt(sxe[1], 10),
            episode: parseInt(sxe[2], 10)
        };
    }

    const seasonOnly = raw.match(/season\s*(\d{1,2})/i) || raw.match(/s(\d{1,2})(?!\d)/i);
    if (seasonOnly) {
        return {
            season: parseInt(seasonOnly[1], 10),
            episode: null
        };
    }

    return { season: null, episode: null };
}

function readJsonSafe(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_err) {
        return fallback;
    }
}

function normalizeRule(input = {}) {
    const imdbId = normalizeImdbId(input.imdbId || '');
    const qualityAllow = Array.isArray(input.qualityAllow)
        ? input.qualityAllow.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
        : parseWords(input.qualityAllow || '1080p,720p');

    return {
        imdbId,
        showFolder: normalizeFolderName(input.showFolder || input.folderName || input.folder || ''),
        title: String(input.title || '').trim(),
        enabled: input.enabled !== false,
        sourceType: String(input.sourceType || 'episode').trim().toLowerCase() === 'pack' ? 'pack' : 'episode',
        qualityAllow: qualityAllow.length ? Array.from(new Set(qualityAllow)) : ['1080p', '720p'],
        excludeQuality: parseWords(input.excludeQuality || ''),
        mustContain: parseWords(input.mustContain || ''),
        excludeWords: parseWords(input.excludeWords || ''),
        minSeeds: Math.max(0, parseInt(input.minSeeds, 10) || 0),
        minSizeMb: Math.max(0, parseFloat(input.minSizeMb) || 0),
        maxSizeMb: Math.max(0, parseFloat(input.maxSizeMb) || 0),
        seasonStart: Math.max(1, parseInt(input.seasonStart, 10) || 1),
        episodeStart: Math.max(1, parseInt(input.episodeStart, 10) || 1),
        airDay: normalizeDayToken(input.airDay || ''),
        checkCycleMinutes: Math.max(5, parseInt(input.checkCycleMinutes, 10) || DEFAULT_CHECK_CYCLE_MINUTES),
        createdAt: input.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: {
            lastRunAt: input.state?.lastRunAt || null,
            lastMatchAt: input.state?.lastMatchAt || null,
            lastQueuedAt: input.state?.lastQueuedAt || null,
            lastQueuedEpisodeKey: input.state?.lastQueuedEpisodeKey || null,
            lastQueuedTitle: input.state?.lastQueuedTitle || null,
            queuedJobId: input.state?.queuedJobId || null,
            lastError: input.state?.lastError || null,
            lastScanCount: Number(input.state?.lastScanCount || 0) || 0,
            nextRunAt: input.state?.nextRunAt || null
        }
    };
}

function loadRules() {
    const raw = readJsonSafe(RULES_FILE, { updatedAt: null, items: [] }) || { updatedAt: null, items: [] };
    const items = Array.isArray(raw.items) ? raw.items.map((item) => normalizeRule(item)).filter((item) => item.imdbId) : [];
    items.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    return {
        updatedAt: raw.updatedAt || null,
        items
    };
}

function saveRules(payload = {}) {
    ensureDataDir();
    const items = Array.isArray(payload.items) ? payload.items.map((item) => normalizeRule(item)).filter((item) => item.imdbId) : [];
    const normalized = {
        updatedAt: new Date().toISOString(),
        items
    };
    fs.writeFileSync(RULES_FILE, JSON.stringify(normalized, null, 4), 'utf-8');
    return normalized;
}

function upsertRule(input = {}) {
    const next = normalizeRule(input);
    if (!next.imdbId) {
        throw new Error('IMDb ID is required for auto-get rules.');
    }

    const current = loadRules();
    const items = current.items.filter((item) => item.imdbId !== next.imdbId);
    items.push(next);
    return saveRules({ items });
}

function getRuleByImdbId(imdbId = '') {
    const cleanImdbId = normalizeImdbId(imdbId);
    if (!cleanImdbId) return null;
    const current = loadRules();
    return current.items.find((item) => item.imdbId === cleanImdbId) || null;
}

async function listSubscribersForImdb(imdbId = '') {
    const cleanImdbId = normalizeImdbId(imdbId);
    if (!cleanImdbId) return [];

    const users = await ProfileService.listUsers();
    const subscribers = [];

    for (const userKey of users) {
        const store = await ProfileService.readData(userKey, 'subscriptions', { items: [] });
        const items = Array.isArray(store.items) ? store.items : [];
        const match = items.find((item) => normalizeImdbId(item.imdbId || item.id || '') === cleanImdbId);
        if (!match) continue;

        const config = await ProfileService.readData(userKey, 'config', {});
        subscribers.push({
            userKey,
            displayName: config.displayName || config.name || config.username || userKey,
            autoGet: match.autoGet !== false,
            addedAt: match.addedAt || null
        });
    }

    subscribers.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')));
    return subscribers;
}

async function resolveShowAvailability(imdbId = '', showFolder = '') {
    const cleanImdbId = normalizeImdbId(imdbId);
    const empty = {
        inLibrary: false,
        availableEpisodeKeys: new Set(),
        completeSeasons: new Set(),
        showFolder: normalizeFolderName(showFolder || '') || null,
        showPath: null
    };

    if (!cleanImdbId) return empty;

    const library = await getLibrary();
    const shows = Array.isArray(library?.shows) ? library.shows : [];
    const localShow = shows.find((item) => normalizeImdbId(item.imdbId || item.imdb_id || '') === cleanImdbId) || null;
    const folder = normalizeFolderName(showFolder || path.basename(localShow?.sourcePath || '') || localShow?.id || '');
    const showPath = localShow?.sourcePath || (folder ? resolveSeriesFolderPath(folder, { mustExist: true }) : '');

    if (!showPath || !fs.existsSync(showPath)) {
        return {
            ...empty,
            inLibrary: Boolean(localShow),
            showFolder: folder || empty.showFolder
        };
    }

    const manifest = rebuildSeriesManifest(showPath, {
        showFolderName: folder || path.basename(showPath),
        write: true
    });

    const availableEpisodeKeys = new Set();
    const completeSeasons = new Set();
    Object.keys(manifest?.seasons || {}).forEach((seasonKey) => {
        const seasonNumber = Number(seasonKey);
        const episodes = Array.isArray(manifest.seasons[seasonKey]?.episodes) ? manifest.seasons[seasonKey].episodes : [];
        const availableEpisodes = episodes.filter((ep) => Boolean(ep?.available) || Boolean(String(ep?.localRelativePath || '').trim()));
        availableEpisodes.forEach((ep) => {
            const epNum = Number(ep.episodeNumber);
            if (Number.isFinite(epNum) && epNum > 0) {
                availableEpisodeKeys.add(`${seasonNumber}-${epNum}`);
            }
        });
        if (episodes.length > 0 && availableEpisodes.length >= episodes.length) {
            completeSeasons.add(seasonNumber);
        }
    });

    return {
        inLibrary: true,
        availableEpisodeKeys,
        completeSeasons,
        showFolder: folder || path.basename(showPath),
        showPath
    };
}

function getPendingEpisodeKeys(imdbId = '') {
    const cleanImdbId = normalizeImdbId(imdbId);
    const jobs = getAllJobs();
    const pending = new Set();

    jobs.forEach((job) => {
        if (normalizeImdbId(job.imdbId || job.payload?.imdbId || job.payload?.queueContext?.imdbId || '') !== cleanImdbId) return;
        if (!['QUEUED', 'PROCESSING', 'WAITING_DOWNLOAD', 'PAUSED_DOWNLOAD', 'PAUSED'].includes(String(job.status || '').toUpperCase())) return;
        const season = Number(job.payload?.queueContext?.season || 0);
        const episode = Number(job.payload?.queueContext?.episode || 0);
        if (season > 0 && episode > 0) {
            pending.add(`${season}-${episode}`);
        }
    });

    return pending;
}

async function fetchEztvCandidates(imdbId = '', maxPages = 5) {
    const imdbDigits = String(imdbId || '').replace(/^tt/i, '').trim();
    if (!/^\d{5,10}$/.test(imdbDigits)) {
        return { items: [], upstreamWarnings: ['invalid_imdb_id'] };
    }

    const baseUrls = [
        'https://eztv.wf/api/get-torrents',
        'https://eztv.re/api/get-torrents'
    ];

    const upstreamWarnings = [];
    for (const baseUrl of baseUrls) {
        const collected = [];
        try {
            for (let page = 1; page <= maxPages; page += 1) {
                const response = await axios.get(baseUrl, {
                    params: { imdb_id: imdbDigits, page },
                    timeout: 12000,
                    headers: { 'User-Agent': 'movie-streamer-auto-get/1.0' }
                });

                const torrents = Array.isArray(response.data?.torrents) ? response.data.torrents : [];
                if (!torrents.length) break;
                collected.push(...torrents);
                if (torrents.length < 100) break;
            }

            const mapped = collected.map((row) => {
                const title = String(row?.title || row?.filename || '').trim();
                const parsed = parseSeasonEpisodeFromTitle(title);
                const magnetUrl = String(row?.magnet_url || row?.magnet || '').trim();
                return {
                    title,
                    magnetUrl,
                    season: Number.isFinite(parsed.season) ? parsed.season : null,
                    episode: Number.isFinite(parsed.episode) ? parsed.episode : null,
                    seeds: parseInt(row?.seeds, 10) || 0,
                    peers: parseInt(row?.peers, 10) || 0,
                    sizeBytes: parseFloat(row?.size_bytes || row?.size || 0) || 0,
                    sizeMb: Math.round(((parseFloat(row?.size_bytes || row?.size || 0) || 0) / (1024 * 1024)) * 10) / 10,
                    quality: inferQualityLabel(title),
                    releasedAt: row?.date_released_unix ? new Date(Number(row.date_released_unix) * 1000).toISOString() : null,
                    hash: String(row?.hash || '').trim().toLowerCase(),
                    raw: row
                };
            }).filter((item) => item.title && item.magnetUrl && item.season && item.episode);

            return {
                items: mapped,
                upstreamWarnings
            };
        } catch (err) {
            upstreamWarnings.push(`${baseUrl}: ${err.message}`);
        }
    }

    return { items: [], upstreamWarnings };
}

function matchesRuleWindow(candidate, rule) {
    const seasonStart = Number(rule.seasonStart || 1);
    const episodeStart = Number(rule.episodeStart || 1);
    if (candidate.season < seasonStart) return false;
    if (candidate.season === seasonStart && candidate.episode < episodeStart) return false;
    return true;
}

function isRuleDue(rule, nowMs = Date.now()) {
    if (!rule.enabled) return false;
    const cycleMs = Math.max(5, Number(rule.checkCycleMinutes || DEFAULT_CHECK_CYCLE_MINUTES)) * 60 * 1000;
    const lastRunMs = rule.state?.lastRunAt ? Date.parse(rule.state.lastRunAt) : 0;
    if (lastRunMs && nowMs - lastRunMs < cycleMs) return false;

    const airDay = normalizeDayToken(rule.airDay || '');
    if (airDay) {
        const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(nowMs).getDay()];
        if (today !== airDay) return false;
    }

    return true;
}

function filterCandidates(candidates = [], rule) {
    const allowQualities = Array.isArray(rule.qualityAllow) ? rule.qualityAllow : [];
    const excludeQualities = new Set(Array.isArray(rule.excludeQuality) ? rule.excludeQuality : []);
    const mustContain = Array.isArray(rule.mustContain) ? rule.mustContain : [];
    const excludeWords = Array.isArray(rule.excludeWords) ? rule.excludeWords : [];

    return candidates.filter((candidate) => {
        const titleNorm = String(candidate.title || '').toLowerCase();
        if (!matchesRuleWindow(candidate, rule)) return false;
        if (candidate.seeds < Number(rule.minSeeds || 0)) return false;
        if (Number(rule.minSizeMb || 0) > 0 && candidate.sizeMb < Number(rule.minSizeMb || 0)) return false;
        if (Number(rule.maxSizeMb || 0) > 0 && candidate.sizeMb > Number(rule.maxSizeMb || 0)) return false;
        if (allowQualities.length > 0 && !allowQualities.includes(candidate.quality)) return false;
        if (excludeQualities.has(candidate.quality)) return false;
        if (mustContain.some((token) => !titleNorm.includes(token))) return false;
        if (excludeWords.some((token) => titleNorm.includes(token))) return false;
        return true;
    });
}

function scoreCandidate(candidate) {
    let score = 0;
    score += Math.min(200, candidate.seeds * 5);
    score += Math.min(80, candidate.peers * 2);
    if (candidate.quality === '1080p') score += 25;
    else if (candidate.quality === '720p') score += 15;
    else if (candidate.quality === '2160p') score += 10;
    return score;
}

function pickBestByEpisode(candidates = []) {
    const grouped = new Map();
    for (const candidate of candidates) {
        const key = `${candidate.season}-${candidate.episode}`;
        const existing = grouped.get(key);
        if (!existing || scoreCandidate(candidate) > scoreCandidate(existing)) {
            grouped.set(key, candidate);
        }
    }

    return Array.from(grouped.values()).sort((a, b) => {
        if (a.season !== b.season) return a.season - b.season;
        return a.episode - b.episode;
    });
}

async function queueCandidate(rule, candidate, options = {}) {
    const effectiveImdbId = normalizeImdbId(rule.imdbId);
    const queueContext = {
        imdbId: effectiveImdbId,
        season: candidate.season,
        episode: candidate.episode,
        sourceType: 'episode',
        targetShowFolder: rule.showFolder || null,
        addedByUser: options.addedByUser || null
    };

    await TorrentService.addMagnet(candidate.magnetUrl, 'series-streamer', effectiveImdbId, {
        addedByUser: options.addedByUser || null,
        queueContext
    });

    let torrentName = candidate.title || 'Unknown';
    let infoHash = candidate.hash || null;
    try {
        const magnet = new URL(candidate.magnetUrl);
        torrentName = magnet.searchParams.get('dn') || torrentName;
        const xt = magnet.searchParams.get('xt') || '';
        if (!infoHash && xt.includes('btih:')) {
            infoHash = xt.split('btih:')[1];
        }
    } catch (_err) {
        // Keep parsed candidate title/hash.
    }

    const mediaTitle = `${rule.title || candidate.title || effectiveImdbId} S${String(candidate.season).padStart(2, '0')}E${String(candidate.episode).padStart(2, '0')}`;
    const queuedJob = createJob({
        status: 'WAITING_DOWNLOAD',
        currentStep: 'INGEST',
        imdbId: effectiveImdbId,
        contentType: 'series',
        payload: {
            torrentHash: infoHash,
            torrentName,
            rawPath: null,
            cleanPath: null,
            videoFile: null,
            magnetUrl: candidate.magnetUrl,
            imdbId: effectiveImdbId,
            mediaTitle,
            addedByUser: options.addedByUser || null,
            queueContext,
            sourceSelection: 'series-auto-get'
        }
    });

    return { queuedJob, mediaTitle };
}

async function processRule(ruleInput, options = {}) {
    const rule = normalizeRule(ruleInput);
    const nowIso = new Date().toISOString();
    const subscribers = await listSubscribersForImdb(rule.imdbId);
    const subscriberKeys = subscribers.filter((item) => item.autoGet !== false).map((item) => item.userKey);

    const availability = await resolveShowAvailability(rule.imdbId, rule.showFolder);
    const pendingKeys = getPendingEpisodeKeys(rule.imdbId);
    const fetched = await fetchEztvCandidates(rule.imdbId, 5);
    const filtered = filterCandidates(fetched.items, rule);
    const ranked = pickBestByEpisode(filtered);

    const nextCandidate = ranked.find((candidate) => {
        const key = `${candidate.season}-${candidate.episode}`;
        if (availability.availableEpisodeKeys.has(key)) return false;
        if (pendingKeys.has(key)) return false;
        if (rule.state?.lastQueuedEpisodeKey && rule.state.lastQueuedEpisodeKey === key) return false;
        return true;
    }) || null;

    const state = {
        ...rule.state,
        lastRunAt: nowIso,
        lastScanCount: ranked.length,
        nextRunAt: new Date(Date.now() + (Math.max(5, Number(rule.checkCycleMinutes || DEFAULT_CHECK_CYCLE_MINUTES)) * 60 * 1000)).toISOString(),
        lastError: null
    };

    let queued = null;
    if (nextCandidate) {
        const queuedResult = await queueCandidate(rule, nextCandidate, { addedByUser: null });
        queued = {
            season: nextCandidate.season,
            episode: nextCandidate.episode,
            title: queuedResult.mediaTitle,
            jobId: queuedResult.queuedJob.id
        };
        state.lastMatchAt = nowIso;
        state.lastQueuedAt = nowIso;
        state.lastQueuedEpisodeKey = `${nextCandidate.season}-${nextCandidate.episode}`;
        state.lastQueuedTitle = queuedResult.mediaTitle;
        state.queuedJobId = queuedResult.queuedJob.id;

        for (const userKey of subscriberKeys) {
            await NotificationService.push(userKey, {
                category: 'library',
                title: `${rule.title || 'TV Show'} S${String(nextCandidate.season).padStart(2, '0')}E${String(nextCandidate.episode).padStart(2, '0')} queued`,
                message: 'Auto-get picked up a new episode release and added it to the queue.',
                href: rule.showFolder ? `/series.html?id=${encodeURIComponent(`series/${rule.showFolder}`)}` : '',
                payload: {
                    imdbId: rule.imdbId,
                    season: nextCandidate.season,
                    episode: nextCandidate.episode,
                    jobId: queuedResult.queuedJob.id,
                    source: 'series-auto-get'
                }
            });
        }
    }

    const nextRule = {
        ...rule,
        showFolder: rule.showFolder || availability.showFolder || rule.showFolder,
        state
    };
    upsertRule(nextRule);

    return {
        success: true,
        rule: nextRule,
        subscribers,
        availability: {
            inLibrary: availability.inLibrary,
            availableCount: availability.availableEpisodeKeys.size,
            pendingCount: pendingKeys.size
        },
        scanned: fetched.items.length,
        filtered: ranked.length,
        queued,
        upstreamWarnings: fetched.upstreamWarnings || []
    };
}

async function previewRule(ruleInput) {
    const rule = normalizeRule(ruleInput);
    const fetched = await fetchEztvCandidates(rule.imdbId, 5);
    const filtered = filterCandidates(fetched.items, rule);
    const ranked = pickBestByEpisode(filtered);
    const subscribers = await listSubscribersForImdb(rule.imdbId);
    return {
        success: true,
        rule,
        subscribers,
        rawCount: fetched.items.length,
        filteredCount: ranked.length,
        items: ranked.slice(0, 60),
        upstreamWarnings: fetched.upstreamWarnings || []
    };
}

async function processDueRules(options = {}) {
    const nowMs = Date.now();
    const forceAll = options.forceAll === true;
    const rules = loadRules().items.filter((rule) => forceAll || isRuleDue(rule, nowMs));
    const results = [];

    for (const rule of rules) {
        try {
            results.push(await processRule(rule, options));
        } catch (err) {
            const failedRule = {
                ...rule,
                state: {
                    ...(rule.state || {}),
                    lastRunAt: new Date().toISOString(),
                    lastError: err.message,
                    nextRunAt: new Date(Date.now() + (Math.max(5, Number(rule.checkCycleMinutes || DEFAULT_CHECK_CYCLE_MINUTES)) * 60 * 1000)).toISOString()
                }
            };
            upsertRule(failedRule);
            results.push({ success: false, rule: failedRule, error: err.message });
        }
    }

    return {
        success: true,
        scannedRules: rules.length,
        queuedCount: results.filter((item) => item?.queued).length,
        results
    };
}

function startWorker() {
    if (!WORKER_ENABLED) {
        logger.info('TV auto-get worker disabled via ENABLE_TV_AUTO_GET_WORKER=false.');
        return;
    }
    if (workerTimer) return;

    workerTimer = setInterval(async () => {
        if (workerRunning) return;
        workerRunning = true;
        try {
            const summary = await processDueRules();
            if (summary.queuedCount > 0 || summary.scannedRules > 0) {
                logger.info(`📺 [AutoGet] scannedRules=${summary.scannedRules} queued=${summary.queuedCount}`);
            }
        } catch (err) {
            logger.warn(`TV auto-get worker tick failed: ${err.message}`);
        } finally {
            workerRunning = false;
        }
    }, WORKER_INTERVAL_MS);

    logger.info(`TV auto-get worker started with interval ${WORKER_INTERVAL_MS}ms`);
}

function stopWorker() {
    if (!workerTimer) return;
    clearInterval(workerTimer);
    workerTimer = null;
}

async function getRuleView(showFolder = '') {
    const cleanFolder = normalizeFolderName(showFolder);
    const tvIndex = loadIndex();
    const tvItems = Array.isArray(tvIndex?.items) ? tvIndex.items : [];
    const indexItem = loadRules().items.find((item) => item.showFolder === cleanFolder)
        || tvItems.find((item) => normalizeFolderName(item.folderName || '') === cleanFolder)
        || null;
    const registry = getSeriesByImdbId(indexItem?.imdbId || '') || null;
    const imdbId = normalizeImdbId(indexItem?.imdbId || registry?.imdbId || '');
    const rule = imdbId ? getRuleByImdbId(imdbId) : null;
    const subscribers = imdbId ? await listSubscribersForImdb(imdbId) : [];
    return {
        imdbId: imdbId || null,
        rule,
        subscribers,
        registryItem: registry || indexItem || null
    };
}

module.exports = {
    RULES_FILE,
    loadRules,
    saveRules,
    upsertRule,
    getRuleByImdbId,
    getRuleView,
    previewRule,
    processRule,
    processDueRules,
    startWorker,
    stopWorker,
    normalizeRule,
    listSubscribersForImdb
};