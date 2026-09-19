// src/services/YtsCatalogService.js
// Single shared YTS raw-fetch + disk cache. torrent.routes.js's /yts/browse
// and media.routes.js's /movies/search/unified both call the exact same
// upstream (movies-api.accel.li's list_movies.json) independently, live on
// every request, with no caching either. This centralizes that fetch;
// callers keep interpreting the response themselves (browse vs search have
// slightly different shapes they care about).
//
// Cache key is the full, sorted param set (page/genre/rating/sort/query) -
// unlike EZTV's per-imdbId key, YTS browsing/search has no single stable
// identity, so each distinct query gets its own cache entry. Short TTL for
// the same reason as EztvCatalogService: this is a live catalog, not an
// immutable asset.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('./logger');

const CACHE_DIR = String(process.env.YTS_CACHE_DIR || '').trim()
    || path.join(__dirname, '../../metadata/yts-cache');
const CACHE_TTL_MS = Math.max(60 * 1000, parseInt(process.env.YTS_CACHE_TTL_MS, 10) || 15 * 60 * 1000);
const YTS_URL = 'https://movies-api.accel.li/api/v2/list_movies.json';

function ensureCacheDir() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKeyFor(params = {}) {
    const sorted = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('&');
    return crypto.createHash('sha1').update(sorted).digest('hex');
}

function cachePathFor(key) {
    return path.join(CACHE_DIR, `${key}.json`);
}

function readCache(key) {
    try {
        const filePath = cachePathFor(key);
        const stats = fs.statSync(filePath);
        if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function writeCache(key, payload) {
    try {
        ensureCacheDir();
        fs.writeFileSync(cachePathFor(key), JSON.stringify(payload), 'utf-8');
    } catch (err) {
        logger.warn(`[YtsCatalog] Failed writing cache for ${key}: ${err.message}`);
    }
}

/**
 * Raw YTS list_movies.json response body for a given param set, cached on
 * disk for CACHE_TTL_MS. Returns the upstream JSON envelope unchanged
 * ({status, status_message, data: {...}}) plus a cacheHit flag.
 */
async function browse(params = {}, { forceRefresh = false } = {}) {
    const key = cacheKeyFor(params);

    if (!forceRefresh) {
        const cached = readCache(key);
        if (cached) return { ...cached, cacheHit: true };
    }

    const response = await axios.get(YTS_URL, { params, timeout: 12000 });
    const body = response.data || {};
    writeCache(key, body);

    return { ...body, cacheHit: false };
}

module.exports = {
    browse
};
