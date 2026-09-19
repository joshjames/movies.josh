const fs = require('fs');
const path = require('path');

const logger = require('./logger');
const ProfileService = require('./ProfileService');
const NotificationService = require('./NotificationService');
const TorrentService = require('./TorrentService');
const { getLibrary } = require('./db');
const { rebuildSeriesManifest } = require('./SeriesIndexService');
const { getSeriesByImdbId, loadIndex } = require('./TvSeriesIndexService');
const { resolveSeriesFolderPath } = require('./StoragePathResolver');
const { createJob, getAllJobs } = require('./PipelineQueueService');
const metadataProvider = require('./MetadataProvider');
const SeriesAcquisitionService = require('./SeriesAcquisitionService');
const EztvCatalogService = require('./EztvCatalogService');

const DATA_ROOT_CANDIDATES = [
    String(process.env.APP_DATA_DIR || '').trim(),
    '/app/metadata',
    path.join(__dirname, '../../metadata'),
    path.join(__dirname, '../../movie-streamer-data')
].filter(Boolean);
const LEGACY_DATA_ROOT = path.join(__dirname, '../../movie-streamer-data');
const DATA_ROOT = DATA_ROOT_CANDIDATES[0];
const RULES_FILE = path.join(DATA_ROOT, 'tv-auto-get-rules.json');
const LEGACY_RULES_FILE = path.join(LEGACY_DATA_ROOT, 'tv-auto-get-rules.json');
const DEFAULT_CHECK_CYCLE_MINUTES = Math.max(5, Number(process.env.TV_AUTO_GET_DEFAULT_CHECK_CYCLE_MINUTES || 120));
const WORKER_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.TV_AUTO_GET_WORKER_INTERVAL_MS || 15 * 60 * 1000));
const WORKER_ENABLED = !['false', '0', 'no'].includes(String(process.env.ENABLE_TV_AUTO_GET_WORKER || 'true').trim().toLowerCase());

// --- Acquisition tiers ---------------------------------------------------
// Instead of polling every rule on a flat interval forever, each rule now
// tracks the next episode's known air date (from TMDb/OMDb via
// MetadataProvider - the same source already proven accurate). "Tier" gates
// both *whether* to check at all right now and *which* sources to check:
// EZTV is fast for popular/well-seeded shows but its release lag relative to
// the real air date is undocumented and can be long (see the EZTV/TMDb
// research this design is based on, 2026-09-19) - so it's tried alone first,
// then qBittorrent's broader (but less precise - see the known
// "no confident search result" scoring gap) search API joins in once EZTV
// hasn't delivered within a reasonable window, and finally settles into
// backfill mode (same slower cadence as before) rather than ever giving up.
const TIER1_HOURS = Math.max(1, Number(process.env.TV_AUTO_GET_TIER1_HOURS || 12));
const TIER2_HOURS = Math.max(TIER1_HOURS, Number(process.env.TV_AUTO_GET_TIER2_HOURS || 72));
const TIER1_CHECK_MINUTES = Math.max(5, Number(process.env.TV_AUTO_GET_TIER1_CHECK_MINUTES || 90));
const TIER2_CHECK_MINUTES = Math.max(5, Number(process.env.TV_AUTO_GET_TIER2_CHECK_MINUTES || 180));
// How often to re-resolve the next target episode + its air date from
// TMDb/OMDb - not every tick, since most rules' answer won't have changed.
const AIR_DATE_REFRESH_INTERVAL_MS = Math.max(60 * 60 * 1000, Number(process.env.TV_AUTO_GET_AIR_DATE_REFRESH_INTERVAL_MS || 6 * 60 * 60 * 1000));

let workerTimer = null;
let workerRunning = false;
let workerLastRunAt = null;
let workerLastSummary = null;
let workerLastError = null;

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

