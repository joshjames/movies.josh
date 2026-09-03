// Builds the "Continue Watching" home-feed row: partially-watched movies and
// TV episodes, most-recently-watched first. Computed fresh on every
// /api/home-feed request (same pattern as buildMyLibraryCollection /
// buildMyShowsCollection) rather than cached - the underlying playback data
// is small per user and changes constantly, so there's no separate cache to
// keep in sync and no write-time hook needed.
'use strict';

const ProfileService = require('./ProfileService');
const { versionCoverUrl } = require('./CoverUrlService');

// player.html builds a series episode's mediaId as `${folder}-S${season}E${episode}`
// (no zero-padding - see playEpisodeIndex in public/player.html).
const EPISODE_MEDIA_ID_PATTERN = /^(.+)-S(\d+)E(\d+)$/;

// Below this, a title was barely started (e.g. an accidental click) and isn't
// worth surfacing as "in progress." There's no stored duration/percent, so a
// symmetrical "almost finished" cutoff isn't possible here - that's instead
// handled by clearing the record entirely when playback reaches 'ended'
// (see /api/profile/playback/complete).
const MIN_POSITION_SECONDS = 30;

function pickImdbId(media = {}) {
    return media.imdbId || media.imdbID || media.imdb_id || media.enrichment?.imdbId || '';
}

function pickGenre(media = {}) {
    return media.genre || media.enrichment?.genre || '';
}

function pickImdbScore(media = {}) {
    return media.imdbScore || media.rating || media.enrichment?.imdbScore || '';
}

function resolveMovieCard(mediaId, movies) {
    // Case-insensitive: a folder's casing can drift after a watch (e.g. an
    // IngestSanitizerWorker rename) while the mediaId captured at watch-time
    // keeps the old casing - an exact match would silently drop it.
    const mediaIdLower = mediaId.toLowerCase();
    const item = movies.find((m) => String(m.id).toLowerCase() === mediaIdLower);
    if (!item) return null;
    return {
        id: item.id,
        title: item.title || item.id,
        year: item.year || '',
        imdbId: pickImdbId(item),
        genre: pickGenre(item),
        imdbScore: pickImdbScore(item),
        contentType: 'movie',
        cover: versionCoverUrl(item.cover || ''),
        href: `player.html?id=${item.id}`,
        badge: 'Continue Watching'
    };
}

function resolveEpisodeCard(mediaId, shows) {
    const match = mediaId.match(EPISODE_MEDIA_ID_PATTERN);
    if (!match) return null;
    const [, folder, season, episode] = match;
    const targetId = `series/${folder}`.toLowerCase();
    const show = shows.find((s) => String(s.id).toLowerCase() === targetId);
    if (!show) return null;
    return {
        id: show.id,
        title: show.title || folder,
        year: show.year || '',
        imdbId: pickImdbId(show),
        genre: pickGenre(show),
        imdbScore: pickImdbScore(show),
        contentType: 'series',
        cover: versionCoverUrl(show.cover || ''),
        href: `player.html?id=${encodeURIComponent(show.id)}&season=${season}&episode=${episode}`,
        badge: `S${season}E${episode}`
    };
}

async function buildContinueWatchingCollection(username = '', library = {}, options = {}) {
    const maxCards = Math.max(1, Math.min(parseInt(options.limit, 10) || 18, 60));
    const cleanUser = String(username || '').trim();

    if (!cleanUser) {
        return { id: 'continue-watching-row', title: 'Continue Watching', subtitle: '', cards: [] };
    }

    const movies = Array.isArray(library.movies) ? library.movies : [];
    const shows = Array.isArray(library.shows) ? library.shows : [];

    // Pull more than maxCards since some history entries won't resolve (title
    // removed from the library since, or a corrupted/legacy mediaId) or will
    // be deduped below.
    const history = await ProfileService.getWatchHistory(cleanUser, { limit: 100 });

    const cards = [];
    const seenIds = new Set();

    for (const entry of history) {
        if (cards.length >= maxCards) break;
        if (!(entry.position >= MIN_POSITION_SECONDS)) continue;

        const card = resolveMovieCard(entry.mediaId, movies) || resolveEpisodeCard(entry.mediaId, shows);
        if (!card) continue;

        // One card per title/show - history is already newest-first, so the
        // first (most recent) occurrence per id wins; an older in-progress
        // episode of a show you've since moved on from doesn't also show up.
        if (seenIds.has(card.id)) continue;
        seenIds.add(card.id);

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
