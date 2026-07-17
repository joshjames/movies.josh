const express = require('express');
const axios = require('axios');

const router = express.Router();
const logger = require('../services/logger');
const TorrentSearchService = require('../services/TorrentSearchService');
const { searchIndex: searchTvIndex, getSeriesByImdbId } = require('../services/TvSeriesIndexService');
const MovieTitleIndexService = require('../services/MovieTitleIndexService');

function parseIntSafe(value, fallback = 0) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatSafe(value, fallback = 0) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sanitizeLookupQuery(value) {
    return normalizeText(
        String(value || '')
            .replace(/s\d{1,2}\s*e\d{1,2}/gi, ' ')
            .replace(/season\s*\d{1,2}/gi, ' ')
            .replace(/episode\s*\d{1,3}/gi, ' ')
            .replace(/\b(1080p|720p|2160p|4k|h264|x264|x265|hevc|webrip|webdl|web)\b/gi, ' ')
    );
}

function normalizeImdbLoose(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return '';
    return `tt${cleaned}`;
}

function scoreTitleCandidate({ candidate, query, imdbHint = '', preferredType = 'auto' }) {
    const titleNorm = normalizeText(candidate?.title || candidate?.originalTitle || '');
    const queryNorm = normalizeText(query || '');
    const imdb = normalizeImdbLoose(candidate?.imdbId || candidate?.id || '');
    const terms = queryNorm.split(' ').filter(Boolean);

    let score = 0;
    if (imdbHint && imdb && imdbHint === imdb) score += 800;
    if (titleNorm === queryNorm && queryNorm) score += 260;
    else if (titleNorm.startsWith(queryNorm) && queryNorm) score += 160;

    for (const t of terms) {
        if (titleNorm.includes(t)) score += 24;
        else score -= 20;
    }

    const votes = Number(candidate?.votes || candidate?.numVotes || 0) || 0;
    const rating = Number(candidate?.rating || candidate?.averageRating || 0) || 0;
    score += Math.min(120, Math.floor(votes / 10000));
    score += Math.floor(rating * 10);

    const type = String(candidate?.mediaType || 'series');
    if (preferredType === 'series' && type === 'series') score += 80;
    if (preferredType === 'movie' && type === 'movie') score += 80;
    if (preferredType === 'series' && type === 'movie') score -= 20;
    if (preferredType === 'movie' && type === 'series') score -= 20;

    return score;
}

async function searchOmdbFallback(query, limit = 8) {
    const apiKey = String(process.env.OMDB_API_KEY || '84196d01').trim();
    if (!apiKey) return [];

    try {
        const [movieRes, seriesRes] = await Promise.all([
            axios.get(`http://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&s=${encodeURIComponent(query)}&type=movie`, { timeout: 8000 }),
            axios.get(`http://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&s=${encodeURIComponent(query)}&type=series`, { timeout: 8000 })
        ]);

        const movieRows = Array.isArray(movieRes?.data?.Search) ? movieRes.data.Search : [];
        const seriesRows = Array.isArray(seriesRes?.data?.Search) ? seriesRes.data.Search : [];

        const mapped = [
            ...movieRows.map(row => ({
                mediaType: 'movie',
                imdbId: normalizeImdbLoose(row.imdbID || ''),
                title: String(row.Title || '').trim(),
                year: String(row.Year || '').trim(),
                votes: 0,
                rating: 0,
                source: 'omdb-fallback'
            })),
            ...seriesRows.map(row => ({
                mediaType: 'series',
                imdbId: normalizeImdbLoose(row.imdbID || ''),
                title: String(row.Title || '').trim(),
                startYear: String(row.Year || '').split('-')[0] || '',
                endYear: String(row.Year || '').split('-')[1] || '',
                episodeCount: 0,
                numVotes: 0,
                averageRating: 0,
                source: 'omdb-fallback'
            }))
        ].filter(item => item.imdbId && item.title);

        const deduped = [];
        const seen = new Set();
        for (const item of mapped) {
            if (seen.has(item.imdbId)) continue;
            seen.add(item.imdbId);
            deduped.push(item);
            if (deduped.length >= limit) break;
        }

        return deduped;
    } catch (_err) {
        return [];
    }
}

function parseSeasonEpisodeFromTitle(title) {
    const raw = String(title || '');
    const sxeMatches = Array.from(raw.matchAll(/s(\d{1,2})\s*e(\d{1,2})/gi));
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

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return null;
    return `tt${cleaned}`;
}

function inferQualityLabel(title) {
    const name = String(title || '').toLowerCase();
    if (/\b(2160p|4k|uhd)\b/.test(name)) return '2160p';
    if (/\b1080p\b/.test(name)) return '1080p';
    if (/\b720p\b/.test(name)) return '720p';
    if (/\b480p\b/.test(name)) return '480p';
    return 'unknown';
}

