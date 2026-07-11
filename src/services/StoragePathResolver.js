const fs = require('fs');
const path = require('path');

const MOVIE_DEFAULTS = [
    '/app/storage/movies',
    '/app/movies',
    '/home/epic/movies'
];

const SERIES_DEFAULTS = [
    '/app/storage/series',
    '/data/blockchain/media/Series',
    '/app/series',
    '/home/epic/movies/series'
];

function parsePathList(value = '') {
    return String(value || '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
}

function uniquePaths(values = []) {
    const seen = new Set();
    const output = [];

    for (const value of values) {
        if (!value) continue;
        const normalized = path.resolve(String(value));
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        output.push(String(value));
    }

    return output;
}

function withPrimaryFallback(paths = [], fallbackPaths = []) {
    if (paths.length > 0) return paths;

    const existing = fallbackPaths.filter(candidate => fs.existsSync(candidate));
    if (existing.length > 0) return uniquePaths(existing);

    return uniquePaths(fallbackPaths);
}

function getMovieRoots() {
    const configuredSources = parsePathList(process.env.MOVIE_SOURCES || process.env.MOVIES_SOURCES);
    const legacyPrimary = String(process.env.MOVIES_DIR || '').trim();
    return withPrimaryFallback(
        uniquePaths([legacyPrimary, ...configuredSources]),
        MOVIE_DEFAULTS
    );
}

function getSeriesRoots() {
    const configuredSources = parsePathList(process.env.SERIES_SOURCES);
    const legacyPrimary = String(process.env.SERIES_DIR || '').trim();
    return withPrimaryFallback(
        uniquePaths([legacyPrimary, ...configuredSources]),
        SERIES_DEFAULTS
    );
}

function getRootsForContentType(contentType = 'movie') {
    return String(contentType || '').toLowerCase() === 'series'
        ? getSeriesRoots()
        : getMovieRoots();
}

function getPrimaryMovieRoot() {
    const roots = getMovieRoots();
    return roots[0] || MOVIE_DEFAULTS[0];
}

function getPrimarySeriesRoot() {
    const roots = getSeriesRoots();
    return roots[0] || SERIES_DEFAULTS[0];
}

function resolveFolderPath(contentType, folderName, options = {}) {
    const cleanFolder = path.basename(String(folderName || '').trim());
    if (!cleanFolder || cleanFolder.includes('..')) return '';

    const roots = getRootsForContentType(contentType);
    const candidates = roots.map(root => path.join(root, cleanFolder));
    const existing = candidates.find(candidate => fs.existsSync(candidate));

    if (existing) return existing;
    if (options.mustExist) return '';

    const primaryRoot = String(contentType || '').toLowerCase() === 'series'
        ? getPrimarySeriesRoot()
        : getPrimaryMovieRoot();
    return path.join(primaryRoot, cleanFolder);
}

function resolveMovieFolderPath(folderName, options = {}) {
    return resolveFolderPath('movie', folderName, options);
}

function resolveSeriesFolderPath(folderName, options = {}) {
    return resolveFolderPath('series', folderName, options);
}

function resolveRelativePathInSeriesRoots(relativePath = '') {
    const cleanRelativePath = String(relativePath || '').replace(/^series[\\/]/i, '');
    if (!cleanRelativePath) return '';

    const normalizedRelative = path.normalize(cleanRelativePath);
    if (normalizedRelative.startsWith('..') || path.isAbsolute(normalizedRelative)) return '';

    for (const root of getSeriesRoots()) {
        const candidate = path.join(root, normalizedRelative);
        if (fs.existsSync(candidate)) return candidate;
    }

    return path.join(getPrimarySeriesRoot(), normalizedRelative);
}

function listSeriesFolders() {
    const folders = [];
    const seen = new Set();

    for (const root of getSeriesRoots()) {
        if (!fs.existsSync(root)) continue;

        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch (_err) {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

            const key = String(entry.name || '').toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            folders.push({ name: entry.name, path: path.join(root, entry.name), root });
        }
    }

    return folders;
}

module.exports = {
    getMovieRoots,
    getSeriesRoots,
    getRootsForContentType,
    getPrimaryMovieRoot,
    getPrimarySeriesRoot,
    resolveMovieFolderPath,
    resolveSeriesFolderPath,
    resolveRelativePathInSeriesRoots,
    listSeriesFolders
};