function loadRulesFileWithFallback() {
    const primary = readJsonSafe(RULES_FILE, null);
    if (primary && Array.isArray(primary.items)) {
        return primary;
    }

    if (RULES_FILE !== LEGACY_RULES_FILE) {
        const legacy = readJsonSafe(LEGACY_RULES_FILE, null);
        if (legacy && Array.isArray(legacy.items)) {
            try {
                ensureDataDir();
                fs.writeFileSync(RULES_FILE, JSON.stringify(legacy, null, 4), 'utf-8');
                logger.info(`Migrated TV auto-get rules into persistent data root: ${RULES_FILE}`);
            } catch (err) {
                logger.warn(`Failed migrating TV auto-get rules to persistent data root: ${err.message}`);
            }
            return legacy;
        }
    }

    return { updatedAt: null, items: [] };
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
            nextRunAt: input.state?.nextRunAt || null,
            // Acquisition-tier tracking (see TIER1_HOURS/TIER2_HOURS above).
            nextKnownSeason: Number.isFinite(Number(input.state?.nextKnownSeason)) ? Number(input.state.nextKnownSeason) : null,
            nextKnownEpisode: Number.isFinite(Number(input.state?.nextKnownEpisode)) ? Number(input.state.nextKnownEpisode) : null,
            nextKnownAirDate: input.state?.nextKnownAirDate || null,
            airDateCheckedAt: input.state?.airDateCheckedAt || null,
            lastTier: input.state?.lastTier || null
        }
    };
}

function loadRules() {
    const raw = loadRulesFileWithFallback();
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

async function getPendingEpisodeKeys(imdbId = '') {
    const cleanImdbId = normalizeImdbId(imdbId);
    const jobs = await getAllJobs();
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

    const fetched = await EztvCatalogService.getTorrentsForImdb(imdbDigits, { maxPages });
    const collected = Array.isArray(fetched.torrents) ? fetched.torrents : [];

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
        upstreamWarnings: fetched.upstreamWarnings || []
    };
}

// Walks forward from the rule's seasonStart/episodeStart using TMDb/OMDb's
// per-season episode data (via MetadataProvider, the same source already
// proven accurate) to find the earliest episode that's neither already in
// the library nor already mid-pipeline, and that episode's known air date.
// Independent of what EZTV has - this answers "when is the next episode we
// actually want", not "what's already been released that we don't have".
// Bounded to a few seasons so a bad/stale seasonStart on a long-running
// show can't cause unbounded scanning.
async function resolveNextTargetEpisode(rule, availability, pendingKeys) {
    const showTitle = rule.title || '';
    const startSeason = Math.max(1, Number(rule.seasonStart || 1));
    const maxSeasonsToScan = 3;

    for (let offset = 0; offset < maxSeasonsToScan; offset += 1) {
        const season = startSeason + offset;
        let episodes;
        try {
            episodes = await metadataProvider.fetchSeasonEpisodesWithFallback({
                imdbId: rule.imdbId,
                title: showTitle,
                season
            });
        } catch (_err) {
            episodes = [];
        }

        if (!Array.isArray(episodes) || episodes.length === 0) {
            // No data for this season (or none exists yet) - nothing further
            // to find by scanning later seasons either.
            break;
        }

        const episodeFloor = offset === 0 ? Math.max(1, Number(rule.episodeStart || 1)) : 1;
        const sorted = episodes
            .map((ep) => ({ episodeNumber: parseInt(ep.Episode, 10), released: ep.Released }))
            .filter((ep) => Number.isFinite(ep.episodeNumber) && ep.episodeNumber >= episodeFloor)
            .sort((a, b) => a.episodeNumber - b.episodeNumber);

        for (const ep of sorted) {
            const key = `${season}-${ep.episodeNumber}`;
            if (availability.availableEpisodeKeys.has(key)) continue;
            if (pendingKeys.has(key)) continue;

            const parsedDate = ep.released && ep.released !== 'N/A' && ep.released !== 'Unknown'
                ? new Date(ep.released)
                : null;

            return {
                season,
                episode: ep.episodeNumber,
                airDate: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null
            };
        }
        // Every episode TMDb knows about for this season is already
        // available/pending - keep scanning forward into the next season.
    }

    return null;
}

// defaultCheckIntervalMinutes is the rule's own checkCycleMinutes - used
// whenever there's no tier-specific interval (no known air date at all, or
// backfill mode), so a show acquisition tiers can't confidently place still
// gets checked on the same cadence this always used before tiers existed.
// Some sources represent "we don't actually know" as an implausibly early
// sentinel date (e.g. 1900-01-01) rather than an explicit null/N/A -
// confirmed as a real risk here, not a hypothetical: treat anything before
// this floor the same as "no date at all", never as a genuinely-past date.
const SENTINEL_DATE_FLOOR_MS = Date.UTC(1970, 0, 1);