function formatSizeLabel(sizeBytes) {
    const bytes = Number(sizeBytes);
    if (!Number.isFinite(bytes) || bytes <= 0) return 'N/A';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 ** 2);
    return `${mb.toFixed(1)} MB`;
}

function normalizeSearchResultRow(row) {
    const title = String(
        row?.fileName || row?.name || row?.title || row?.filename || ''
    ).trim();
    const sizeBytes = parseFloatSafe(row?.fileSize ?? row?.size ?? row?.size_bytes, 0);
    const seeds = parseIntSafe(row?.nbSeeders ?? row?.seeds ?? row?.seeders, 0);
    const peers = parseIntSafe(row?.nbLeechers ?? row?.peers ?? row?.leechers, 0);
    const fileUrl = String(row?.fileUrl || row?.url || row?.magnet || '').trim();
    const siteUrl = String(row?.siteUrl || row?.site || '').trim();
    const descrLink = String(row?.descrLink || row?.description || '').trim();
    const pubDate = String(row?.pubDate || row?.date || '').trim();
    const parsed = parseSeasonEpisodeFromTitle(title);

    return {
        title,
        sizeBytes,
        sizeLabel: formatSizeLabel(sizeBytes),
        seeds,
        peers,
        quality: inferQualityLabel(title),
        season: parsed.season,
        episode: parsed.episode,
        source: siteUrl || 'unknown',
        fileUrl,
        magnetUrl: fileUrl,
        descrLink,
        pubDate,
        raw: row
    };
}

function buildFilterObject(query = {}) {
    const text = String(query.text || '').trim();
    const imdbId = normalizeImdbId(query.imdbId) || null;
    const season = parseIntSafe(query.season, null);
    const episode = parseIntSafe(query.episode, null);
    const minSeeds = Math.max(0, parseIntSafe(query.minSeeds, 0));
    const minSizeMb = Math.max(0, parseFloatSafe(query.minSizeMb, 0));
    const maxSizeMb = Math.max(0, parseFloatSafe(query.maxSizeMb, 0));
    const quality = String(query.quality || '').trim().toLowerCase();
    const source = String(query.source || '').trim().toLowerCase();
    const mustContain = String(query.mustContain || '').trim().toLowerCase();
    const excludeWords = String(query.excludeWords || '').trim().toLowerCase();

    return {
        text,
        imdbId,
        season: Number.isFinite(season) && season > 0 ? season : null,
        episode: Number.isFinite(episode) && episode > 0 ? episode : null,
        minSeeds,
        minSizeBytes: minSizeMb > 0 ? minSizeMb * 1024 * 1024 : 0,
        maxSizeBytes: maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : 0,
        quality: ['2160p', '1080p', '720p', '480p', 'unknown'].includes(quality) ? quality : '',
        source,
        mustContain,
        excludeWords
    };
}

function applySearchFilters(rows, filters) {
    const tokens = normalizeText(filters.text).split(' ').filter(Boolean);
    const mustTokens = normalizeText(filters.mustContain).split(' ').filter(Boolean);
    const excludeTokens = normalizeText(filters.excludeWords).split(' ').filter(Boolean);
    const imdbToken = filters.imdbId ? filters.imdbId.toLowerCase().replace(/^tt/, '') : '';

    return rows.filter((row) => {
        const haystack = normalizeText(`${row.title} ${row.source} ${row.descrLink}`);

        if (tokens.length && !tokens.every(t => haystack.includes(t))) return false;
        if (mustTokens.length && !mustTokens.every(t => haystack.includes(t))) return false;
        if (excludeTokens.length && excludeTokens.some(t => haystack.includes(t))) return false;

        if (imdbToken) {
            const imdbHaystack = `${haystack} ${String(row.fileUrl || '').toLowerCase()} ${String(row.descrLink || '').toLowerCase()}`;
            if (!imdbHaystack.includes(imdbToken)) return false;
        }

        if (filters.season && row.season !== filters.season) return false;
        if (filters.episode && row.episode !== filters.episode) return false;
        if (filters.minSeeds && row.seeds < filters.minSeeds) return false;
        if (filters.minSizeBytes && row.sizeBytes < filters.minSizeBytes) return false;
        if (filters.maxSizeBytes && row.sizeBytes > filters.maxSizeBytes) return false;
        if (filters.quality && row.quality !== filters.quality) return false;
        if (filters.source && !String(row.source || '').toLowerCase().includes(filters.source)) return false;

        return true;
    });
}

