// src/services/LibraryScanner.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { syncLibraryToStorage } = require('./db');
const { normalizeGroups } = require('./LibraryAccessService');

const MOVIE_SCAN_PATHS = [
    process.env.MOVIES_DIR,
    '/app/storage/movies',
    '/app/movies',
    '/home/epic/movies'
].filter((v, i, arr) => v && arr.indexOf(v) === i);

const SERIES_SCAN_PATHS = [
    process.env.SERIES_DIR,
    '/app/storage/series',
    '/app/series',
    '/data/blockchain/media/Series',
    '/home/epic/movies/series'
].filter((v, i, arr) => v && arr.indexOf(v) === i);

const REQUIRE_METADATA_FOR_MOVIE_SCAN = !['false', '0', 'no'].includes(
    String(process.env.REQUIRE_METADATA_FOR_MOVIE_SCAN || 'true').trim().toLowerCase()
);
const REQUIRE_METADATA_FOR_SERIES_SCAN = ['true', '1', 'yes'].includes(
    String(process.env.REQUIRE_METADATA_FOR_SERIES_SCAN || 'false').trim().toLowerCase()
);

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return '';
    return `tt${cleaned}`;
}

function findImdbMarkerFile(itemPath) {
    try {
        const entries = fs.readdirSync(itemPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const match = String(entry.name || '').match(/^metadata\.(tt)?(\d{5,10})$/i);
            if (!match) continue;
            return normalizeImdbId(match[2]);
        }
    } catch (_err) {
        return '';
    }
    return '';
}

function hasPartialDownloadMarkers(itemPath) {
    try {
        const entries = fs.readdirSync(itemPath, { withFileTypes: true });
        return entries.some((entry) => {
            const name = String(entry.name || '').toLowerCase();
            if (!name) return false;
            if (entry.isDirectory()) {
                return name === '.unwanted' || name === '.incomplete' || name === '__incomplete';
            }
            return (
                name.endsWith('.!qb') ||
                name.endsWith('.part') ||
                name.endsWith('.partial') ||
                name.endsWith('.tmp') ||
                name.endsWith('.crdownload') ||
                name.endsWith('.pieces')
            );
        });
    } catch (_err) {
        return false;
    }
}

