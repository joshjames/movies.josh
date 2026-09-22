// src/services/PublicRowBuilderService.js
// Layer 1 of the "rows are JSON files" browse/home-page redesign: builds
// the PUBLIC, scheduled rows (same for every user) - "Top on Netflix",
// "Popular right now", "Recently Added", etc. - from TMDb's discover API,
// cross-referenced against the local library, and writes each one to its
// own JSON file.
//
// Deliberately data-only for now: this never triggers acquisition for
// anything missing - that's Layer 2, added later once this has been
// running long enough to trust the matching. Every row item just carries
// an `inLibrary` flag + `localHref` so the frontend can badge/link
// accordingly.
//
// File/directory convention: metadata/publicdata/all/<rowId>.json - reuses
// the app's existing writable, cross-region-synced data root (/app/metadata,
// the same one ProfileService/TvSeriesIndexService already write into,
// mirrored to satellites by the metadata-mirror BullMQ job) rather than a
// new top-level Docker volume, since nothing about this needs to live
// anywhere else. A later per-user row (Layer 3+) would live at
// metadata/users/<userKey>/rows/<rowId>.json - the same per-user tree
// ProfileService already uses - following the exact same row JSON shape
// this file writes, just scoped to one user instead of "all".
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');
const { getLibrary } = require('./db');

const DATA_ROOT_CANDIDATES = [
    String(process.env.APP_DATA_DIR || '').trim(),
    '/app/metadata',
    path.join(__dirname, '../../metadata'),
    path.join(__dirname, '../../movie-streamer-data')
].filter(Boolean);
const DATA_ROOT = DATA_ROOT_CANDIDATES[0];
const ROWS_DIR = path.join(DATA_ROOT, 'publicdata', 'all');

