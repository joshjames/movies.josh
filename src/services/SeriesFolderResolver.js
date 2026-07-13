const fs = require('fs');
const path = require('path');
const { listSeriesFolders } = require('./StoragePathResolver');

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return '';
    return `tt${cleaned}`;
}

function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function extractImdbIdFromMetadata(metadata = {}) {
    return normalizeImdbId(
        metadata.imdbId ||
        metadata.imdb_id ||
        metadata.imdbID ||
        metadata.metadata?.imdbId ||
        metadata.metadata?.imdb_id ||
        metadata.metadata?.imdbID ||
        ''
    );
}

function findSeriesFolderByImdbId(imdbId) {
    const cleanImdbId = normalizeImdbId(imdbId);
    if (!cleanImdbId) return null;

    const folders = listSeriesFolders();
    for (const folder of folders) {
        const metadataPath = path.join(folder.path, 'metadata.json');
        const metadata = readJsonSafe(metadataPath) || {};
        const candidateImdbId = extractImdbIdFromMetadata(metadata);

        if (candidateImdbId && candidateImdbId === cleanImdbId) {
            return {
                imdbId: cleanImdbId,
                folderName: folder.name,
                folderPath: folder.path,
                metadataPath
            };
        }
    }

    return null;
}

function ensureSeriesMetadataImdb(showRootPath, { imdbId = '', title = '' } = {}) {
    const cleanImdbId = normalizeImdbId(imdbId);
    if (!cleanImdbId || !showRootPath) return { updated: false, imdbId: cleanImdbId };

    const folderName = path.basename(showRootPath);
    const metadataPath = path.join(showRootPath, 'metadata.json');
    const existing = readJsonSafe(metadataPath) || {};

    const merged = {
        ...existing,
        title: existing.title || title || folderName.replace(/[._-]/g, ' '),
        contentType: 'series',
        imdbId: cleanImdbId,
        imdb_id: cleanImdbId,
        metadata: {
            ...(existing.metadata || {}),
            imdbId: cleanImdbId,
            imdb_id: cleanImdbId
        },
        pipelineState: {
            ...(existing.pipelineState || {}),
            currentStep: existing.pipelineState?.currentStep || 'METADATA',
            lastUpdated: new Date().toISOString(),
            error: null
        }
    };

    fs.writeFileSync(metadataPath, JSON.stringify(merged, null, 4), 'utf-8');
    return { updated: true, imdbId: cleanImdbId, metadataPath };
}

module.exports = {
    normalizeImdbId,
    extractImdbIdFromMetadata,
    findSeriesFolderByImdbId,
    ensureSeriesMetadataImdb
};
