const fs = require('fs');
const path = require('path');

const DATA_ROOT_CANDIDATES = [
    String(process.env.APP_DATA_DIR || '').trim(),
    '/app/metadata',
    path.join(__dirname, '../../metadata'),
    path.join(__dirname, '../../movie-streamer-data')
].filter(Boolean);
const DATA_ROOT = DATA_ROOT_CANDIDATES[0];
const PRIMARY_INDEX_FILE = path.join(DATA_ROOT, 'tv-series-index.json');
const LEGACY_INDEX_FILE = path.join(__dirname, '../../metadata/tv-show-index.json');

function ensureIndexDir(filePath) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (_err) {
        // Best-effort only.
    }
}

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^[0-9]{5,10}$/.test(cleaned)) return '';
    return `tt${cleaned}`;
}

function normalizeFolderName(value = '') {
    return String(value || '')
        .replace(/^series\//i, '')
    .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .pop() || '';
}

function decodeSeriesId(value = '') {
    const raw = String(value || '');
    const clean = raw.startsWith('series/') ? raw.slice('series/'.length) : raw;
    try {
        return decodeURIComponent(clean);
    } catch (_err) {
        return clean;
    }
}

function safeReadJson(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function readManifestEpisodeCount(seriesPath) {
    const manifestPath = path.join(seriesPath, 'series.json');
    const manifest = safeReadJson(manifestPath);
    if (!manifest || typeof manifest !== 'object') return 0;

    return Object.values(manifest.seasons || {}).reduce((count, season) => {
        const episodes = Array.isArray(season?.episodes) ? season.episodes.length : 0;
        return count + episodes;
    }, 0);
}

function buildSeriesRegistryItem(item = {}, index = 0) {
    const sourcePath = String(item.sourcePath || item.folderPath || '').trim();
    const folderName = normalizeFolderName(item.folder || item.folderName || decodeSeriesId(item.id || ''));
    const imdbId = normalizeImdbId(
        item.imdbId ||
        item.imdb_id ||
        item.imdbID ||
        item.metadata?.imdbId ||
        item.metadata?.imdb_id ||
        item.metadata?.imdbID ||
        ''
    );
    const seriesPath = sourcePath || null;
    const metadataPath = seriesPath ? path.join(seriesPath, 'metadata.json') : null;
    const seriesManifestPath = seriesPath ? path.join(seriesPath, 'series.json') : null;

    const episodeCount = Number.isFinite(item.episodeCount)
        ? Number(item.episodeCount)
        : (seriesPath ? readManifestEpisodeCount(seriesPath) : 0);

    return {
        id: item.id || (imdbId ? `series/${encodeURIComponent(folderName || item.title || imdbId)}` : `series/${encodeURIComponent(folderName || item.title || String(index + 1))}`),
        imdbId: imdbId || null,
        title: String(item.title || item.originalTitle || folderName || '').trim(),
        originalTitle: String(item.originalTitle || item.title || folderName || '').trim(),
        folderName: folderName || null,
        folderPath: sourcePath || null,
        seriesPath: seriesPath || null,
        metadataPath: metadataPath || null,
        seriesManifestPath: seriesManifestPath || null,
        contentType: 'series',
        storageLocation: item.storageLocation || item.storage?.location || 'local',
        updatedAt: item.updatedAt || null,
        addedAt: item.addedAt || null,
        year: item.year || null,
        genres: item.genre || item.genres || null,
        cover: item.cover || null,
        searchText: buildSearchText(item),
        episodeCount,
        totalSeasons: item.totalSeasons || null,
        sourcePath: sourcePath || null,
        registryVersion: 1
    };
}

function normalizeRegistry(raw = {}) {
    const items = Array.isArray(raw.items) ? raw.items : [];
    const normalized = items
        .filter((item) => item && typeof item === 'object')
        .map((item, index) => buildSeriesRegistryItem(item, index))
        .filter((item) => item.imdbId || item.folderName || item.title);

    normalized.sort((a, b) => {
        const titleCompare = String(a.title || '').localeCompare(String(b.title || ''));
        if (titleCompare !== 0) return titleCompare;
        return String(a.imdbId || '').localeCompare(String(b.imdbId || ''));
    });

    return {
        updatedAt: raw.updatedAt || new Date().toISOString(),
        totalItems: normalized.length,
        items: normalized,
        registryVersion: 1
    };
}

function readIndexFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return { updatedAt: null, totalItems: 0, items: [] };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return normalizeRegistry(parsed);
    } catch (_err) {
        return { updatedAt: null, totalItems: 0, items: [] };
    }
}

