// src/services/EztvCatalogService.js
// Single shared EZTV raw-fetch + disk cache, replacing three independent
// copies of the same page-walking fetch (torrent.routes.js's fetchEztvPages,
// SeriesAcquisitionService.js's fetchEztvPages, SeriesAutoGetService.js's
// fetchEztvCandidates) that each hit eztv.wf/eztv.re live on every call with
// zero caching. Callers keep their own scoring/selection logic - this only
// centralizes the "get me the raw torrent rows for this imdbId" part.
//
// Unlike the cover-image cache this pattern is modeled on, an imdbId's EZTV
// listing is NOT immutable - new episodes appear here over time, and the
// whole point of the TV auto-get tiers (see SeriesAutoGetService.js) is to
// notice that. So this uses a short TTL rather than "cache forever": long
// enough to collapse duplicate concurrent lookups (a manual browse landing
// mid-tick, or multiple rules sharing a show) into one upstream fetch, short
// enough to never meaningfully delay a real new-episode pickup.
'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');

const CACHE_DIR = String(process.env.EZTV_CACHE_DIR || '').trim()
    || path.join(__dirname, '../../metadata/eztv-cache');
const CACHE_TTL_MS = Math.max(60 * 1000, parseInt(process.env.EZTV_CACHE_TTL_MS, 10) || 10 * 60 * 1000);
const ENDPOINT_CANDIDATES = ['https://eztv.wf/api/get-torrents', 'https://eztv.re/api/get-torrents'];

function ensureCacheDir() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePathFor(imdbDigits) {
    return path.join(CACHE_DIR, `${imdbDigits}.json`);
}

function readCache(imdbDigits) {
    try {
        const filePath = cachePathFor(imdbDigits);
        const stats = fs.statSync(filePath);
        if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function writeCache(imdbDigits, payload) {
    try {
        ensureCacheDir();
        fs.writeFileSync(cachePathFor(imdbDigits), JSON.stringify(payload), 'utf-8');
    } catch (err) {
        logger.warn(`[EztvCatalog] Failed writing cache for ${imdbDigits}: ${err.message}`);
    }
}

async function fetchLive(imdbDigits, maxPages) {
    const collected = [];
    const upstreamWarnings = [];
    let scannedPages = 0;

    for (let page = 1; page <= maxPages; page++) {
        scannedPages += 1;
        let pageData = null;
        let lastError = null;

        for (const endpoint of ENDPOINT_CANDIDATES) {
            try {
                const response = await axios.get(`${endpoint}?imdb_id=${imdbDigits}&limit=100&page=${page}`, {
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

    return { torrents: collected, scannedPages, upstreamWarnings };
}

/**
 * Raw EZTV torrent rows for an imdbId, cached on disk for CACHE_TTL_MS.
 * Returns the same shape the old per-file fetchEztvPages() functions did
 * (torrents/scannedPages/upstreamWarnings), plus a cacheHit flag.
 */
async function getTorrentsForImdb(imdbId, { maxPages = 5, forceRefresh = false } = {}) {
    const imdbDigits = String(imdbId || '').replace(/^tt/i, '').trim();
    if (!/^\d{5,10}$/.test(imdbDigits)) {
        return { torrents: [], scannedPages: 0, upstreamWarnings: ['invalid_imdb_id'], cacheHit: false };
    }

    if (!forceRefresh) {
        const cached = readCache(imdbDigits);
        if (cached) return { ...cached, cacheHit: true };
    }

    const fetched = await fetchLive(imdbDigits, maxPages);
    // Only cache a clean result (no page ever failed) - an upstream outage
    // shouldn't get "confirmed empty" treatment for CACHE_TTL_MS.
    if (fetched.upstreamWarnings.length === 0) {
        writeCache(imdbDigits, fetched);
    }

    return { ...fetched, cacheHit: false };
}

module.exports = {
    getTorrentsForImdb
};
