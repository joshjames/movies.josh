// src/services/LibraryScanner.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { syncLibraryToStorage } = require('./db');

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

        // Read metadata if it exists
        if (fs.existsSync(metaPath)) {
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            } catch (e) {
                logger.warn(`Mangled metadata configuration block at: ${folder}`);
            }
        }

        const remoteProfiles = Object.values(meta.storage?.files || {}).filter(fileBlock =>
            fileBlock && fileBlock.status === 'synced' && Boolean(fileBlock.remoteKey)
        );

        const normalizedTitle = meta.title || meta.metadata?.title || folder.replace(/[-_.]/g, ' ');
        const normalizedYear = meta.year || meta.metadata?.year || '';
        const normalizedPlot = meta.plot || meta.metadata?.plot || '';
        const normalizedGenre = meta.genre || meta.metadata?.genre || '';
        const normalizedImdbId = meta.imdbId || meta.imdb_id || meta.metadata?.imdbId || meta.metadata?.imdb_id || '';

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
                contentType: contentType,
                storageLocation: isRemote ? 'remote' : 'local',
                cover: contentType === 'series'
                    ? `/movie-assets/series/${encodeURIComponent(folder)}/cover.jpg`
                    : `/movie-assets/${encodeURIComponent(folder)}/cover.jpg`,

                // Keep the raw block intact just in case other services need it
                storage: normalizedStorage,
                updatedAt: new Date().toISOString(),
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