function loadIndex() {
    const primary = readIndexFile(PRIMARY_INDEX_FILE);
    if (primary.items.length > 0) return primary;

    const legacy = readIndexFile(LEGACY_INDEX_FILE);
    if (legacy.items.length > 0) {
        try {
            writeIndex(legacy);
        } catch (_err) {
            // Keep legacy compatibility even if the migration mirror fails.
        }
        return legacy;
    }

    return { updatedAt: null, totalItems: 0, items: [] };
}

function writeIndex(index = {}) {
    const normalized = normalizeRegistry(index);
    ensureIndexDir(PRIMARY_INDEX_FILE);
    fs.writeFileSync(PRIMARY_INDEX_FILE, JSON.stringify(normalized, null, 4), 'utf-8');

    try {
        ensureIndexDir(LEGACY_INDEX_FILE);
        fs.writeFileSync(LEGACY_INDEX_FILE, JSON.stringify(normalized, null, 4), 'utf-8');
    } catch (_err) {
        // Legacy mirror is best-effort.
    }

    return normalized;
}

function buildIndexFromLibrary(library = {}) {
    const shows = Array.isArray(library.shows) ? library.shows : [];
    return normalizeRegistry({
        updatedAt: new Date().toISOString(),
        items: shows.map((show) => buildSeriesRegistryItem(show))
    });
}

function refreshIndexFromLibrary(library = {}) {
    const index = buildIndexFromLibrary(library);
    return writeIndex(index);
}

function normalizeTerm(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSearchText(item) {
    return normalizeTerm([
        item.title,
        item.originalTitle,
        item.genres,
        item.startYear,
        item.endYear,
        item.imdbId
    ].filter(Boolean).join(' '));
}

function searchIndex(query, limit = 40, indexOverride = null) {
    const index = indexOverride || loadIndex();
    const cleanQuery = normalizeTerm(query);
    const cappedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 40, 100));

    if (!cleanQuery) {
        return index.items.slice(0, cappedLimit);
    }

    const queryTerms = cleanQuery.split(' ').filter(Boolean);
    return index.items
        .map(item => {
            const haystack = item.searchText || buildSearchText(item);
            const titleNorm = normalizeTerm(item.title || item.originalTitle || '');

            let score = 0;
            for (const term of queryTerms) {
                if (titleNorm === term) score += 8;
                else if (titleNorm.startsWith(term)) score += 5;
                else if (titleNorm.includes(term)) score += 3;
                else if (haystack.includes(term)) score += 1;
                else return null;
            }

            return {
                item,
                score
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if ((b.item.numVotes || 0) !== (a.item.numVotes || 0)) return (b.item.numVotes || 0) - (a.item.numVotes || 0);
            if ((b.item.averageRating || 0) !== (a.item.averageRating || 0)) return (b.item.averageRating || 0) - (a.item.averageRating || 0);
            return String(a.item.title || '').localeCompare(String(b.item.title || ''));
        })
        .slice(0, cappedLimit)
        .map(row => row.item);
}

function getSeriesByImdbId(imdbId) {
    const index = loadIndex();
    const cleanImdbId = String(imdbId || '').replace(/^tt/i, '').trim();
    return index.items.find(item => String(item.imdbId || '').replace(/^tt/i, '') === cleanImdbId) || null;
}

