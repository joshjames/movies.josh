const TorrentSearchService = require('./TorrentSearchService');
const EztvCatalogService = require('./EztvCatalogService');
const logger = require('./logger');

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

function shouldAllow2160(context = {}) {
    const explicit = String(context?.allow2160 ?? context?.allow4k ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(explicit)) return true;
    if (['0', 'false', 'no', 'off'].includes(explicit)) return false;

    const env = String(process.env.AUTO_SERIES_ALLOW_2160 || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(env);
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

// Returns { score, reasons } instead of a bare number - reasons is a
// human-readable trail of every rule that fired and what it contributed,
// so a candidate's final score can actually be explained (not just
// observed) when tuning confidence for a specific show/query. Logged by
// pickBestAutoSeriesCandidate's caller, not printed here.
function scoreAutoSeriesCandidate(candidate, context = {}) {
    const reasons = [];
    const targetTitle = normalizeTitleForCompare(context.showTitle || '');
    const titleNorm = normalizeTitleForCompare(candidate.title || '');
    const imdbDigits = String(context.imdbId || '').replace(/^tt/i, '');
    const combined = `${titleNorm} ${String(candidate.source || '').toLowerCase()} ${String(candidate.magnetUrl || '').toLowerCase()}`;
    const titleTokens = targetTitle.split(' ').filter(Boolean);

    let score = 0;

    if (titleNorm && targetTitle && titleNorm.includes(targetTitle)) {
        score += 140;
        reasons.push('+140 full title match');
    }
    let tokenBonus = 0;
    for (const token of titleTokens) {
        if (token.length < 2) continue;
        if (titleNorm.includes(token)) tokenBonus += 14;
    }
    if (tokenBonus) {
        score += tokenBonus;
        reasons.push(`+${tokenBonus} title token matches`);
    }

    const season = Number.isFinite(parseInt(context.season, 10)) ? parseInt(context.season, 10) : null;
    const episode = Number.isFinite(parseInt(context.episode, 10)) ? parseInt(context.episode, 10) : null;
    const sourceType = String(context.sourceType || '').toLowerCase();
    const allow2160 = Boolean(context.allow2160);

    if (!allow2160 && candidate.quality === '2160p') {
        reasons.push('REJECT: 2160p not allowed for this request');
        return { score: Number.NEGATIVE_INFINITY, reasons };
    }

    if (sourceType === 'pack' && candidate.sourceType !== 'pack') {
        reasons.push(`REJECT: pack requested but row parsed as sourceType=${candidate.sourceType}`);
        return { score: Number.NEGATIVE_INFINITY, reasons };
    }

    if (season && candidate.season === season) {
        score += 90;
        reasons.push('+90 season match');
    }
    if (season && candidate.season && candidate.season !== season) {
        score -= 140;
        reasons.push(`-140 season mismatch (wanted S${season}, row is S${candidate.season})`);
    }

    if (episode && candidate.episode === episode) {
        score += 130;
        reasons.push('+130 episode match');
    }
    if (episode && candidate.episode && candidate.episode !== episode) {
        score -= 180;
        reasons.push(`-180 episode mismatch (wanted E${episode}, row is E${candidate.episode})`);
    }

    if (sourceType === 'pack' && season && candidate.season === season && !candidate.episode) {
        score += 60;
        reasons.push('+60 pack shape (season matches, no episode number parsed)');
    }
    if (sourceType === 'pack' && candidate.episode) {
        score -= 50;
        reasons.push(`-50 pack requested but row has an episode number (E${candidate.episode})`);
    }

    if (imdbDigits && combined.includes(imdbDigits)) {
        score += 85;
        reasons.push('+85 imdb id present in title/source');
    }

    const seedBonus = Math.min(220, candidate.seeds * 5);
    if (seedBonus) {
        score += seedBonus;
        reasons.push(`+${seedBonus} seeds (${candidate.seeds})`);
    }
    const peerBonus = Math.min(60, candidate.peers * 2);
    if (peerBonus) {
        score += peerBonus;
        reasons.push(`+${peerBonus} peers (${candidate.peers})`);
    }

    if (candidate.quality === '2160p') {
        score += 18;
        reasons.push('+18 quality 2160p');
    } else if (candidate.quality === '1080p') {
        score += 14;
        reasons.push('+14 quality 1080p');
    } else if (candidate.quality === '720p') {
        score += 8;
        reasons.push('+8 quality 720p');
    }

    return { score, reasons };
}

// stats gives visibility into how the raw plugin-result pool got whittled
// down to a scored candidate list - essential for telling apart "the
// search plugins just didn't return any real season packs" from "packs
// came back but none scored well enough", which look identical from the
// outside (both end in "no confident result") but need completely
// different fixes.
function pickBestAutoSeriesCandidate(rows = [], context = {}) {
    const packsOnly = String(context.sourceType || '').toLowerCase() === 'pack';
    const mapped = rows.map(mapRawSearchRow);
    const totalRaw = mapped.length;
    const packRaw = mapped.filter((row) => row.sourceType === 'pack').length;
    const episodeRaw = mapped.filter((row) => row.sourceType === 'episode').length;

    const withMagnet = mapped.filter((row) => row.title && row.magnetUrl && row.magnetUrl.startsWith('magnet:?'));
    const qualityFiltered = withMagnet.filter((row) => Boolean(context.allow2160) || row.quality !== '2160p');
    const typeFiltered = qualityFiltered.filter((row) => !packsOnly || row.sourceType === 'pack');

    const scored = typeFiltered.map((row) => {
        const result = scoreAutoSeriesCandidate(row, context);
        return { ...row, confidenceScore: result.score, scoreReasons: result.reasons };
    });

    const candidates = scored
        .filter((row) => Number.isFinite(row.confidenceScore) && row.confidenceScore > Number.NEGATIVE_INFINITY)
        .sort((a, b) => b.confidenceScore - a.confidenceScore);

    return {
        best: candidates[0] || null,
        candidates,
        stats: {
            totalRaw,
            packRaw,
            episodeRaw,
            missingMagnet: mapped.length - withMagnet.length,
            excluded2160: withMagnet.length - qualityFiltered.length,
            excludedWrongType: qualityFiltered.length - typeFiltered.length,
            hardRejected: typeFiltered.length - candidates.length
        }
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
    let lastPoolStats = null;

    logger.debug(`[AutoAcquire][Search] Polling started | searchId=${searchId} sourceType=${context.sourceType || 'episode'} season=${context.season ?? '-'} episode=${context.episode ?? '-'} maxWaitMs=${maxWaitMs} minWaitMs=${minWaitMs} pollMs=${pollMs} settleWindowMs=${settleWindowMs}`);

    while (true) {
        sampleCount += 1;

        const [statusOutcome, resultsOutcome] = await Promise.all([
            TorrentSearchService.getStatus(searchId).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error })),
            TorrentSearchService.getResults(searchId, { limit: resultLimit, offset: 0 }).then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error }))
        ]);

        // Previously swallowed into an empty fallback with zero logging -
        // an auth/host failure on the search plugin backend looked
        // identical to "the search just hasn't found anything yet" from
        // outside this loop. Now surfaced explicitly (TorrentService.js's
        // requestSearch also logs the underlying transport failure).
        if (!statusOutcome.ok) {
            logger.warn(`[AutoAcquire][Search] poll #${sampleCount} status check failed | searchId=${searchId} error="${statusOutcome.error.message}"`);
        }
        if (!resultsOutcome.ok) {
            logger.warn(`[AutoAcquire][Search] poll #${sampleCount} results fetch failed | searchId=${searchId} error="${resultsOutcome.error.message}"`);
        }

        const statuses = statusOutcome.ok ? statusOutcome.value : [];
        const searchResult = resultsOutcome.ok ? resultsOutcome.value : { results: [] };

        const row = Array.isArray(statuses)
            ? statuses.find((item) => Number(item?.id) === Number(searchId))
            : null;
        lastStatus = String(row?.status || '').toLowerCase() || 'unknown';

        const rawRows = Array.isArray(searchResult?.results) ? searchResult.results : [];
        const scored = pickBestAutoSeriesCandidate(rawRows, context);
        lastPoolStats = scored.stats;
        const currentBest = scored.best;
        const currentScore = Number(currentBest?.confidenceScore ?? Number.NEGATIVE_INFINITY);
        const totalCandidates = scored.candidates.length;

        logger.debug(
            `[AutoAcquire][Search] poll #${sampleCount} | status=${lastStatus} raw=${rawRows.length} pack=${scored.stats.packRaw} episode=${scored.stats.episodeRaw} scored=${totalCandidates} rejected=${scored.stats.hardRejected} best=${currentBest ? `"${currentBest.title}" score=${currentScore} seeds=${currentBest.seeds}` : 'none'}`
        );

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
            logger.debug(`[AutoAcquire][Search] Polling done | searchId=${searchId} reason=${readyByTimeout ? 'timeout' : (readyByTerminal ? 'terminal-status' : 'settled')} samples=${sampleCount} elapsedMs=${elapsedMs}`);
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
                    settleWindowMs,
                    poolStats: lastPoolStats
                }
            };
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}

