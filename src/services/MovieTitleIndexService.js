const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '../../metadata');
// movie-index.json (~56k titles, built alongside tv-show-index.json) is the
// actual broad IMDb catalog - the catalog_*.json files are small, separately
// curated lists (Top 100 All Time, Critics' Choices, Popular by decade,
// etc.) meant for the browse/catalogs feature, not a general title search
// source. Confirmed live: without this, findBestMatch could only ever
// resolve movies popular enough to land in one of those curated lists (or
// whatever the local library already happened to own) - anything more
// obscure (foreign titles especially) came back null.
const MAX_ENTRIES = Math.max(1000, Math.min(parseInt(process.env.MOVIE_INDEX_MAX || '60000', 10) || 60000, 100000));

let cache = {
    loadedAt: 0,
    maxMtimeMs: 0,
    items: []
};

function normalizeImdbId(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    return raw.startsWith('tt') ? raw : `tt${raw}`;
}

function normalizeText(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveCatalogDirs() {
    const fromEnv = String(process.env.CATALOG_DATA_DIR || '').trim();
    const dirs = [fromEnv, '/app/catalog-metadata', DEFAULT_DIR].filter(Boolean);
    return Array.from(new Set(dirs));
}

function listCatalogFiles() {
    const files = [];
    for (const dir of resolveCatalogDirs()) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            const isCuratedCatalog = /^catalog_.*\.json$/i.test(name);
            const isBroadIndex = name.toLowerCase() === 'movie-index.json';
            if (!isCuratedCatalog && !isBroadIndex) continue;
            files.push(path.join(dir, name));
        }
    }
    return Array.from(new Set(files));
}

function readJsonArray(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
        return [];
    }
}

function getFileMaxMtime(files = []) {
    let max = 0;
    for (const filePath of files) {
        try {
            const mtimeMs = fs.statSync(filePath).mtimeMs || 0;
            if (mtimeMs > max) max = mtimeMs;
        } catch (_err) {
            // ignore unreadable file
        }
    }
    return max;
}

function normalizeMovieRow(row = {}) {
    const imdbId = normalizeImdbId(row.imdbId || row.id || row.imdbID || '');
    const title = String(row.title || row.name || '').trim();
    const year = String(row.year || row.startYear || '').trim();
    const rating = Number(row.rating || row.averageRating || 0) || 0;
    const votes = Number(row.votes || row.numVotes || 0) || 0;
    const genres = Array.isArray(row.genres)
        ? row.genres.filter(Boolean)
        : String(row.genres || '').split(',').map(v => v.trim()).filter(Boolean);

    if (!imdbId || !title) return null;

    const searchText = normalizeText([
        imdbId,
        title,
        year,
        genres.join(' ')
    ].join(' '));

    return {
        imdbId,
        title,
        year,
        rating,
        votes,
        genres,
        searchText
    };
}

function buildIndex() {
    const files = listCatalogFiles();
    const byImdb = new Map();

    for (const filePath of files) {
        const rows = readJsonArray(filePath);
        for (const row of rows) {
            const normalized = normalizeMovieRow(row);
            if (!normalized) continue;

            const existing = byImdb.get(normalized.imdbId);
            if (!existing) {
                byImdb.set(normalized.imdbId, normalized);
                continue;
            }

            const shouldReplace =
                normalized.votes > existing.votes ||
                (normalized.votes === existing.votes && normalized.rating > existing.rating) ||
                (!existing.year && normalized.year);

            if (shouldReplace) byImdb.set(normalized.imdbId, normalized);
        }
    }

    const merged = Array.from(byImdb.values())
        .sort((a, b) => {
            if (b.votes !== a.votes) return b.votes - a.votes;
            if (b.rating !== a.rating) return b.rating - a.rating;
            return a.title.localeCompare(b.title);
        })
        .slice(0, MAX_ENTRIES);

    return {
        files,
        items: merged
    };
}

function ensureLoaded(force = false) {
    const files = listCatalogFiles();
    const maxMtimeMs = getFileMaxMtime(files);

    if (!force && cache.items.length && cache.maxMtimeMs >= maxMtimeMs) {
        return cache;
    }

    const next = buildIndex();
    cache = {
        loadedAt: Date.now(),
        maxMtimeMs,
        items: next.items
    };
    return cache;
}

function searchIndex(query = '', limit = 30) {
    const index = ensureLoaded(false);
    const clean = normalizeText(query);
    const cappedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 30, 100));

    if (!clean) return index.items.slice(0, cappedLimit);

    const terms = clean.split(' ').filter(Boolean);
    return index.items
        .map((item) => {
            const titleNorm = normalizeText(item.title);
            let score = 0;

            for (const term of terms) {
                if (titleNorm === term) score += 12;
                else if (titleNorm.startsWith(term)) score += 8;
                else if (titleNorm.includes(term)) score += 5;
                else if (item.searchText.includes(term)) score += 2;
                else return null;
            }

            score += Math.min(120, Math.floor(item.votes / 10000));
            score += Math.floor(item.rating * 4);
            return { item, score };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.item.votes !== a.item.votes) return b.item.votes - a.item.votes;
            return a.item.title.localeCompare(b.item.title);
        })
        .slice(0, cappedLimit)
        .map(row => row.item);
}

function getByImdbId(imdbId = '') {
    const clean = normalizeImdbId(imdbId);
    if (!clean) return null;
    const index = ensureLoaded(false);
    return index.items.find(item => item.imdbId === clean) || null;
}

// Local title+year -> imdbId resolution, purely against this in-memory
// catalog (built from the downloaded IMDb TSV dump) - no external API call,
// unlike MetadataProvider.fetchMetadataWithFallback which always hits OMDb/
// TMDb. Deliberately returns null rather than a weak guess whenever a year
// is given but nothing in the text-matched candidates lines up with it -
// see feedback_never_guess_without_confirmed_data.md.
function findBestMatch(title, year) {
    const candidates = searchIndex(title, 25);
    if (!candidates.length) return null;

    const targetYear = parseInt(year, 10);
    if (!Number.isFinite(targetYear)) {
        return { item: candidates[0], matchQuality: 'title-only' };
    }

    const exact = candidates.find((item) => parseInt(item.year, 10) === targetYear);
    if (exact) return { item: exact, matchQuality: 'exact' };

    // Small tolerance for festival-premiere-vs-wide-release year drift -
    // only when nothing matched exactly.
    const close = candidates.find((item) => Math.abs(parseInt(item.year, 10) - targetYear) === 1);
    if (close) return { item: close, matchQuality: 'close' };

    return null;
}

module.exports = {
    searchIndex,
    getByImdbId,
    findBestMatch,
    ensureLoaded,
    normalizeImdbId,
    normalizeText
};