function rankSearchRows(rows, filters) {
    const textTokens = normalizeText(filters.text).split(' ').filter(Boolean);

    return [...rows].sort((a, b) => {
        const score = (row) => {
            const haystack = normalizeText(row.title || '');
            const textMatches = textTokens.reduce((acc, token) => acc + (haystack.includes(token) ? 1 : 0), 0);
            const seasonBonus = (filters.season && row.season === filters.season) ? 60 : 0;
            const episodeBonus = (filters.episode && row.episode === filters.episode) ? 50 : 0;
            const qualityBonus = row.quality === '2160p' ? 18 : (row.quality === '1080p' ? 10 : 0);
            return (row.seeds * 10) + (row.peers * 4) + (textMatches * 20) + seasonBonus + episodeBonus + qualityBonus;
        };

        const delta = score(b) - score(a);
        if (delta !== 0) return delta;
        return a.title.localeCompare(b.title);
    });
}

function resolveSearchApiUrl() {
    let raw = String(process.env.QBIT_SEARCH_URL || process.env.QBIT_API_URL || process.env.QBIT_URL || 'http://qbittorrent:8080').trim();
    raw = raw.replace(/\/+$/, '');
    if (raw.endsWith('/api/v2')) return raw;
    if (raw.endsWith('/search')) raw = raw.slice(0, -('/search'.length));
    return `${raw}/api/v2`;
}

function isQbitUpstreamError(err) {
    const code = String(err?.code || '').toUpperCase();
    const message = String(err?.message || '').toLowerCase();
    return (
        code === 'EAI_AGAIN' ||
        code === 'ENOTFOUND' ||
        code === 'ECONNREFUSED' ||
        message.includes('eai_again') ||
        message.includes('enotfound') ||
        message.includes('econnrefused')
    );
}

function searchErrorResponse(err) {
    const upstreamStatus = parseIntSafe(err?.upstreamStatus, 0);
    const upstreamAction = String(err?.upstreamAction || '');

    if (upstreamStatus === 404 && (upstreamAction === 'search/status' || upstreamAction === 'search/results')) {
        return {
            status: 502,
            payload: {
                success: false,
                error: 'qBittorrent started a search id but does not track it (status/results return 404).',
                code: 'QBIT_SEARCH_JOB_NOT_TRACKED',
                upstreamStatus,
                upstreamAction,
                qbitApiUrl: resolveSearchApiUrl(),
                upstreamMessage: String(err?.message || ''),
                hint: 'Check qBittorrent Execution Log for search engine/plugin failures. Search plugins can be installed/enabled but still fail at runtime and jobs may disappear immediately.'
            }
        };
    }

    if (isQbitUpstreamError(err)) {
        return {
            status: 503,
            payload: {
                success: false,
                error: 'qBittorrent search API unreachable from this runtime.',
                code: String(err?.code || 'UPSTREAM_UNAVAILABLE'),
                qbitApiUrl: resolveSearchApiUrl(),
                upstreamStatus: err?.upstreamStatus || null,
                upstreamAction: err?.upstreamAction || null,
                upstreamMessage: String(err?.message || '')
            }
        };
    }

    return {
        status: 500,
        payload: {
            success: false,
            error: err.message
        }
    };
}

router.get('/health', async (_req, res) => {
    return res.json({
        success: true,
        provider: TorrentSearchService.getActiveProviderName(),
        providers: TorrentSearchService.listProviders(),
        qbitSearchApi: resolveSearchApiUrl()
    });
});