// A show's run year shows up in two different shapes depending on which
// underlying file loadIndex() actually served: separate startYear/endYear
// fields (the IMDb-TSV-built legacy catalog) or a single "2008–2013"-style
// range string (the library-derived registry buildSeriesRegistryItem
// produces, which is what loadIndex() prefers whenever the library isn't
// empty). Handles both rather than assuming one.
function extractYearRange(item) {
    const start = parseInt(item.startYear, 10);
    if (Number.isFinite(start)) {
        const end = parseInt(item.endYear, 10);
        return { start, end: Number.isFinite(end) ? end : start };
    }

    const numbers = String(item.year || '').match(/\d{4}/g);
    if (!numbers || !numbers.length) return null;
    return {
        start: parseInt(numbers[0], 10),
        end: parseInt(numbers[numbers.length - 1], 10)
    };
}

// loadIndex() prefers the library-derived registry (PRIMARY_INDEX_FILE)
// over the broad IMDb-TSV-built catalog (LEGACY_INDEX_FILE) whenever the
// library isn't empty - by design, for the existing "shows I already own"
// admin search. That means a plain searchIndex() call almost never actually
// reaches the ~20k-title broad catalog once any show has been scanned in
// (confirmed live: 60 library items vs 22863 in the real catalog file).
// findBestMatch wants the opposite default - "resolve any show's imdbId",
// owned or not - so it searches the broad catalog directly first.
//
// LEGACY_INDEX_FILE itself turned out not to be usable for this: it's a
// hardcoded path under the writable data root, and writeIndex() mirrors the
// library-derived registry to that exact same path - confirmed live, that
// file is a ~60-item mirror, not the real catalog. build-tv-show-index.js
// actually writes the real ~23k-item file under /app/catalog-metadata (the
// read-only, git-tracked mount) - the same directory MovieTitleIndexService
// already checks for its own catalog files - so this looks there directly
// instead of reusing LEGACY_INDEX_FILE's path.
const BROAD_CATALOG_DIRS = [
    String(process.env.CATALOG_DATA_DIR || '').trim(),
    '/app/catalog-metadata',
    path.join(__dirname, '../../metadata')
].filter(Boolean);

// Deliberately does NOT go through readIndexFile/normalizeRegistry -
// buildSeriesRegistryItem (what normalizeRegistry maps every item through)
// only reads a single item.year field, built for the library-derived
// registry's shape. The real catalog's items carry startYear/endYear
// instead, which buildSeriesRegistryItem silently drops (year ends up
// null), confirmed live: it also already carries everything searchIndex's
// scoring needs (title, imdbId, searchText, numVotes, averageRating), so no
// normalization is needed at all here - just read it as-is.
function loadBroadIndex() {
    for (const dir of BROAD_CATALOG_DIRS) {
        const filePath = path.join(dir, 'tv-show-index.json');
        if (!fs.existsSync(filePath)) continue;
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const items = Array.isArray(parsed.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
            if (items.length > 0) return { items };
        } catch (_err) {
            // Try the next candidate directory.
        }
    }
    return { items: [] };
}

// Local title+year -> imdbId resolution - no external API call. Tries the
// full IMDb-derived catalog first, then falls back to the library-derived
// registry (covers a show added since the catalog was last rebuilt). A
// show's year is a run, not a single value, so a year falling anywhere in
// that range counts as a match - more forgiving than the movie version by
// nature, not by an extra tolerance pass.
function findBestMatch(title, year) {
    const broadIndex = loadBroadIndex();
    let candidates = broadIndex.items.length ? searchIndex(title, 25, broadIndex) : [];
    if (!candidates.length) {
        candidates = searchIndex(title, 25);
    }
    if (!candidates.length) return null;

    const targetYear = parseInt(year, 10);
    if (!Number.isFinite(targetYear)) {
        return { item: candidates[0], matchQuality: 'title-only' };
    }

    const withinRun = (item) => {
        const range = extractYearRange(item);
        return Boolean(range) && targetYear >= range.start && targetYear <= range.end;
    };

    const match = candidates.find(withinRun);
    return match ? { item: match, matchQuality: 'exact' } : null;
}

module.exports = {
    PRIMARY_INDEX_FILE,
    LEGACY_INDEX_FILE,
    loadIndex,
    searchIndex,
    getSeriesByImdbId,
    findBestMatch,
    buildSearchText,
    normalizeTerm,
    normalizeImdbId,
    buildSeriesRegistryItem,
    buildIndexFromLibrary,
    refreshIndexFromLibrary,
    writeIndex
};