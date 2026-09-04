// Builds the "Continue Watching" home-feed row: partially-watched movies and
// TV episodes, most-recently-watched first. Computed fresh on every
// /api/home-feed request (same pattern as buildMyLibraryCollection /
// buildMyShowsCollection) rather than cached - the underlying playback data
// is small per user and changes constantly, so there's no separate cache to
// keep in sync and no write-time hook needed.
'use strict';

const ProfileService = require('./ProfileService');
const { resolveMediaId } = require('./MediaResolver');
const { versionCoverUrl } = require('./CoverUrlService');

// Below this, a title was barely started (e.g. an accidental click) and isn't
// worth surfacing as "in progress."
const MIN_POSITION_SECONDS = 30;

// A title is expected to be explicitly marked finished (see
// /api/profile/playback/complete, fired at this same percentage by the
// player) well before reaching this - this is just a defensive backstop for
// sessions where that call never landed (closed tab, network drop right at
// the end, older client). Only applies when a duration was actually recorded
// - legacy/pre-duration entries fall back to the position-only filter above.
const FINISHED_PERCENT = 0.9;

function buildCard(resolved) {
    const isSeries = resolved.contentType === 'series';
    return {
        id: resolved.id,
        title: isSeries ? (resolved.title || '') : (resolved.title || resolved.id),
        year: resolved.year || '',
        imdbId: resolved.imdbId || '',
        genre: resolved.genre || '',
        imdbScore: resolved.imdbScore || '',
        contentType: resolved.contentType,
        cover: versionCoverUrl(resolved.cover || ''),
        href: isSeries
            ? `player.html?id=${encodeURIComponent(resolved.id)}&season=${resolved.season}&episode=${resolved.episode}`
            : `player.html?id=${resolved.id}`,
        badge: isSeries ? `S${resolved.season}E${resolved.episode}` : 'Continue Watching'
    };
}

async function buildContinueWatchingCollection(username = '', library = {}, options = {}) {
    const maxCards = Math.max(1, Math.min(parseInt(options.limit, 10) || 18, 60));
    const cleanUser = String(username || '').trim();

    if (!cleanUser) {
        return { id: 'continue-watching-row', title: 'Continue Watching', subtitle: '', cards: [] };
    }

    // Pull more than maxCards since some history entries won't resolve (title
    // removed from the library since, or a corrupted/legacy mediaId), will be
    // filtered as effectively-finished, or will be deduped below.
    const history = await ProfileService.getWatchHistory(cleanUser, { limit: 100 });

    const cards = [];
    const seenIds = new Set();

    for (const entry of history) {
        if (cards.length >= maxCards) break;
        if (!(entry.position >= MIN_POSITION_SECONDS)) continue;
        if (entry.duration > 0 && (entry.position / entry.duration) >= FINISHED_PERCENT) continue;

        const resolved = resolveMediaId(entry.mediaId, library);
        if (!resolved) continue;

        // One card per title/show - history is already newest-first, so the
        // first (most recent) occurrence per id wins; an older in-progress
        // episode of a show you've since moved on from doesn't also show up.
        if (seenIds.has(resolved.id)) continue;
        seenIds.add(resolved.id);

        const card = buildCard(resolved);
        card.addedAt = entry.updatedAtIso;
        cards.push(card);
    }

    return {
        id: 'continue-watching-row',
        title: 'Continue Watching',
        subtitle: cards.length ? `${cards.length} in progress` : '',
        cards
    };
}

module.exports = { buildContinueWatchingCollection };
