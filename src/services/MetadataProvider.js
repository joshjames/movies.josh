const axios = require('axios');
const logger = require('./logger');

const DEFAULT_TMDB_API_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const DEFAULT_TIMEOUT_MS = 10000;
const OMDB_401_COOLDOWN_MS = Number(process.env.OMDB_401_COOLDOWN_MS || 30 * 60 * 1000);

let omdbDisabledUntil = 0;

function now() {
    return Date.now();
}

function canUseOmdb() {
    return now() >= omdbDisabledUntil;
}

function markOmdbCooldown(reason) {
    omdbDisabledUntil = now() + OMDB_401_COOLDOWN_MS;
    logger.warn(`⚠️ [MetadataProvider] OMDb temporarily disabled for ${Math.round(OMDB_401_COOLDOWN_MS / 60000)}m (${reason}).`);
}

function isOmdbAuthOrLimitError(data, status) {
    const message = String(data?.Error || '').toLowerCase();
    if (status === 401) return true;
    return (
        message.includes('invalid api key')
        || message.includes('request limit reached')
        || message.includes('too many requests')
        || message.includes('unauthorized')
    );
}

function getOmdbApiKey() {
    return String(process.env.OMDB_API_KEY || '').trim();
}

function getTmdbApiBase() {
    return String(process.env.TMDB_API_URL || DEFAULT_TMDB_API_BASE).replace(/\/+$/, '');
}

function getTmdbApiKey() {
    return String(process.env.THEMOVIEDB_API_KEY || '').trim();
}

function getTmdbReadToken() {
    return String(process.env.THEMOVIEDB_API_READ_ACCESS_TOKEN || '').trim();
}

function hasTmdbCredentials() {
    return Boolean(getTmdbApiKey() || getTmdbReadToken());
}

function buildTmdbRequestConfig(params = {}, timeout = DEFAULT_TIMEOUT_MS) {
    const token = getTmdbReadToken();
    const apiKey = getTmdbApiKey();
    const headers = {};
    const query = { ...params };

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    } else if (apiKey) {
        query.api_key = apiKey;
    }

    return { headers, params: query, timeout };
}

async function tmdbGet(endpoint, params = {}, timeout = DEFAULT_TIMEOUT_MS) {
    const url = `${getTmdbApiBase()}${endpoint}`;
    const config = buildTmdbRequestConfig(params, timeout);
    const response = await axios.get(url, config);
    return response.data;
}

function normalizeOmdbResult(data = {}) {
    if (!data || data.Response !== 'True') return null;
    return {
        ...data,
        Response: 'True',
        tmdbId: null,
        tmdbMediaType: null,
        provider: 'omdb'
    };
}

function toImdbStyleRating(voteAverage) {
    const numeric = Number(voteAverage);
    if (!Number.isFinite(numeric) || numeric <= 0) return 'N/A';
    return numeric.toFixed(1);
}

function toYearString(dateString) {
    const raw = String(dateString || '');
    return raw.length >= 4 ? raw.slice(0, 4) : '';
}

function buildPosterUrl(posterPath) {
    if (!posterPath) return 'N/A';
    return `${DEFAULT_TMDB_IMAGE_BASE}${posterPath}`;
}

function normalizeTmdbResult(details = {}, { imdbId = '', mediaType = 'movie' } = {}) {
    const title = details.title || details.name || '';
    if (!title) return null;

    const year = toYearString(details.release_date || details.first_air_date);
    const genres = Array.isArray(details.genres)
        ? details.genres.map(item => item?.name).filter(Boolean).join(', ')
        : '';

    return {
        Response: 'True',
        imdbID: imdbId || '',
        Title: title,
        Year: year,
        Plot: details.overview || '',
        Genre: genres || 'Media',
        Rated: 'N/A',
        imdbRating: toImdbStyleRating(details.vote_average),
        imdbVotes: Number.isFinite(Number(details.vote_count)) ? String(details.vote_count) : 'N/A',
        Runtime: Number.isFinite(Number(details.runtime)) ? `${details.runtime} min` : 'N/A',
        Poster: buildPosterUrl(details.poster_path),
        totalSeasons: Number.isFinite(Number(details.number_of_seasons)) ? String(details.number_of_seasons) : undefined,
        tmdbId: details.id,
        tmdbMediaType: mediaType,
        provider: 'tmdb'
    };
}