function computeAcquisitionTier(nextKnownAirDateIso, nowMs, defaultCheckIntervalMinutes) {
    const parsedAirDateMs = nextKnownAirDateIso ? Date.parse(nextKnownAirDateIso) : NaN;
    const airDateMs = Number.isFinite(parsedAirDateMs) && parsedAirDateMs >= SENTINEL_DATE_FLOOR_MS ? parsedAirDateMs : NaN;

    if (!Number.isFinite(airDateMs)) {
        // No confirmed air date at all - found in metadata but not yet
        // scheduled/aired, sentinel "unknown" date, or metadata lookup
        // failed outright. Confirmed live why this must never reach for
        // qBittorrent's fuzzy search: two shows whose next season hadn't
        // actually aired yet ("The Gentlemen" S03, "X-Men '97" S03) both got
        // confidently matched to the *wrong* season by that search, because
        // there was nothing real to find and it picked the closest-scoring
        // wrong answer instead. EZTV is safe to still try - it only ever
        // matches on an exact season/episode parsed from the release title
        // (see matchesRuleWindow/pickBestByEpisode), so it can't misfire the
        // same way; it just won't find anything for a season that isn't out.
        return { tier: 'no-confirmed-date', useEztv: true, useQbitSearch: false, checkIntervalMinutes: defaultCheckIntervalMinutes };
    }

    const hoursSinceAirDate = (nowMs - airDateMs) / (1000 * 60 * 60);
    if (hoursSinceAirDate < 0) {
        return { tier: 'not-yet', useEztv: false, useQbitSearch: false, checkIntervalMinutes: null };
    }
    if (hoursSinceAirDate < TIER1_HOURS) {
        return { tier: 'tier1', useEztv: true, useQbitSearch: false, checkIntervalMinutes: TIER1_CHECK_MINUTES };
    }
    if (hoursSinceAirDate < TIER2_HOURS) {
        return { tier: 'tier2', useEztv: true, useQbitSearch: true, checkIntervalMinutes: TIER2_CHECK_MINUTES };
    }
    return { tier: 'backfill', useEztv: true, useQbitSearch: true, checkIntervalMinutes: defaultCheckIntervalMinutes };
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

    const airDay = normalizeDayToken(rule.airDay || '');
    if (airDay) {
        const today = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(nowMs).getDay()];
        if (today !== airDay) return false;
    }

    const state = rule.state || {};

    // Stale/missing air-date info takes priority over everything else below -
    // let processRule refresh it (cheap: it's gated to AIR_DATE_REFRESH_INTERVAL_MS
    // internally too, this is just what makes that refresh actually happen).
    const airDateCheckedAtMs = state.airDateCheckedAt ? Date.parse(state.airDateCheckedAt) : 0;
    if (!airDateCheckedAtMs || (nowMs - airDateCheckedAtMs) >= AIR_DATE_REFRESH_INTERVAL_MS) {
        return true;
    }

    const nextKnownAirDateMs = state.nextKnownAirDate ? Date.parse(state.nextKnownAirDate) : NaN;
    if (Number.isFinite(nextKnownAirDateMs) && nextKnownAirDateMs > nowMs) {
        return false; // known air date hasn't arrived yet - nothing to check
    }

    const defaultCycleMinutes = Math.max(5, Number(rule.checkCycleMinutes || DEFAULT_CHECK_CYCLE_MINUTES));
    const tier = computeAcquisitionTier(state.nextKnownAirDate, nowMs, defaultCycleMinutes);
    if (tier.tier === 'not-yet') return false;

    const cycleMs = Math.max(5, Number(tier.checkIntervalMinutes || defaultCycleMinutes)) * 60 * 1000;
    const lastRunMs = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
    if (lastRunMs && nowMs - lastRunMs < cycleMs) return false;

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
    const queuedJob = await createJob({
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

async function queueViaQbitSearch(rule, target, options = {}) {
    const showTitle = rule.title || getSeriesByImdbId(rule.imdbId)?.title || rule.imdbId;
    const query = SeriesAcquisitionService.buildAutoSeriesSearchQuery(showTitle, target.season, target.episode, 'episode');
    const queueContext = {
        imdbId: rule.imdbId,
        season: target.season,
        episode: target.episode,
        sourceType: 'episode',
        targetShowFolder: rule.showFolder || null,
        addedByUser: options.addedByUser || null
    };
    const mediaTitle = `${showTitle} S${String(target.season).padStart(2, '0')}E${String(target.episode).padStart(2, '0')}`;

    const queuedJob = await createJob({
        status: 'QUEUED',
        currentStep: 'SEARCH',
        imdbId: rule.imdbId,
        contentType: 'series',
        payload: {
            searchIntent: {
                title: showTitle,
                imdbId: rule.imdbId,
                season: target.season,
                episode: target.episode,
                sourceType: 'episode',
                category: 'tv',
                plugins: 'enabled',
                timeoutMs: null,
                minScore: null,
                addedByUser: options.addedByUser || null
            },
            mediaTitle,
            queueContext
        }
    });

    // Best-effort immediate kick (same pattern as the manual "Queue Episode"
    // button) - if this fails, PipelineWorker's own tick picks the job up
    // regardless, just without the head start.
    try {
        const { kickQueueJob } = require('./workers/PipelineWorker');
        await kickQueueJob(queuedJob.id);
    } catch (_err) {
        // Not fatal - see comment above.
    }

    return { queuedJob, mediaTitle };
}

async function processRule(ruleInput, options = {}) {
    const rule = normalizeRule(ruleInput);
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const subscribers = await listSubscribersForImdb(rule.imdbId);
    const subscriberKeys = subscribers.filter((item) => item.autoGet !== false).map((item) => item.userKey);

    const availability = await resolveShowAvailability(rule.imdbId, rule.showFolder);
    const pendingKeys = await getPendingEpisodeKeys(rule.imdbId);

    const state = { ...rule.state };
    const defaultCycleMinutes = Math.max(5, Number(rule.checkCycleMinutes || DEFAULT_CHECK_CYCLE_MINUTES));

    // Refresh the known-next-episode/air-date if stale or missing. Failure
    // here (metadata provider down, show not found, etc.) just leaves the
    // previous cached value in place rather than blowing up the whole rule.
    const airDateCheckedAtMs = state.airDateCheckedAt ? Date.parse(state.airDateCheckedAt) : 0;
    if (!airDateCheckedAtMs || (nowMs - airDateCheckedAtMs) >= AIR_DATE_REFRESH_INTERVAL_MS) {
        try {
            const target = await resolveNextTargetEpisode(rule, availability, pendingKeys);
            state.nextKnownSeason = target?.season ?? null;
            state.nextKnownEpisode = target?.episode ?? null;
            state.nextKnownAirDate = target?.airDate ?? null;
            state.airDateCheckedAt = nowIso;
        } catch (err) {
            logger.warn(`[AutoGet] Air-date refresh failed for ${rule.imdbId}: ${err.message}`);
        }
    }

    const tier = computeAcquisitionTier(state.nextKnownAirDate, nowMs, defaultCycleMinutes);
    state.lastTier = tier.tier;

    // Known air date hasn't arrived yet - nothing productive to do. Still
    // save the refreshed air-date state above so isRuleDue() has it for next
    // time, but skip the EZTV/qBittorrent network calls entirely.
    if (tier.tier === 'not-yet') {
        state.lastRunAt = nowIso;
        state.nextRunAt = state.nextKnownAirDate;
        state.lastError = null;
        const nextRule = { ...rule, showFolder: rule.showFolder || availability.showFolder || rule.showFolder, state };
        upsertRule(nextRule);
        return {
            success: true,
            rule: nextRule,
            subscribers,
            availability: { inLibrary: availability.inLibrary, availableCount: availability.availableEpisodeKeys.size, pendingCount: pendingKeys.size },
            scanned: 0,
            filtered: 0,
            queued: null,
            tier: tier.tier,
            upstreamWarnings: []
        };
    }

    const fetched = tier.useEztv
        ? await fetchEztvCandidates(rule.imdbId, 5)
        : { items: [], upstreamWarnings: [] };
    const filtered = filterCandidates(fetched.items, rule);
    const ranked = pickBestByEpisode(filtered);

    const nextCandidate = ranked.find((candidate) => {
        const key = `${candidate.season}-${candidate.episode}`;
        if (availability.availableEpisodeKeys.has(key)) return false;
        if (pendingKeys.has(key)) return false;
        if (rule.state?.lastQueuedEpisodeKey && rule.state.lastQueuedEpisodeKey === key) return false;
        return true;
    }) || null;

    state.lastRunAt = nowIso;
    state.lastScanCount = ranked.length;
    state.nextRunAt = new Date(nowMs + (Math.max(5, Number(tier.checkIntervalMinutes || defaultCycleMinutes)) * 60 * 1000)).toISOString();
    state.lastError = null;

    let queued = null;
    let queueSource = null;

    if (nextCandidate) {
        const queuedResult = await queueCandidate(rule, nextCandidate, { addedByUser: null });
        queued = { season: nextCandidate.season, episode: nextCandidate.episode, title: queuedResult.mediaTitle, jobId: queuedResult.queuedJob.id };
        queueSource = 'eztv';
    } else if (tier.useQbitSearch && state.nextKnownSeason && state.nextKnownEpisode) {
        // EZTV came up empty (or wasn't tried this tier) and we're far enough
        // past the air date to widen the net - try qBittorrent's search
        // plugins for the specific episode TMDb told us is next.
        const target = { season: state.nextKnownSeason, episode: state.nextKnownEpisode };
        const key = `${target.season}-${target.episode}`;
        const alreadyPending = availability.availableEpisodeKeys.has(key) || pendingKeys.has(key);
        if (!alreadyPending) {
            try {
                const queuedResult = await queueViaQbitSearch(rule, target, { addedByUser: null });
                queued = { season: target.season, episode: target.episode, title: queuedResult.mediaTitle, jobId: queuedResult.queuedJob.id };
                queueSource = 'qbittorrent-search';
            } catch (err) {
                logger.warn(`[AutoGet] qBittorrent-search fallback failed for ${rule.imdbId} S${target.season}E${target.episode}: ${err.message}`);
            }
        }
    }

    if (queued) {
        state.lastMatchAt = nowIso;
        state.lastQueuedAt = nowIso;
        state.lastQueuedEpisodeKey = `${queued.season}-${queued.episode}`;
        state.lastQueuedTitle = queued.title;
        state.queuedJobId = queued.jobId;

        for (const userKey of subscriberKeys) {
            await NotificationService.push(userKey, {
                category: 'library',
                title: `${rule.title || 'TV Show'} S${String(queued.season).padStart(2, '0')}E${String(queued.episode).padStart(2, '0')} queued`,
                message: queueSource === 'qbittorrent-search'
                    ? 'Auto-get widened its search after EZTV had nothing yet, and found this episode.'
                    : 'Auto-get picked up a new episode release and added it to the queue.',
                href: rule.showFolder ? `/series.html?id=${encodeURIComponent(`series/${rule.showFolder}`)}` : '',
                payload: {
                    imdbId: rule.imdbId,
                    season: queued.season,
                    episode: queued.episode,
                    jobId: queued.jobId,
                    source: queueSource === 'qbittorrent-search' ? 'series-auto-get-qbit-fallback' : 'series-auto-get'
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
        tier: tier.tier,
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

async function runWorkerTick(reason = 'interval') {
    if (workerRunning) return { skipped: true, reason: 'already-running' };
    workerRunning = true;
    try {
        const summary = await processDueRules();
        workerLastRunAt = new Date().toISOString();
        workerLastSummary = {
            ...summary,
            reason,
            runAt: workerLastRunAt
        };
        workerLastError = null;

        if (summary.queuedCount > 0 || summary.scannedRules > 0) {
            logger.info(`📺 [AutoGet] reason=${reason} scannedRules=${summary.scannedRules} queued=${summary.queuedCount}`);
        }

        return summary;
    } catch (err) {
        workerLastRunAt = new Date().toISOString();
        workerLastError = err.message;
        logger.warn(`TV auto-get worker tick failed: ${err.message}`);
        throw err;
    } finally {
        workerRunning = false;
    }
}

function startWorker() {
    if (!WORKER_ENABLED) {
        logger.info('TV auto-get worker disabled via ENABLE_TV_AUTO_GET_WORKER=false.');
        return;
    }
    if (workerTimer) return;

    workerTimer = setInterval(() => {
        runWorkerTick('interval').catch(() => {
            // Logged in runWorkerTick.
        });
    }, WORKER_INTERVAL_MS);

    runWorkerTick('startup').catch(() => {
        // Logged in runWorkerTick.
    });

    logger.info(`TV auto-get worker started with interval ${WORKER_INTERVAL_MS}ms`);
}

function stopWorker() {
    if (!workerTimer) return;
    clearInterval(workerTimer);
    workerTimer = null;
}

function getWorkerStatus() {
    return {
        enabled: WORKER_ENABLED,
        running: workerRunning,
        intervalMs: WORKER_INTERVAL_MS,
        hasTimer: Boolean(workerTimer),
        lastRunAt: workerLastRunAt,
        lastError: workerLastError,
        lastSummary: workerLastSummary
    };
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
    runWorkerTick,
    startWorker,
    stopWorker,
    getWorkerStatus,
    normalizeRule,
    listSubscribersForImdb
};