const TMDB_BASE_URL = String(process.env.TMDB_API_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
const TMDB_API_KEY = String(process.env.THEMOVIEDB_API_KEY || '').trim();
const TMDB_BEARER = String(process.env.THEMOVIEDB_API_READ_ACCESS_TOKEN || '').trim();
const TMDB_IMAGE_BASE = String(process.env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p/w500').replace(/\/+$/, '');
const TMDB_BACKDROP_BASE = String(process.env.TMDB_BACKDROP_BASE || 'https://image.tmdb.org/t/p/w1280').replace(/\/+$/, '');
const WATCH_REGION = String(process.env.TMDB_WATCH_REGION || 'US').trim().toUpperCase();
const ITEMS_PER_ROW = Math.max(5, Math.min(100, parseInt(process.env.PUBLIC_ROWS_ITEMS_PER_ROW, 10) || 20));
const EXTERNAL_ID_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15000;

// Confirmed live against the real API (2026-09-22) - these are TMDb's
// actual provider IDs for watch_region=US, not guessed.
const PROVIDERS = [
    { slug: 'netflix', name: 'Netflix', id: 8 },
    { slug: 'prime', name: 'Prime Video', id: 9 },
    { slug: 'disney', name: 'Disney Plus', id: 337 },
    { slug: 'appletv', name: 'Apple TV+', id: 350 },
    { slug: 'hbomax', name: 'HBO Max', id: 1899 }
];

function buildProviderRowDefinitions() {
    const defs = [];
    for (const provider of PROVIDERS) {
        for (const mediaType of ['movie', 'tv']) {
            defs.push({
                id: `${provider.slug}-${mediaType === 'movie' ? 'movies' : 'tv'}`,
                title: `Top ${mediaType === 'movie' ? 'Movies' : 'TV Shows'} on ${provider.name}`,
                mediaType,
                badges: [provider.slug],
                endpoint: mediaType === 'movie' ? '/discover/movie' : '/discover/tv',
                params: {
                    watch_region: WATCH_REGION,
                    with_watch_providers: String(provider.id),
                    with_watch_monetization_types: 'flatrate',
                    sort_by: 'popularity.desc'
                }
            });
        }
    }
    return defs;
}

// The general/non-provider-specific rows. Layer 1 starts with these plus
// the provider rows above - the same discover-query pattern extends
// naturally to the rest of the browse-list views (last-30-days, this-year,
// coming-soon, TV calendar) as a follow-up, without needing a different
// approach.
const GENERAL_ROW_DEFINITIONS = [
    {
        id: 'popular-streaming-movies',
        title: 'Popular Streaming Movies',
        mediaType: 'movie',
        badges: [],
        endpoint: '/discover/movie',
        params: {
            watch_region: WATCH_REGION,
            with_watch_monetization_types: 'flatrate',
            sort_by: 'popularity.desc'
        }
    },
    {
        id: 'popular-tv',
        title: 'Popular TV Shows',
        mediaType: 'tv',
        badges: [],
        endpoint: '/discover/tv',
        params: {
            sort_by: 'popularity.desc'
        }
    }
];

function ensureRowsDir() {
    fs.mkdirSync(ROWS_DIR, { recursive: true });
}

async function tmdbGet(endpoint, params = {}) {
    const url = `${TMDB_BASE_URL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
    const headers = TMDB_BEARER ? { Authorization: `Bearer ${TMDB_BEARER}` } : {};
    const query = TMDB_API_KEY ? { ...params, api_key: TMDB_API_KEY } : { ...params };
    const res = await axios.get(url, { params: query, headers, timeout: REQUEST_TIMEOUT_MS });
    return res.data;
}

async function promisePool(items, limit, mapper) {
    const results = new Array(items.length);
    let index = 0;

    async function worker() {
        while (true) {
            const current = index;
            index += 1;
            if (current >= items.length) return;
            results[current] = await mapper(items[current], current);
        }
    }

    const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
    await Promise.all(workers);
    return results;
}

function toImageUrl(base, filePath) {
    const clean = String(filePath || '').trim();
    if (!clean) return '';
    return `${base}${clean.startsWith('/') ? '' : '/'}${clean}`;
}

async function fetchDiscoverPage(endpoint, params, page) {
    const data = await tmdbGet(endpoint, { ...params, page });
    return Array.isArray(data?.results) ? data.results : [];
}

// TMDb's discover endpoints don't return imdb_id directly - only the
// per-item detail/external_ids endpoints do. Fetched with bounded
// concurrency (same promisePool pattern build-tmdb-catalogs.js already
// uses) rather than sequentially, since this runs against ~20 items per
// row across ~13 rows nightly.
async function resolveExternalId(mediaType, tmdbId) {
    try {
        const data = await tmdbGet(`/${mediaType}/${tmdbId}/external_ids`);
        const imdbId = String(data?.imdb_id || '').trim();
        return imdbId || null;
    } catch (err) {
        logger.warn(`[PublicRows] external_ids lookup failed for ${mediaType}/${tmdbId}: ${err.message}`);
        return null;
    }
}

function buildLibraryIndex(library) {
    const movieIndex = new Map();
    const showIndex = new Map();

    for (const movie of (Array.isArray(library?.movies) ? library.movies : [])) {
        const imdbId = String(movie?.imdbId || movie?.imdb_id || '').trim().toLowerCase();
        if (imdbId) movieIndex.set(imdbId, movie);
    }
    for (const show of (Array.isArray(library?.shows) ? library.shows : [])) {
        const imdbId = String(show?.imdbId || show?.imdb_id || '').trim().toLowerCase();
        if (imdbId) showIndex.set(imdbId, show);
    }

    return { movieIndex, showIndex };
}

function buildLibraryHref(item, contentType) {
    if (!item || !item.id) return null;
    return contentType === 'series'
        ? `/series.html?id=${encodeURIComponent(item.id)}`
        : `/player.html?id=${encodeURIComponent(item.id)}`;
}

async function buildOneRow(def, libraryIndex) {
    const { movieIndex, showIndex } = libraryIndex;
    const contentType = def.mediaType === 'tv' ? 'series' : 'movie';
    const libraryLookup = def.mediaType === 'tv' ? showIndex : movieIndex;

    const collected = [];
    let page = 1;
    while (collected.length < ITEMS_PER_ROW && page <= 5) {
        const rows = await fetchDiscoverPage(def.endpoint, def.params, page);
        if (!rows.length) break;
        collected.push(...rows);
        page += 1;
        if (rows.length < 20) break;
    }

    const trimmed = collected.slice(0, ITEMS_PER_ROW);

    const items = await promisePool(trimmed, EXTERNAL_ID_CONCURRENCY, async (raw) => {
        const imdbId = await resolveExternalId(def.mediaType, raw.id);
        const libraryItem = imdbId ? libraryLookup.get(imdbId.toLowerCase()) : null;

        return {
            mediaType: def.mediaType,
            tmdbId: raw.id,
            imdbId: imdbId || null,
            title: def.mediaType === 'tv' ? (raw.name || raw.original_name || '') : (raw.title || raw.original_title || ''),
            year: String(raw.first_air_date || raw.release_date || '').slice(0, 4) || null,
            overview: raw.overview || '',
            poster: toImageUrl(TMDB_IMAGE_BASE, raw.poster_path),
            backdrop: toImageUrl(TMDB_BACKDROP_BASE, raw.backdrop_path),
            popularity: raw.popularity || 0,
            badges: def.badges,
            inLibrary: Boolean(libraryItem),
            localId: libraryItem?.id || null,
            localHref: buildLibraryHref(libraryItem, contentType),
            overlay: { watched: false, progress: null }
        };
    });

    return {
        id: def.id,
        title: def.title,
        scope: 'public',
        mediaType: def.mediaType,
        layout: 'poster-row',
        badges: def.badges,
        generatedAt: new Date().toISOString(),
        source: { provider: 'tmdb', endpoint: def.endpoint, params: def.params },
        items
    };
}

async function buildRecentlyAddedRow(library) {
    const all = [
        ...(Array.isArray(library?.movies) ? library.movies : []).map((m) => ({ ...m, contentType: 'movie' })),
        ...(Array.isArray(library?.shows) ? library.shows : []).map((s) => ({ ...s, contentType: 'series' }))
    ].filter((item) => item.addedAt);

    all.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
    const top = all.slice(0, ITEMS_PER_ROW);

    const items = top.map((item) => ({
        mediaType: item.contentType === 'series' ? 'tv' : 'movie',
        tmdbId: null,
        imdbId: item.imdbId || item.imdb_id || null,
        title: item.title || '',
        year: String(item.year || '').slice(0, 4) || null,
        overview: item.plot || '',
        poster: item.cover || '',
        backdrop: '',
        popularity: 0,
        badges: [],
        inLibrary: true,
        localId: item.id || null,
        localHref: buildLibraryHref(item, item.contentType),
        overlay: { watched: false, progress: null }
    }));

    return {
        id: 'recently-added',
        title: 'Recently Added',
        scope: 'public',
        mediaType: 'mixed',
        layout: 'poster-row',
        badges: [],
        generatedAt: new Date().toISOString(),
        source: { provider: 'local-library' },
        items
    };
}

function writeRowFile(row) {
    ensureRowsDir();
    const filePath = path.join(ROWS_DIR, `${row.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(row, null, 4), 'utf-8');
    return filePath;
}

async function buildAllRows() {
    if (!TMDB_API_KEY && !TMDB_BEARER) {
        throw new Error('Missing TMDb credentials (THEMOVIEDB_API_KEY / THEMOVIEDB_API_READ_ACCESS_TOKEN).');
    }

    const library = await getLibrary();
    const libraryIndex = buildLibraryIndex(library);

    const definitions = [...buildProviderRowDefinitions(), ...GENERAL_ROW_DEFINITIONS];
    const results = { built: [], failed: [] };

    for (const def of definitions) {
        try {
            const row = await buildOneRow(def, libraryIndex);
            const filePath = writeRowFile(row);
            results.built.push({ id: def.id, items: row.items.length, filePath });
            logger.debug(`[PublicRows] Built ${def.id} (${row.items.length} items) -> ${filePath}`);
        } catch (err) {
            results.failed.push({ id: def.id, error: err.message });
            logger.warn(`[PublicRows] Failed building row ${def.id}: ${err.message}`);
        }
    }

    try {
        const recentRow = await buildRecentlyAddedRow(library);
        const filePath = writeRowFile(recentRow);
        results.built.push({ id: recentRow.id, items: recentRow.items.length, filePath });
    } catch (err) {
        results.failed.push({ id: 'recently-added', error: err.message });
        logger.warn(`[PublicRows] Failed building recently-added row: ${err.message}`);
    }

    logger.info(`[PublicRows] Build complete - ${results.built.length} row(s) built, ${results.failed.length} failed.`);
    return results;
}

// Curated display order for the home page - a single source of truth so
// the frontend never has to hardcode (and keep in sync with) the row list
// separately from what actually gets built above.
function getRowDisplayOrder() {
    const providerIds = buildProviderRowDefinitions().map((def) => def.id);
    return [
        'recently-added',
        'popular-streaming-movies',
        ...providerIds,
        'popular-tv'
    ];
}

module.exports = {
    ROWS_DIR,
    buildAllRows,
    getRowDisplayOrder
};