async function fetchFromOmdb({ imdbId, title, year, contentType }) {
    const apiKey = getOmdbApiKey();
    if (!apiKey || !canUseOmdb()) return null;

    let url = `http://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}`;
    if (contentType) {
        url += `&type=${encodeURIComponent(contentType)}`;
    }

    if (imdbId) {
        url += `&i=${encodeURIComponent(imdbId)}`;
    } else if (title) {
        url += `&t=${encodeURIComponent(title)}`;
        if (year) url += `&y=${encodeURIComponent(year)}`;
    } else {
        return null;
    }

    try {
        const response = await axios.get(url, { timeout: DEFAULT_TIMEOUT_MS });
        const data = response.data || {};

        if (isOmdbAuthOrLimitError(data, response.status)) {
            markOmdbCooldown(data.Error || `status ${response.status}`);
            return null;
        }

        return normalizeOmdbResult(data);
    } catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data || {};

        if (isOmdbAuthOrLimitError(data, status)) {
            markOmdbCooldown(data.Error || `status ${status || 'unknown'}`);
            return null;
        }

        logger.warn(`⚠️ [MetadataProvider] OMDb request failed: ${err.message}`);
        return null;
    }
}

async function resolveTmdbFromImdb(imdbId) {
    const normalizedImdb = String(imdbId || '').trim();
    if (!normalizedImdb) return null;

    try {
        const data = await tmdbGet(`/find/${encodeURIComponent(normalizedImdb)}`, {
            external_source: 'imdb_id',
            language: 'en-US'
        });

        const movieResult = Array.isArray(data?.movie_results) ? data.movie_results[0] : null;
        if (movieResult?.id) {
            const details = await tmdbGet(`/movie/${movieResult.id}`, { language: 'en-US' });
            return normalizeTmdbResult(details, { imdbId: normalizedImdb, mediaType: 'movie' });
        }

        const tvResult = Array.isArray(data?.tv_results) ? data.tv_results[0] : null;
        if (tvResult?.id) {
            const details = await tmdbGet(`/tv/${tvResult.id}`, { language: 'en-US' });
            return normalizeTmdbResult(details, { imdbId: normalizedImdb, mediaType: 'series' });
        }
    } catch (err) {
        logger.warn(`⚠️ [MetadataProvider] TMDb find-by-imdb failed: ${err.message}`);
    }

    return null;
}

async function resolveTmdbByTitle({ title, year, contentType }) {
    if (!title) return null;

    const preferredType = contentType === 'series' ? 'tv' : 'movie';
    const fallbacks = preferredType === 'tv' ? ['tv', 'movie'] : ['movie', 'tv'];

    for (const tmdbType of fallbacks) {
        try {
            const params = {
                query: title,
                include_adult: false,
                language: 'en-US',
                page: 1
            };

            if (year) {
                if (tmdbType === 'movie') params.year = String(year);
                else params.first_air_date_year = String(year);
            }

            const search = await tmdbGet(`/search/${tmdbType}`, params);
            const first = Array.isArray(search?.results) ? search.results[0] : null;
            if (!first?.id) continue;

            const details = await tmdbGet(`/${tmdbType}/${first.id}`, { language: 'en-US' });
            let imdbId = '';

            try {
                const external = await tmdbGet(`/${tmdbType}/${first.id}/external_ids`);
                imdbId = external?.imdb_id || '';
            } catch (_externalErr) {
                // Best-effort only.
            }

            return normalizeTmdbResult(details, {
                imdbId,
                mediaType: tmdbType === 'tv' ? 'series' : 'movie'
            });
        } catch (err) {
            logger.warn(`⚠️ [MetadataProvider] TMDb title search failed for ${tmdbType}: ${err.message}`);
        }
    }

    return null;
}

async function fetchMetadataWithFallback({ imdbId = '', title = '', year = '', contentType = 'movie' } = {}) {
    const normalizedImdb = String(imdbId || '').trim();
    const normalizedTitle = String(title || '').trim();
    const normalizedYear = String(year || '').trim();
    const normalizedType = contentType === 'series' ? 'series' : 'movie';

    const omdbData = await fetchFromOmdb({
        imdbId: normalizedImdb,
        title: normalizedTitle,
        year: normalizedYear,
        contentType: normalizedType
    });

    if (omdbData) {
        return { provider: 'omdb', data: omdbData };
    }

    if (!hasTmdbCredentials()) {
        return { provider: 'none', data: null };
    }

    const tmdbData = normalizedImdb
        ? await resolveTmdbFromImdb(normalizedImdb)
        : await resolveTmdbByTitle({ title: normalizedTitle, year: normalizedYear, contentType: normalizedType });

    if (tmdbData) {
        return { provider: 'tmdb', data: tmdbData };
    }

    return { provider: 'none', data: null };
}