async function selectBestEztvAutoCandidate({ imdbId, season = null, episode = null, sourceType = 'episode', allow2160 = false } = {}) {
    const normalizedImdb = normalizeImdbId(imdbId);
    if (!normalizedImdb) {
        return { best: null, diagnostics: { reason: 'missing_imdb' } };
    }

    const imdbDigits = String(normalizedImdb).replace(/^tt/i, '');
    const packsOnly = String(sourceType || '').toLowerCase() === 'pack';
    const seasonNum = Number.isFinite(parseInt(season, 10)) ? parseInt(season, 10) : null;
    const episodeNum = Number.isFinite(parseInt(episode, 10)) ? parseInt(episode, 10) : null;

    const fetched = await EztvCatalogService.getTorrentsForImdb(imdbDigits, { maxPages: 5 });
    const rows = Array.isArray(fetched.torrents) ? fetched.torrents : [];
    // EZTV is overwhelmingly a per-episode tracker - real season-pack
    // releases there are rare. Counting this up front makes it obvious in
    // diagnostics when a pack request falls through to search-confidence
    // simply because EZTV never had a pack to offer, vs. having one that
    // didn't match season/quality.
    const packRawCount = rows.filter((row) => looksLikeSeasonPack(String(row.title || row.filename || ''))).length;

    const exact = rows
        .map((row) => {
            const title = String(row.title || row.filename || '').trim();
            const quality = inferQualityLabel(title);
            if (!allow2160 && quality === '2160p') return null;
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
    const pool = seededExact;
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
            reason: seededExact.length
                ? 'seeded_exact_match'
                : (exact.length ? 'exact_match_without_seeds' : 'no_exact_match'),
            rawCount: rows.length,
            packRawCount,
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
    const sourceTypeRaw = String(intent.sourceType || '').toLowerCase();
    const sourceType = sourceTypeRaw === 'pack' || sourceTypeRaw === 'episode'
        ? sourceTypeRaw
        : (seasonNum && !episodeNum ? 'pack' : 'episode');
    const allow2160 = shouldAllow2160(intent);
    const query = buildAutoSeriesSearchQuery(showTitle || imdbId || '', seasonNum, episodeNum, sourceType);

    logger.info(`[AutoAcquire] Search start | title="${showTitle || 'n/a'}" imdb=${imdbId || 'n/a'} season=${seasonNum || '-'} episode=${episodeNum || '-'} sourceType=${sourceType} allow2160=${allow2160} query="${query}"`);

    let eztvSelection = { best: null, diagnostics: { reason: 'not_attempted' } };
    try {
        eztvSelection = await selectBestEztvAutoCandidate({
            imdbId,
            season: seasonNum,
            episode: episodeNum,
            sourceType,
            allow2160
        });
    } catch (err) {
        logger.warn(`[AutoAcquire] EZTV lookup failed, falling back to search-confidence | query="${query}" error="${err.message}"`);
        eztvSelection = { best: null, diagnostics: { reason: 'lookup_failed', error: err.message } };
    }

    const eztvSeeds = parseInt(eztvSelection?.best?.seeds, 10) || 0;
    if (eztvSelection?.best?.magnet && eztvSeeds > 0) {
        logger.info(`[AutoAcquire] Selected EZTV seeded result | query="${query}" title="${String(eztvSelection.best.originalTitle || eztvSelection.best.title || '').trim()}" seeds=${eztvSeeds}`);
        return {
            success: true,
            query,
            selected: {
                title: eztvSelection.best.originalTitle || eztvSelection.best.title || 'EZTV release',
                seeds: eztvSeeds,
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

    logger.info(
        `[AutoAcquire] EZTV seeded exact unavailable; fallback to search-confidence | query="${query}" reason=${String(eztvSelection?.diagnostics?.reason || 'no_seeded_match')} raw=${Number(eztvSelection?.diagnostics?.rawCount || 0)} packRaw=${Number(eztvSelection?.diagnostics?.packRawCount || 0)} exact=${Number(eztvSelection?.diagnostics?.exactCount || 0)} seeded=${Number(eztvSelection?.diagnostics?.seededExactCount || 0)}`
    );

    const started = await TorrentSearchService.startSearch({
        query,
        category: String(intent.category || 'tv').trim() || 'tv',
        plugins: String(intent.plugins || 'enabled').trim() || 'enabled'
    });

    const searchId = started?.id || null;
    if (!searchId) {
        logger.warn(`[AutoAcquire] qBittorrent search did not return an id | query="${query}"`);
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
        sourceType,
        allow2160
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

    const poolStats = collected?.stats?.poolStats || {};
    logger.debug(
        `[AutoAcquire][Search] Final pool | query="${query}" searchId=${searchId} status=${collected?.stats?.status || 'unknown'} elapsedMs=${collected?.stats?.elapsedMs ?? '-'} totalRaw=${poolStats.totalRaw || 0} packRaw=${poolStats.packRaw || 0} episodeRaw=${poolStats.episodeRaw || 0} missingMagnet=${poolStats.missingMagnet || 0} excluded2160=${poolStats.excluded2160 || 0} excludedWrongType=${poolStats.excludedWrongType || 0} hardRejected=${poolStats.hardRejected || 0} scoredCandidates=${scored.candidates.length}`
    );
    if (scored.candidates.length) {
        const table = scored.candidates.slice(0, 10).map((row, idx) => (
            `  #${idx + 1} score=${row.confidenceScore} seeds=${row.seeds} S${row.season ?? '-'}E${row.episode ?? '-'} type=${row.sourceType} "${row.title}" [${(row.scoreReasons || []).join('; ')}]`
        )).join('\n');
        logger.debug(`[AutoAcquire][Search] Top ${Math.min(10, scored.candidates.length)} scored candidates:\n${table}`);
    }

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

    const bestBySeededExact = (scored.best && Number(scored.best.confidenceScore || 0) >= threshold)
        ? scored.best
        : seededExactSearchFallback;

    // scoreAutoSeriesCandidate() *penalizes* a season/episode mismatch but
    // never fully eliminates it - a high-seed wrong-season release can still
    // out-score everything else and cross `threshold` (confirmed live:
    // "X-Men.97.S02E01" with 2495 seeds won a search for S03E01, since
    // Math.min(220, seeds*5) alone dwarfs the -140/-180 mismatch penalty).
    // Hard-reject here rather than tune the scoring weights, since no seed
    // count should ever make the wrong episode an acceptable answer.
    const candidateMatchesRequestedTarget = (candidate) => {
        if (!candidate) return false;
        if (seasonNum && Number(candidate.season) !== seasonNum) return false;
        if (sourceType === 'episode' && episodeNum && Number(candidate.episode) !== episodeNum) return false;
        return true;
    };
    const selectedSearchCandidate = candidateMatchesRequestedTarget(bestBySeededExact) ? bestBySeededExact : null;

    if (!selectedSearchCandidate || !selectedSearchCandidate.magnetUrl) {
        const topCandidates = scored.candidates.slice(0, 3).map((row) => `${row.title} [score=${row.confidenceScore} seeds=${row.seeds}]`).join(' | ');
        if (bestBySeededExact && !candidateMatchesRequestedTarget(bestBySeededExact)) {
            logger.warn(`[AutoAcquire] Rejected wrong-season/episode result | query="${query}" wanted=S${seasonNum || '-'}E${episodeNum || '-'} got="${bestBySeededExact.title}" [S${bestBySeededExact.season}E${bestBySeededExact.episode}]`);
        }
        logger.warn(`[AutoAcquire] No confident result | query="${query}" searchId=${searchId} status=${collected?.stats?.status || 'unknown'} top=${topCandidates || 'none'}`);
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

    logger.info(`[AutoAcquire] Selected search result | query="${query}" source=${selectionSource} title="${selectedSearchCandidate.title}" score=${selectedSearchCandidate.confidenceScore || 'n/a'} seeds=${selectedSearchCandidate.seeds || 0}`);

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