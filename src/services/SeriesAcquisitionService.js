const axios = require('axios');
const TorrentSearchService = require('./TorrentSearchService');

function normalizeDisplayTitle(value = '') {
    return String(value || '')
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTitleForCompare(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return null;
    return `tt${cleaned}`;
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

function looksLikeSeasonPack(title) {
    return /(season\s*pack|\bcomplete\b|s\d{1,2}\s*complete|seasons?\s*\d+\s*-\s*\d+|\[pack\]|\bpack\b)/i.test(String(title || ''));
}

function buildAutoSeriesSearchQuery(showTitle, season = null, episode = null, sourceType = 'episode') {
    const title = normalizeDisplayTitle(showTitle || '');
    const s = Number.isFinite(parseInt(season, 10)) && parseInt(season, 10) > 0 ? parseInt(season, 10) : null;
    const e = Number.isFinite(parseInt(episode, 10)) && parseInt(episode, 10) > 0 ? parseInt(episode, 10) : null;
    const source = String(sourceType || '').trim().toLowerCase();

    if (s && e) {
        return `${title} S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`.trim();
    }
    if (s && source === 'pack') {
        return `${title} S${String(s).padStart(2, '0')} season pack complete`.trim();
    }
    if (s) {
        return `${title} season ${s}`.trim();
    }
    return title;
}

function parseIntSafe(value, fallback = 0) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatSafe(value, fallback = 0) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function inferQualityLabel(title) {
    const name = String(title || '').toLowerCase();
    if (/\b(2160p|4k|uhd)\b/.test(name)) return '2160p';
    if (/\b1080p\b/.test(name)) return '1080p';
    if (/\b720p\b/.test(name)) return '720p';
    if (/\b480p\b/.test(name)) return '480p';
    return 'unknown';
}

function mapRawSearchRow(raw = {}) {
    const title = String(raw?.fileName || raw?.title || raw?.name || '').trim();
    const magnetUrl = String(raw?.fileUrl || raw?.magnet || raw?.url || '').trim();
    const seeds = parseInt(raw?.nbSeeders ?? raw?.seeds ?? 0, 10) || 0;
    const peers = parseInt(raw?.nbLeechers ?? raw?.peers ?? 0, 10) || 0;
    const sizeBytes = parseFloat(raw?.fileSize ?? raw?.size ?? 0) || 0;
    const source = String(raw?.siteUrl || raw?.site || '').trim();
    const parsed = parseSeasonEpisodeFromTitle(title);
    const sourceType = looksLikeSeasonPack(title) ? 'pack' : 'episode';

    return {
        title,
        magnetUrl,
        seeds,
        peers,
        sizeBytes,
        source,
        season: parsed.season,
        episode: parsed.episode,
        quality: inferQualityLabel(title),
        sourceType,
        raw
    };
}

function scoreAutoSeriesCandidate(candidate, context = {}) {
    const targetTitle = normalizeTitleForCompare(context.showTitle || '');
    const titleNorm = normalizeTitleForCompare(candidate.title || '');
    const imdbDigits = String(context.imdbId || '').replace(/^tt/i, '');
    const combined = `${titleNorm} ${String(candidate.source || '').toLowerCase()} ${String(candidate.magnetUrl || '').toLowerCase()}`;
    const titleTokens = targetTitle.split(' ').filter(Boolean);

    let score = 0;

    if (titleNorm && targetTitle && titleNorm.includes(targetTitle)) score += 140;
    for (const token of titleTokens) {
        if (token.length < 2) continue;
        if (titleNorm.includes(token)) score += 14;
    }

    const season = Number.isFinite(parseInt(context.season, 10)) ? parseInt(context.season, 10) : null;
    const episode = Number.isFinite(parseInt(context.episode, 10)) ? parseInt(context.episode, 10) : null;
    const sourceType = String(context.sourceType || '').toLowerCase();

    if (sourceType === 'pack' && candidate.sourceType !== 'pack') {
        return Number.NEGATIVE_INFINITY;
    }

    if (season && candidate.season === season) score += 90;
    if (season && candidate.season && candidate.season !== season) score -= 140;

    if (episode && candidate.episode === episode) score += 130;
    if (episode && candidate.episode && candidate.episode !== episode) score -= 180;

    if (sourceType === 'pack' && season && candidate.season === season && !candidate.episode) score += 60;
    if (sourceType === 'pack' && candidate.episode) score -= 50;

    if (imdbDigits && combined.includes(imdbDigits)) score += 85;

    score += Math.min(220, candidate.seeds * 5);
    score += Math.min(60, candidate.peers * 2);

    if (candidate.quality === '2160p') score += 18;
    else if (candidate.quality === '1080p') score += 14;
    else if (candidate.quality === '720p') score += 8;

    return score;
}

function pickBestAutoSeriesCandidate(rows = [], context = {}) {
    const candidates = rows
        .map(mapRawSearchRow)
        .filter((row) => row.title && row.magnetUrl && row.magnetUrl.startsWith('magnet:?'))
        .filter((row) => String(context.sourceType || '').toLowerCase() !== 'pack' || row.sourceType === 'pack')
        .map((row) => ({
            ...row,
            confidenceScore: scoreAutoSeriesCandidate(row, context)
        }))
        .filter((row) => Number.isFinite(row.confidenceScore) && row.confidenceScore > Number.NEGATIVE_INFINITY)
        .sort((a, b) => b.confidenceScore - a.confidenceScore);

    return {
        best: candidates[0] || null,
        candidates
    };
}

async function collectAutoSeriesSearchCandidates(searchId, context = {}, options = {}) {
    const maxWaitMs = Math.max(10000, Math.min(parseInt(options.maxWaitMs, 10) || 35000, 120000));
    const minWaitMs = Math.max(3000, Math.min(parseInt(options.minWaitMs, 10) || 12000, maxWaitMs));
    const pollMs = Math.max(800, Math.min(parseInt(options.pollMs, 10) || 1800, 7000));
    const settleWindowMs = Math.max(3000, Math.min(parseInt(options.settleWindowMs, 10) || 8000, maxWaitMs));
    const resultLimit = Math.max(80, Math.min(parseInt(options.resultLimit, 10) || 500, 1000));

    const startedAt = Date.now();
    let lastImprovementAt = startedAt;
    let lastStatus = 'unknown';
    let sampleCount = 0;

    let bestScore = Number.NEGATIVE_INFINITY;
    let best = null;
    let candidates = [];

    while (true) {
        sampleCount += 1;

        const [statuses, searchResult] = await Promise.all([
            TorrentSearchService.getStatus(searchId).catch(() => []),
            TorrentSearchService.getResults(searchId, { limit: resultLimit, offset: 0 }).catch(() => ({ results: [] }))
        ]);

        const row = Array.isArray(statuses)
            ? statuses.find((item) => Number(item?.id) === Number(searchId))
            : null;
        lastStatus = String(row?.status || '').toLowerCase() || 'unknown';

        const rawRows = Array.isArray(searchResult?.results) ? searchResult.results : [];
        const scored = pickBestAutoSeriesCandidate(rawRows, context);
        const currentBest = scored.best;
        const currentScore = Number(currentBest?.confidenceScore || Number.NEGATIVE_INFINITY);
        const totalCandidates = scored.candidates.length;

        if (currentBest && (currentScore > bestScore || totalCandidates > candidates.length)) {
            bestScore = currentScore;
            best = currentBest;
            candidates = scored.candidates;
            lastImprovementAt = Date.now();
        } else if (!best && currentBest) {
            bestScore = currentScore;
            best = currentBest;
            candidates = scored.candidates;
            lastImprovementAt = Date.now();
        }

        const now = Date.now();
        const elapsedMs = now - startedAt;
        const idleMs = now - lastImprovementAt;
        const terminalStatus = lastStatus === 'stopped' || lastStatus === 'error' || lastStatus === 'missingfiles';

        const readyBySettleWindow = elapsedMs >= minWaitMs && idleMs >= settleWindowMs && Boolean(best);
        const readyByTerminal = terminalStatus && elapsedMs >= minWaitMs && Boolean(best);
        const readyByTimeout = elapsedMs >= maxWaitMs;

        if (readyBySettleWindow || readyByTerminal || readyByTimeout) {
            return {
                best,
                candidates,
                stats: {
                    status: lastStatus,
                    sampleCount,
                    elapsedMs,
                    idleMs,
                    maxWaitMs,
                    minWaitMs,
                    settleWindowMs
                }
            };
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

async function fetchEztvPages(imdbId, maxPages = 5) {
    const endpointCandidates = [
        'https://eztv.wf/api/get-torrents',
        'https://eztv.re/api/get-torrents'
    ];

    const collected = [];
    const upstreamWarnings = [];
    let scannedPages = 0;

    for (let page = 1; page <= maxPages; page++) {
        scannedPages += 1;
        let pageData = null;
        let lastError = null;

        for (const endpoint of endpointCandidates) {
            try {
                const response = await axios.get(`${endpoint}?imdb_id=${imdbId}&limit=100&page=${page}`, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (MovieStreamer/1.0)',
                        'Accept': 'application/json,text/plain,*/*'
                    }
                });

                if (Array.isArray(response.data?.torrents)) {
                    pageData = response.data.torrents;
                    break;
                }
                lastError = new Error(`Invalid payload from ${endpoint}`);
            } catch (err) {
                lastError = err;
            }
        }

        if (!pageData) {
            upstreamWarnings.push(`Page ${page} unavailable: ${lastError ? lastError.message : 'unknown upstream error'}`);
            break;
        }

        collected.push(...pageData);
        if (pageData.length < 100) break;
    }

    return {
        torrents: collected,
        scannedPages,
        upstreamWarnings
    };
}

async function selectBestEztvAutoCandidate({ imdbId, season = null, episode = null, sourceType = 'episode' } = {}) {
    const normalizedImdb = normalizeImdbId(imdbId);
    if (!normalizedImdb) {
        return { best: null, diagnostics: { reason: 'missing_imdb' } };
    }

    const imdbDigits = String(normalizedImdb).replace(/^tt/i, '');
    const packsOnly = String(sourceType || '').toLowerCase() === 'pack';
    const seasonNum = Number.isFinite(parseInt(season, 10)) ? parseInt(season, 10) : null;
    const episodeNum = Number.isFinite(parseInt(episode, 10)) ? parseInt(episode, 10) : null;

    const fetched = await fetchEztvPages(imdbDigits, 5);
    const rows = Array.isArray(fetched.torrents) ? fetched.torrents : [];

    const exact = rows
        .map((row) => {
            const title = String(row.title || row.filename || '').trim();
            const parsed = parseSeasonEpisodeFromTitle(title);
            const seasonRaw = parseInt(row.season, 10);
            const episodeRaw = parseInt(row.episode, 10);
            const seasonValue = Number.isFinite(seasonRaw) ? seasonRaw : parsed.season;
            const episodeValue = Number.isFinite(episodeRaw) ? episodeRaw : parsed.episode;
            const rowType = looksLikeSeasonPack(title) ? 'pack' : 'episode';
            if (!Number.isFinite(seasonValue) || !seasonNum || seasonValue !== seasonNum) return null;
            if (packsOnly) return rowType === 'pack' ? { ...row, title, season: seasonValue, episode: Number.isFinite(episodeValue) ? episodeValue : null, sourceType: rowType } : null;
            return rowType === 'episode' && Number.isFinite(episodeValue) && episodeValue === episodeNum
                ? { ...row, title, season: seasonValue, episode: episodeValue, sourceType: rowType }
                : null;
        })
        .filter(Boolean);

    const seededExact = exact.filter((row) => (parseInt(row?.seeds, 10) || 0) > 0);
    const pool = seededExact.length ? seededExact : exact;
    const best = pool.length
        ? [...pool].sort((a, b) => (parseInt(b?.seeds, 10) || 0) - (parseInt(a?.seeds, 10) || 0))[0]
        : null;

    return {
        best: best ? {
            title: String(best.title || best.filename || '').trim(),
            originalTitle: String(best.title || best.filename || '').trim(),
            sourceType: best.sourceType || (packsOnly ? 'pack' : 'episode'),
            seeds: parseInt(best.seeds, 10) || 0,
            peers: parseInt(best.peers, 10) || 0,
            season: parseInt(best.season, 10) || seasonNum,
            episode: Number.isFinite(parseInt(best.episode, 10)) ? parseInt(best.episode, 10) : null,
            magnet: String(best.magnet_url || best.magnet || `magnet:?xt=urn:btih:${best.hash}&dn=${encodeURIComponent(best.title || best.filename || '')}`)
        } : null,
        diagnostics: {
            imdbId: normalizedImdb,
            packsOnly,
            season: seasonNum,
            episode: episodeNum,
            rawCount: rows.length,
            exactCount: exact.length,
            seededExactCount: seededExact.length,
            upstreamWarnings: fetched.upstreamWarnings || []
        }
    };
}

async function resolveAutoSeriesAcquisition(intent = {}) {
    const showTitle = normalizeDisplayTitle(intent.showTitle || intent.title || '');
    const imdbId = normalizeImdbId(intent.imdbId);
    const seasonNum = Number.isFinite(parseInt(intent.season, 10)) && parseInt(intent.season, 10) > 0 ? parseInt(intent.season, 10) : null;
    const episodeNum = Number.isFinite(parseInt(intent.episode, 10)) && parseInt(intent.episode, 10) > 0 ? parseInt(intent.episode, 10) : null;
    const sourceType = String(intent.sourceType || '').toLowerCase() === 'pack' ? 'pack' : 'episode';
    const query = buildAutoSeriesSearchQuery(showTitle || imdbId || '', seasonNum, episodeNum, sourceType);

    const eztvSelection = await selectBestEztvAutoCandidate({
        imdbId,
        season: seasonNum,
        episode: episodeNum,
        sourceType
    });

    if (eztvSelection?.best?.magnet) {
        return {
            success: true,
            query,
            selected: {
                title: eztvSelection.best.originalTitle || eztvSelection.best.title || 'EZTV release',
                seeds: parseInt(eztvSelection.best.seeds, 10) || 0,
                peers: parseInt(eztvSelection.best.peers, 10) || 0,
                season: parseInt(eztvSelection.best.season, 10) || null,
                episode: parseInt(eztvSelection.best.episode, 10) || null,
                source: 'eztv'
            },
            searchStats: { source: 'eztv', diagnostics: eztvSelection.diagnostics },
            magnetUrl: String(eztvSelection.best.magnet || '').trim(),
            source: 'eztv'
        };
    }

    const started = await TorrentSearchService.startSearch({
        query,
        category: String(intent.category || 'tv').trim() || 'tv',
        plugins: String(intent.plugins || 'enabled').trim() || 'enabled'
    });

    const searchId = started?.id || null;
    if (!searchId) {
        return {
            success: false,
            query,
            error: 'Search did not return a valid id.'
        };
    }

    const collected = await collectAutoSeriesSearchCandidates(searchId, {
        showTitle,
        imdbId,
        season: seasonNum,
        episode: episodeNum,
        sourceType
    }, {
        maxWaitMs: Number.isFinite(parseInt(intent.timeoutMs, 10)) ? parseInt(intent.timeoutMs, 10) : undefined,
        minWaitMs: parseInt(process.env.AUTO_SEARCH_MIN_WAIT_MS || '12000', 10),
        pollMs: parseInt(process.env.AUTO_SEARCH_POLL_MS || '1800', 10),
        settleWindowMs: parseInt(process.env.AUTO_SEARCH_SETTLE_MS || '8000', 10),
        resultLimit: parseInt(process.env.AUTO_SEARCH_RESULT_LIMIT || '500', 10)
    });

    const scored = {
        best: collected.best,
        candidates: Array.isArray(collected.candidates) ? collected.candidates : []
    };
    const threshold = Number.isFinite(parseFloat(intent.minScore)) ? parseFloat(intent.minScore) : 90;
    const seededExactSearchFallback = scored.candidates.find((row) => {
        const rowSeason = Number.isFinite(parseInt(row?.season, 10)) ? parseInt(row.season, 10) : null;
        const rowEpisode = Number.isFinite(parseInt(row?.episode, 10)) ? parseInt(row.episode, 10) : null;
        const seeds = parseInt(row?.seeds, 10) || 0;
        if (seeds <= 0) return false;
        if (!seasonNum || rowSeason !== seasonNum) return false;
        if (sourceType === 'pack') return !rowEpisode;
        return Boolean(episodeNum && rowEpisode === episodeNum);
    }) || null;

    const selectedSearchCandidate = (scored.best && Number(scored.best.confidenceScore || 0) >= threshold)
        ? scored.best
        : seededExactSearchFallback;

    if (!selectedSearchCandidate || !selectedSearchCandidate.magnetUrl) {
        return {
            success: false,
            query,
            searchId,
            searchStats: collected.stats,
            error: 'No confident search result found for automatic queueing.',
            candidates: scored.candidates.slice(0, 5).map((row) => ({
                title: row.title,
                seeds: row.seeds,
                peers: row.peers,
                score: row.confidenceScore,
                season: row.season,
                episode: row.episode,
                quality: row.quality
            }))
        };
    }

    const selectionSource = selectedSearchCandidate === seededExactSearchFallback
        ? 'search-seeded-exact-fallback'
        : 'search-confidence';

    return {
        success: true,
        query,
        searchId,
        searchStats: collected.stats,
        selected: {
            title: selectedSearchCandidate.title,
            seeds: selectedSearchCandidate.seeds,
            peers: selectedSearchCandidate.peers,
            score: selectedSearchCandidate.confidenceScore,
            season: selectedSearchCandidate.season,
            episode: selectedSearchCandidate.episode,
            quality: selectedSearchCandidate.quality,
            source: selectionSource
        },
        magnetUrl: String(selectedSearchCandidate.magnetUrl || '').trim(),
        source: selectionSource
    };
}

module.exports = {
    buildAutoSeriesSearchQuery,
    resolveAutoSeriesAcquisition,
    selectBestEztvAutoCandidate
};