#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

const ROOT = path.join(__dirname, '..');
const METADATA_DIR = path.join(ROOT, 'metadata');
const TV_INDEX_PATH = path.join(METADATA_DIR, 'tv-show-index.json');

// Load environment variables from repo root regardless of execution cwd.
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(ROOT, '.env.local') });

const TMDB_BASE_URL = String(process.env.TMDB_API_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
const TMDB_API_KEY = String(process.env.THEMOVIEDB_API_KEY || process.env.TMDB_API_KEY || '').trim();
const TMDB_BEARER = String(process.env.THEMOVIEDB_API_READ_ACCESS_TOKEN || process.env.TMDB_READ_ACCESS_TOKEN || '').trim();
const TMDB_IMAGE_BASE = String(process.env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p/w500').replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = 15000;
const EXTERNAL_ID_CONCURRENCY = 6;

if (!TMDB_API_KEY && !TMDB_BEARER) {
    console.error('Missing TMDb credentials. Set THEMOVIEDB_API_KEY or THEMOVIEDB_API_READ_ACCESS_TOKEN.');
    process.exit(1);
}

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return '';
    return `tt${cleaned}`;
}

function toYear(dateValue) {
    const raw = String(dateValue || '').trim();
    if (!raw) return '';
    return raw.slice(0, 4);
}

function toCoverUrl(posterPath) {
    const clean = String(posterPath || '').trim();
    if (!clean) return '';
    return `${TMDB_IMAGE_BASE}${clean.startsWith('/') ? '' : '/'}${clean}`;
}

function uniqStrings(values = []) {
    return Array.from(new Set(values.map(v => String(v || '').trim()).filter(Boolean)));
}

async function tmdbGet(endpoint, params = {}) {
    const url = `${TMDB_BASE_URL}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
    const headers = TMDB_BEARER ? { Authorization: `Bearer ${TMDB_BEARER}` } : {};
    const query = TMDB_API_KEY ? { ...params, api_key: TMDB_API_KEY } : { ...params };

    const res = await axios.get(url, {
        params: query,
        headers,
        timeout: REQUEST_TIMEOUT_MS
    });

    return res.data;
}

async function fetchPaged(endpoint, params, targetCount) {
    const out = [];
    let page = 1;
    let totalPages = 1;

    while (out.length < targetCount && page <= totalPages && page <= 25) {
        const data = await tmdbGet(endpoint, { ...params, page });
        const results = Array.isArray(data?.results) ? data.results : [];
        out.push(...results);
        totalPages = Number(data?.total_pages || 1) || 1;
        page += 1;
    }

    return out;
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

function loadLocalTvIndex() {
    if (!fs.existsSync(TV_INDEX_PATH)) {
        return { byImdb: new Map(), ranked: [] };
    }

    try {
        const payload = JSON.parse(fs.readFileSync(TV_INDEX_PATH, 'utf-8'));
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const ranked = items
            .map((item) => ({
                imdbId: normalizeImdbId(item.imdbId),
                title: String(item.title || '').trim(),
                originalTitle: String(item.originalTitle || '').trim(),
                startYear: String(item.startYear || '').trim(),
                endYear: String(item.endYear || '').trim(),
                genres: uniqStrings(String(item.genres || '').split(',').map(g => g.trim())),
                averageRating: Number(item.averageRating || 0) || 0,
                numVotes: Number(item.numVotes || 0) || 0,
                episodeCount: Number(item.episodeCount || 0) || 0,
                source: 'local-tv-index',
                popularity: Number(item.numVotes || 0) || 0,
                cover: ''
            }))
            .filter((item) => item.imdbId && item.title)
            .sort((a, b) => (b.numVotes - a.numVotes) || (b.averageRating - a.averageRating));

        const byImdb = new Map(ranked.map(item => [item.imdbId, item]));
        return { byImdb, ranked };
    } catch (_err) {
        return { byImdb: new Map(), ranked: [] };
    }
}

async function fetchGenreMap(mediaType) {
    const endpoint = mediaType === 'tv' ? '/genre/tv/list' : '/genre/movie/list';
    const data = await tmdbGet(endpoint);
    const rows = Array.isArray(data?.genres) ? data.genres : [];
    const map = new Map();
    rows.forEach((row) => {
        const id = Number(row?.id);
        if (!Number.isFinite(id)) return;
        map.set(id, String(row?.name || '').trim());
    });
    return map;
}

async function enrichWithExternalIds(mediaType, rows) {
    const endpointPrefix = mediaType === 'tv' ? '/tv' : '/movie';

    const enriched = await promisePool(rows, EXTERNAL_ID_CONCURRENCY, async (row) => {
        try {
            const external = await tmdbGet(`${endpointPrefix}/${encodeURIComponent(row.tmdbId)}/external_ids`);
            return {
                ...row,
                imdbId: normalizeImdbId(external?.imdb_id || row.imdbId)
            };
        } catch (_err) {
            return row;
        }
    });

    return enriched;
}

function writeCatalog(fileName, rows) {
    fs.mkdirSync(METADATA_DIR, { recursive: true });
    const target = path.join(METADATA_DIR, fileName);
    fs.writeFileSync(target, JSON.stringify(rows, null, 2), 'utf-8');
    return target;
}

async function buildTvCatalogs() {
    const genreMap = await fetchGenreMap('tv');
    const localTv = loadLocalTvIndex();

    const specs = [
        {
            fileName: 'catalog_tv_trending_50.json',
            endpoint: '/trending/tv/week',
            params: {},
            limit: 50,
            source: 'tmdb-trending-week'
        },
        {
            fileName: 'catalog_tv_popular_50.json',
            endpoint: '/discover/tv',
            params: { sort_by: 'popularity.desc', vote_count_gte: 50 },
            limit: 50,
            source: 'tmdb-discover-popular'
        },
        {
            fileName: 'catalog_tv_currently_airing_30.json',
            endpoint: '/tv/on_the_air',
            params: {},
            limit: 30,
            source: 'tmdb-on-the-air'
        },
        {
            fileName: 'catalog_tv_comedy_50.json',
            endpoint: '/discover/tv',
            params: { sort_by: 'popularity.desc', vote_count_gte: 40, with_genres: '35' },
            limit: 50,
            source: 'tmdb-discover-comedy'
        },
        {
            fileName: 'catalog_tv_drama_50.json',
            endpoint: '/discover/tv',
            params: { sort_by: 'popularity.desc', vote_count_gte: 40, with_genres: '18' },
            limit: 50,
            source: 'tmdb-discover-drama'
        },
        {
            fileName: 'catalog_tv_family_50.json',
            endpoint: '/discover/tv',
            params: { sort_by: 'popularity.desc', vote_count_gte: 20, with_genres: '10751' },
            limit: 50,
            source: 'tmdb-discover-family'
        }
    ];

    const outputs = [];

    for (const spec of specs) {
        const raw = await fetchPaged(spec.endpoint, spec.params, spec.limit + 40);

        const base = raw.map((item) => {
            const tmdbId = Number(item?.id);
            const genres = uniqStrings((Array.isArray(item?.genre_ids) ? item.genre_ids : [])
                .map((genreId) => genreMap.get(Number(genreId)) || ''));

            return {
                tmdbId,
                imdbId: '',
                title: String(item?.name || item?.original_name || '').trim(),
                originalTitle: String(item?.original_name || item?.name || '').trim(),
                startYear: toYear(item?.first_air_date),
                endYear: '',
                genres,
                averageRating: Number(item?.vote_average || 0) || 0,
                numVotes: Number(item?.vote_count || 0) || 0,
                popularity: Number(item?.popularity || 0) || 0,
                episodeCount: 0,
                source: spec.source,
                cover: toCoverUrl(item?.poster_path)
            };
        }).filter(row => Number.isFinite(row.tmdbId) && row.title);

        const enriched = await enrichWithExternalIds('tv', base);

        const merged = [];
        const seen = new Set();
        for (const row of enriched) {
            if (!row.imdbId) continue;
            const local = localTv.byImdb.get(row.imdbId);
            const combined = {
                ...row,
                title: local?.title || row.title,
                originalTitle: local?.originalTitle || row.originalTitle || row.title,
                startYear: local?.startYear || row.startYear,
                endYear: local?.endYear || row.endYear,
                genres: uniqStrings([...(Array.isArray(row.genres) ? row.genres : []), ...(Array.isArray(local?.genres) ? local.genres : [])]),
                averageRating: row.averageRating || local?.averageRating || 0,
                numVotes: Math.max(Number(row.numVotes || 0), Number(local?.numVotes || 0)),
                episodeCount: Number(local?.episodeCount || row.episodeCount || 0),
                source: local ? `${row.source}+local-tv-index` : row.source,
                cover: row.cover || local?.cover || ''
            };

            if (seen.has(combined.imdbId)) continue;
            seen.add(combined.imdbId);
            merged.push(combined);
            if (merged.length >= spec.limit) break;
        }

        if (merged.length < spec.limit) {
            for (const localItem of localTv.ranked) {
                if (!localItem.imdbId || seen.has(localItem.imdbId)) continue;
                seen.add(localItem.imdbId);
                merged.push(localItem);
                if (merged.length >= spec.limit) break;
            }
        }

        const trimmed = merged.slice(0, spec.limit);
        const outputPath = writeCatalog(spec.fileName, trimmed);
        outputs.push({ file: outputPath, count: trimmed.length });
    }

    return outputs;
}

async function buildMovieCatalogs() {
    const genreMap = await fetchGenreMap('movie');

    const specs = [
        {
            fileName: 'catalog_movie_trending_50.json',
            endpoint: '/trending/movie/week',
            params: {},
            limit: 50,
            source: 'tmdb-trending-week'
        },
        {
            fileName: 'catalog_movie_popular_50.json',
            endpoint: '/discover/movie',
            params: { sort_by: 'popularity.desc', vote_count_gte: 100 },
            limit: 50,
            source: 'tmdb-discover-popular'
        },
        {
            fileName: 'catalog_movie_new_50.json',
            endpoint: '/discover/movie',
            params: {
                sort_by: 'popularity.desc',
                vote_count_gte: 25,
                primary_release_date_gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
            },
            limit: 50,
            source: 'tmdb-discover-new'
        }
    ];

    const outputs = [];

    for (const spec of specs) {
        const raw = await fetchPaged(spec.endpoint, spec.params, spec.limit + 40);

        const base = raw.map((item) => {
            const tmdbId = Number(item?.id);
            const genres = uniqStrings((Array.isArray(item?.genre_ids) ? item.genre_ids : [])
                .map((genreId) => genreMap.get(Number(genreId)) || ''));

            return {
                tmdbId,
                imdbId: '',
                id: '',
                title: String(item?.title || item?.original_title || '').trim(),
                year: toYear(item?.release_date),
                rating: Number(item?.vote_average || 0) || 0,
                votes: Number(item?.vote_count || 0) || 0,
                genres,
                popularity: Number(item?.popularity || 0) || 0,
                source: spec.source,
                cover: toCoverUrl(item?.poster_path)
            };
        }).filter(row => Number.isFinite(row.tmdbId) && row.title);

        const enriched = await enrichWithExternalIds('movie', base);

        const deduped = [];
        const seen = new Set();
        for (const row of enriched) {
            if (!row.imdbId) continue;
            const imdbId = normalizeImdbId(row.imdbId);
            if (!imdbId || seen.has(imdbId)) continue;
            seen.add(imdbId);
            deduped.push({ ...row, imdbId, id: imdbId });
            if (deduped.length >= spec.limit) break;
        }

        const outputPath = writeCatalog(spec.fileName, deduped.slice(0, spec.limit));
        outputs.push({ file: outputPath, count: deduped.length });
    }

    return outputs;
}

async function main() {
    const tv = await buildTvCatalogs();
    const movies = await buildMovieCatalogs();

    console.log('Built TV catalogs:');
    tv.forEach(item => console.log(`- ${item.file} (${item.count})`));

    console.log('Built movie catalogs:');
    movies.forEach(item => console.log(`- ${item.file} (${item.count})`));
}

main().catch((err) => {
    console.error(`Failed to build TMDb catalogs: ${err.message}`);
    process.exit(1);
});
