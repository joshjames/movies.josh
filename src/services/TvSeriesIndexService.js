const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.join(__dirname, '../../movie-streamer-data');
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

function searchIndex(query, limit = 40) {
    const index = loadIndex();
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

module.exports = {
    PRIMARY_INDEX_FILE,
    LEGACY_INDEX_FILE,
    loadIndex,
    searchIndex,
    getSeriesByImdbId,
    buildSearchText,
    normalizeTerm,
    normalizeImdbId,
    buildSeriesRegistryItem,
    buildIndexFromLibrary,
    refreshIndexFromLibrary,
    writeIndex
};