router.get('/internal/resolve', async (req, res) => {
    try {
        const query = String(req.query.q || req.query.query || '').trim();
        const lookupQuery = sanitizeLookupQuery(query) || query;
        const limit = Math.max(1, Math.min(parseIntSafe(req.query.limit, 12), 50));
        const preferredType = String(req.query.mediaType || 'auto').trim().toLowerCase();
        const imdbHint = normalizeImdbLoose(req.query.imdbId || '');

        if (!query && !imdbHint) {
            return res.status(400).json({ success: false, error: 'query or imdbId is required.' });
        }

        const tvCandidates = lookupQuery
            ? searchTvIndex(lookupQuery, Math.max(limit * 2, 20)).map(item => ({
                mediaType: 'series',
                imdbId: normalizeImdbLoose(item.imdbId || ''),
                title: item.title,
                originalTitle: item.originalTitle,
                startYear: item.startYear,
                endYear: item.endYear,
                episodeCount: Number(item.episodeCount || 0) || 0,
                averageRating: Number(item.averageRating || 0) || 0,
                numVotes: Number(item.numVotes || 0) || 0,
                source: 'tv-local-index'
            }))
            : [];

        const movieCandidates = lookupQuery
            ? MovieTitleIndexService.searchIndex(lookupQuery, Math.max(limit * 2, 20)).map(item => ({
                mediaType: 'movie',
                imdbId: normalizeImdbLoose(item.imdbId || ''),
                title: item.title,
                year: item.year,
                rating: Number(item.rating || 0) || 0,
                votes: Number(item.votes || 0) || 0,
                genres: item.genres || [],
                source: 'movie-local-index'
            }))
            : [];

        let combined = [...tvCandidates, ...movieCandidates].filter(row => row.imdbId && row.title);

        if (imdbHint) {
            const tvByImdb = getSeriesByImdbId(imdbHint);
            const movieByImdb = MovieTitleIndexService.getByImdbId(imdbHint);
            if (tvByImdb) {
                combined.unshift({
                    mediaType: 'series',
                    imdbId: normalizeImdbLoose(tvByImdb.imdbId || ''),
                    title: tvByImdb.title,
                    originalTitle: tvByImdb.originalTitle,
                    startYear: tvByImdb.startYear,
                    endYear: tvByImdb.endYear,
                    episodeCount: Number(tvByImdb.episodeCount || 0) || 0,
                    averageRating: Number(tvByImdb.averageRating || 0) || 0,
                    numVotes: Number(tvByImdb.numVotes || 0) || 0,
                    source: 'tv-local-index'
                });
            }
            if (movieByImdb) {
                combined.unshift({
                    mediaType: 'movie',
                    imdbId: normalizeImdbLoose(movieByImdb.imdbId || ''),
                    title: movieByImdb.title,
                    year: movieByImdb.year,
                    rating: Number(movieByImdb.rating || 0) || 0,
                    votes: Number(movieByImdb.votes || 0) || 0,
                    genres: movieByImdb.genres || [],
                    source: 'movie-local-index'
                });
            }
        }

        if (combined.length === 0 && lookupQuery) {
            const fallback = await searchOmdbFallback(lookupQuery, Math.max(limit, 8));
            combined = [...combined, ...fallback];
        }

        const deduped = [];
        const seen = new Set();
        for (const row of combined) {
            const key = `${row.mediaType}:${row.imdbId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(row);
        }

        const ranked = deduped
            .map(candidate => ({
                ...candidate,
                score: scoreTitleCandidate({ candidate, query: lookupQuery, imdbHint, preferredType })
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        return res.json({
            success: true,
            query,
            lookupQuery,
            imdbHint: imdbHint || null,
            preferredType,
            count: ranked.length,
            candidates: ranked
        });
    } catch (err) {
        logger.error(`[TorrentSearch] Internal resolve failed: ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/plugins', async (_req, res) => {
    try {
        const plugins = await TorrentSearchService.getPlugins();
        return res.json({ success: true, count: plugins.length, plugins });
    } catch (err) {
        logger.error(`[TorrentSearch] Plugin query failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

router.post('/start', async (req, res) => {
    try {
        const query = String(req.body?.query || '').trim();
        const category = String(req.body?.category || 'all').trim();
        const plugins = String(req.body?.plugins || 'all').trim();

        if (!query) {
            return res.status(400).json({ success: false, error: 'query is required.' });
        }

        const started = await TorrentSearchService.startSearch({ query, category, plugins });
        return res.json({
            success: true,
            searchId: started.id,
            query,
            category,
            plugins,
            provider: TorrentSearchService.getActiveProviderName(),
            raw: started.raw
        });
    } catch (err) {
        logger.error(`[TorrentSearch] Start failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

router.get('/status', async (req, res) => {
    try {
        const id = req.query?.id;
        const statuses = await TorrentSearchService.getStatus(id);
        return res.json({ success: true, statuses });
    } catch (err) {
        logger.error(`[TorrentSearch] Status failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

router.get('/results', async (req, res) => {
    try {
        const id = parseIntSafe(req.query?.id, null);
        if (id === null) {
            return res.status(400).json({ success: false, error: 'id is required.' });
        }

        const limit = Math.max(1, Math.min(500, parseIntSafe(req.query?.limit, 200)));
        const offset = Math.max(0, parseIntSafe(req.query?.offset, 0));
        const filters = buildFilterObject(req.query || {});

        const result = await TorrentSearchService.getResults(id, { limit, offset });
        const normalizedRaw = result.results.map(normalizeSearchResultRow);
        const filtered = applySearchFilters(normalizedRaw, filters);
        const rankedFiltered = rankSearchRows(filtered, filters);

        return res.json({
            success: true,
            searchId: id,
            status: result.status,
            total: result.total,
            page: { limit, offset },
            filters,
            counts: {
                raw: normalizedRaw.length,
                filtered: rankedFiltered.length
            },
            raw: normalizedRaw,
            filtered: rankedFiltered
        });
    } catch (err) {
        logger.error(`[TorrentSearch] Results failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

router.post('/delete', async (req, res) => {
    try {
        const id = req.body?.id !== undefined ? req.body.id : 'all';
        const deleted = await TorrentSearchService.deleteSearch(id);
        return res.json({ success: true, deleted });
    } catch (err) {
        logger.error(`[TorrentSearch] Delete failed: ${err.message}`);
        const out = searchErrorResponse(err);
        return res.status(out.status).json(out.payload);
    }
});

module.exports = router;
