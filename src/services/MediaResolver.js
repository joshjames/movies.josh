// Resolves a player-generated mediaId back to a real library item. Shared by
// ContinueWatchingService (building cards) and the watched-history recorder
// (attaching real title/genre/imdbId to a durable "watched" record) so the
// lookup logic - and its edge cases - only exist in one place.
'use strict';

// player.html builds a series episode's mediaId as `${folder}-S${season}E${episode}`
// (no zero-padding - see playEpisodeIndex in public/player.html). Movies use
// the raw library id directly (see currentMediaId assignment in player.html).
const EPISODE_MEDIA_ID_PATTERN = /^(.+)-S(\d+)E(\d+)$/;

function pickImdbId(media = {}) {
    return media.imdbId || media.imdbID || media.imdb_id || media.enrichment?.imdbId || '';
}

function pickGenre(media = {}) {
    return media.genre || media.enrichment?.genre || '';
}

function pickImdbScore(media = {}) {
    return media.imdbScore || media.rating || media.enrichment?.imdbScore || '';
}

// Returns null if mediaId doesn't resolve to anything currently in the
// library (title removed since, or a corrupted/legacy mediaId), otherwise:
// { id, title, year, imdbId, genre, imdbScore, contentType, cover, season, episode }
// season/episode are null for movies.
function resolveMediaId(mediaId, library = {}) {
    const clean = String(mediaId || '').trim();
    if (!clean) return null;
    const cleanLower = clean.toLowerCase();

    const movies = Array.isArray(library.movies) ? library.movies : [];
    // Case-insensitive: a folder's casing can drift after a watch (e.g. an
    // IngestSanitizerWorker rename) while the mediaId captured at watch-time
    // keeps the old casing - an exact match would silently drop it.
    const movie = movies.find((m) => String(m.id).toLowerCase() === cleanLower);
    if (movie) {
        return {
            id: movie.id,
            title: movie.title || movie.id,
            year: movie.year || '',
            imdbId: pickImdbId(movie),
            genre: pickGenre(movie),
            imdbScore: pickImdbScore(movie),
            contentType: 'movie',
            cover: movie.cover || '',
            season: null,
            episode: null
        };
    }

    const match = clean.match(EPISODE_MEDIA_ID_PATTERN);
    if (!match) return null;

    const [, folder, season, episode] = match;
    const shows = Array.isArray(library.shows) ? library.shows : [];
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
        cover: show.cover || '',
        season: parseInt(season, 10),
        episode: parseInt(episode, 10)
    };
}

module.exports = { resolveMediaId };