function scanDirectory(basePath, contentType) {
    const registry = [];
    if (!fs.existsSync(basePath)) {
        logger.debug(`⏭️ Skipping unavailable scan root: ${basePath}`);
        return registry;
    }

    const folders = fs.readdirSync(basePath).filter(f => !f.startsWith('.'));

    for (const folder of folders) {
        const itemPath = path.join(basePath, folder);
        if (!fs.lstatSync(itemPath).isDirectory()) continue;

        const metaPath = path.join(itemPath, 'metadata.json');
        let meta = { title: folder, year: '', plot: '', genre: '', contentType };

        const hasMetadataFile = fs.existsSync(metaPath);
        // Read metadata if it exists
        if (hasMetadataFile) {
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            } catch (e) {
                logger.warn(`Mangled metadata configuration block at: ${folder}`);
            }
        }

        const metadataImdbId = normalizeImdbId(meta.imdbId || meta.imdb_id || meta.metadata?.imdbId || meta.metadata?.imdb_id || '');
        const markerImdbId = findImdbMarkerFile(itemPath);
        const effectiveImdbId = metadataImdbId || markerImdbId;

        const remoteProfiles = Object.values(meta.storage?.files || {}).filter(fileBlock =>
            fileBlock && fileBlock.status === 'synced' && Boolean(fileBlock.remoteKey)
        );

        const normalizedTitle = meta.title || meta.metadata?.title || folder.replace(/[-_.]/g, ' ');
        const normalizedYear = meta.year || meta.metadata?.year || '';
        const normalizedPlot = meta.plot || meta.metadata?.plot || '';
        const normalizedGenre = meta.genre || meta.metadata?.genre || '';
        const normalizedImdbId = effectiveImdbId || '';
        const normalizedLibraryGroups = normalizeGroups(
            meta.libraryGroups || meta.metadata?.libraryGroups || [],
            { addGlobalIfMissing: true }
        );
        const normalizedTags = [...new Set(
            (Array.isArray(meta.tags) ? meta.tags : (Array.isArray(meta.enrichment?.tags) ? meta.enrichment.tags : (Array.isArray(meta.metadata?.tags) ? meta.metadata.tags : [])))
                .map(tag => String(tag).trim())
                .filter(Boolean)
        )].sort();
        const normalizedEnrichment = {
            genre: meta.enrichment?.genre || meta.metadata?.enrichment?.genre || normalizedGenre,
            tags: normalizedTags.length > 0 ? normalizedTags : [...new Set((normalizedGenre ? normalizedGenre.split(',') : []).map(tag => tag.trim()).filter(Boolean))].sort(),
            imdbScore: meta.imdbScore || meta.imdbRating || meta.rating || meta.metadata?.imdbScore || meta.metadata?.imdbRating || meta.metadata?.rating || 'N/A',
            parentalRating: meta.parentalRating || meta.rated || meta.metadata?.parentalRating || meta.metadata?.rated || 'N/A',
            popularity: meta.popularity || meta.metadata?.popularity || 'N/A',
            popularitySource: meta.enrichment?.popularitySource || meta.metadata?.enrichment?.popularitySource || ''
        };
        const statUpdatedAt = (() => {
            try {
                return fs.statSync(itemPath).mtime.toISOString();
            } catch (_err) {
                return null;
            }
        })();
        const normalizedUpdatedAt =
            meta.updatedAt ||
            meta.pipelineState?.lastUpdated ||
            meta.metadata?.updatedAt ||
            statUpdatedAt ||
            null;
        const normalizedAddedAt =
            meta.addedAt ||
            meta.metadata?.addedAt ||
            normalizedUpdatedAt ||
            null;

        // Treat the item as remote when either explicit location is remote or we have synced remote keys.
        const isRemote = meta.storage?.location === 'remote' || remoteProfiles.length > 0;
        const normalizedStorage = {
            ...(meta.storage || {}),
            location: isRemote ? 'remote' : 'local',
            files: {
                ...(meta.storage?.files || {})
            }
        };
        
        // Scan for local video assets if it's not hosted in the cloud cloud environment
        let mediaFiles = [];
        if (fs.existsSync(itemPath)) {
            mediaFiles = fs.readdirSync(itemPath).filter(f => f.endsWith('.mp4') || f.endsWith('.mkv'));
        }

        const hasPartialMarkers = hasPartialDownloadMarkers(itemPath);
        const mustHaveMetadata = contentType === 'series'
            ? REQUIRE_METADATA_FOR_SERIES_SCAN
            : REQUIRE_METADATA_FOR_MOVIE_SCAN;
        const hasImdbReference = Boolean(effectiveImdbId);

        if (!isRemote && mustHaveMetadata && !hasMetadataFile && !markerImdbId) {
            logger.debug(`⏭️ Skipping unmanaged ${contentType} folder (missing metadata.json or metadata.<IMDBID> marker): ${folder}`);
            continue;
        }

        if (!isRemote && mustHaveMetadata && !hasImdbReference) {
            logger.debug(`⏭️ Skipping unmanaged ${contentType} folder (missing IMDb reference in metadata.json or metadata.<IMDBID>): ${folder}`);
            continue;
        }

        if (hasPartialMarkers) {
            logger.debug(`⏭️ Skipping partial/incomplete folder from scan: ${folder}`);
            continue;
        }

        if (mediaFiles.length > 0 || isRemote || contentType === 'series') {
            registry.push({
                // 🚨 FLATTENED ROOT PROPERTIES FOR THE FRONTEND
                id: contentType === 'series' ? `series/${encodeURIComponent(folder)}` : encodeURIComponent(folder),
                title: normalizedTitle,
                year: normalizedYear,
                plot: normalizedPlot,
                genre: normalizedGenre,
                imdbId: normalizedImdbId,
                imdb_id: normalizedImdbId,
                libraryGroups: normalizedLibraryGroups,
                tags: normalizedEnrichment.tags,
                imdbScore: normalizedEnrichment.imdbScore,
                parentalRating: normalizedEnrichment.parentalRating,
                popularity: normalizedEnrichment.popularity,
                enrichment: normalizedEnrichment,
                contentType: contentType,
                storageLocation: isRemote ? 'remote' : 'local',
                cover: contentType === 'series'
                    ? `/movie-assets/series/${encodeURIComponent(folder)}/cover.jpg`
                    : `/movie-assets/${encodeURIComponent(folder)}/cover.jpg`,

                // Keep the raw block intact just in case other services need it
                storage: normalizedStorage,
                addedAt: normalizedAddedAt,
                updatedAt: normalizedUpdatedAt,
                sourcePath: itemPath
            });
        } else {
            logger.info(`🗑️ Stripping empty untracked local trace directory from listings: ${folder}`);
        }
    }
    return registry;
}

function scanAcrossRoots(roots, contentType) {
    const dedup = new Map();

    for (const root of roots) {
        const rows = scanDirectory(root, contentType);
        for (const row of rows) {
            const key = row.id;
            if (!dedup.has(key)) {
                dedup.set(key, row);
            }
        }
    }

    return Array.from(dedup.values());
}

async function runLibraryScanSweep() {
    logger.info('🔍 Executing system-wide library asset inventory sweep...');

    const existingMovieRoots = MOVIE_SCAN_PATHS.filter(root => fs.existsSync(root));
    const existingSeriesRoots = SERIES_SCAN_PATHS.filter(root => fs.existsSync(root));

    if (existingMovieRoots.length === 0) {
        logger.warn(`⚠️ No movie roots available for scan. Candidates: ${MOVIE_SCAN_PATHS.join(', ')}`);
    }
    if (existingSeriesRoots.length === 0) {
        logger.warn(`⚠️ No series roots available for scan. Candidates: ${SERIES_SCAN_PATHS.join(', ')}`);
    }
    
    // Process distinct storage lines independently across all known mount roots.
    const movies = scanAcrossRoots(existingMovieRoots, 'movie');
    const shows = scanAcrossRoots(existingSeriesRoots, 'series');

    const masterPayload = { movies, shows, lastScan: new Date().toISOString() };
    
    // Sync to Redis hot memory + Fallback storage file instantly
    await syncLibraryToStorage(masterPayload);
    logger.info(
        `✨ Inventory sweep complete. Cached [${movies.length}] Movies and [${shows.length}] Series. ` +
        `Movie roots: ${existingMovieRoots.join(', ') || '(none)'} | ` +
        `Series roots: ${existingSeriesRoots.join(', ') || '(none)'}`
    );

    return {
        movies: movies.length,
        shows: shows.length,
        movieRoots: existingMovieRoots,
        seriesRoots: existingSeriesRoots
    };
}

module.exports = { runLibraryScanSweep };