async function resolveTmdbTvId({ imdbId = '', title = '', year = '', tmdbId = null } = {}) {
    if (Number.isFinite(Number(tmdbId))) return Number(tmdbId);

    const normalizedImdb = String(imdbId || '').trim();
    if (normalizedImdb) {
        try {
            const data = await tmdbGet(`/find/${encodeURIComponent(normalizedImdb)}`, {
                external_source: 'imdb_id',
                language: 'en-US'
            });
            const tvResult = Array.isArray(data?.tv_results) ? data.tv_results[0] : null;
            if (tvResult?.id) return tvResult.id;
        } catch (err) {
            logger.warn(`⚠️ [MetadataProvider] TMDb TV id resolve by IMDb failed: ${err.message}`);
        }
    }

    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) return null;

    try {
        const params = {
            query: normalizedTitle,
            include_adult: false,
            language: 'en-US',
            page: 1
        };
        if (year) params.first_air_date_year = String(year);

        const search = await tmdbGet('/search/tv', params);
        const first = Array.isArray(search?.results) ? search.results[0] : null;
        return first?.id || null;
    } catch (err) {
        logger.warn(`⚠️ [MetadataProvider] TMDb TV id resolve by title failed: ${err.message}`);
        return null;
    }
}

function normalizeSeasonEpisodes(episodes = []) {
    return episodes
        .map(ep => ({
            Title: ep?.name || ep?.Title || '',
            Episode: String(ep?.episode_number || ep?.Episode || ''),
            Released: ep?.air_date || ep?.Released || 'Unknown',
            imdbRating: ep?.vote_average ? Number(ep.vote_average).toFixed(1) : 'N/A'
        }))
        .filter(ep => ep.Title && ep.Episode);
}

async function fetchSeasonEpisodesWithFallback({ imdbId = '', title = '', season, tmdbId = null } = {}) {
    const seasonNum = Number(season);
    if (!Number.isFinite(seasonNum) || seasonNum <= 0) return [];

    const apiKey = getOmdbApiKey();
    if (apiKey && canUseOmdb() && (imdbId || title)) {
        let url = `http://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}`;
        if (imdbId) {
            url += `&i=${encodeURIComponent(imdbId)}`;
        } else {
            url += `&t=${encodeURIComponent(title)}`;
        }
        url += `&Season=${seasonNum}`;

        try {
            const response = await axios.get(url, { timeout: DEFAULT_TIMEOUT_MS });
            const data = response.data || {};

            if (isOmdbAuthOrLimitError(data, response.status)) {
                markOmdbCooldown(data.Error || `status ${response.status}`);
            } else if (data.Response === 'True' && Array.isArray(data.Episodes)) {
                return normalizeSeasonEpisodes(data.Episodes);
            }
        } catch (err) {
            const status = err?.response?.status;
            const data = err?.response?.data || {};

            if (isOmdbAuthOrLimitError(data, status)) {
                markOmdbCooldown(data.Error || `status ${status || 'unknown'}`);
            } else {
                logger.warn(`⚠️ [MetadataProvider] OMDb season fetch failed: ${err.message}`);
            }
        }
    }

    if (!hasTmdbCredentials()) return [];

    const tvId = await resolveTmdbTvId({ imdbId, title, tmdbId });
    if (!tvId) return [];

    try {
        const seasonData = await tmdbGet(`/tv/${tvId}/season/${seasonNum}`, { language: 'en-US' });
        const episodes = Array.isArray(seasonData?.episodes) ? seasonData.episodes : [];
        return normalizeSeasonEpisodes(episodes);
    } catch (err) {
        logger.warn(`⚠️ [MetadataProvider] TMDb season fetch failed: ${err.message}`);
        return [];
    }
}

module.exports = {
    fetchMetadataWithFallback,
    fetchSeasonEpisodesWithFallback,
    canUseOmdb
};
