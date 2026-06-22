// src/services/CacheWorker.js
// High-performance asynchronous background RAM catalog compiler indexing local storage media.

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const MOVIES_DIR = process.env.MOVIES_DIR || (fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies');

// Initialize the global arrays cleanly on first load configuration bounds
global.INSTANT_LIBRARY_CACHE = [];

function rebuildLibraryCache() {
    try {
        if (!fs.existsSync(MOVIES_DIR)) {
            global.INSTANT_LIBRARY_CACHE = [];
            return;
        }

        const folders = fs.readdirSync(MOVIES_DIR);
        let temporaryCache = [];

        // =========================================================================
        // Sub-Pass A: Movies Root Scanner
        // =========================================================================
        const cleanMovies = folders.filter(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);
            if (folder.startsWith('.') || !fs.lstatSync(folderPath).isDirectory()) return false;
            if (['sample', 'series'].includes(folder.toLowerCase())) return false; 
            if (fs.existsSync(path.join(folderPath, '.processing'))) return false;

            return fs.readdirSync(folderPath).some(f => f.endsWith('.web.mp4'));
        });

        cleanMovies.forEach(folder => {
            const folderPath = path.join(MOVIES_DIR, folder);
            const metaFile = path.join(folderPath, 'metadata.json');
            let metaData = { title: folder.replace(/[-_.]/g, ' '), year: '', plot: '', genre: '', contentType: 'movie' };
            
            if (fs.existsSync(metaFile)) {
                try { metaData = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch (e) {}
            }

            temporaryCache.push({
                id: encodeURIComponent(folder),
                title: metaData.title,
                year: metaData.year,
                plot: metaData.plot,
                genre: metaData.genre,
                contentType: 'movie',
                cover: `/movie-assets/${encodeURIComponent(folder)}/cover.jpg`
            });
        });

        // =========================================================================
        // Sub-Pass B: TV Series Branch Scanner
        // =========================================================================
        const seriesRootDir = path.join(MOVIES_DIR, 'series');
        if (fs.existsSync(seriesRootDir)) {
            fs.readdirSync(seriesRootDir).forEach(showFolder => {
                const showPath = path.join(seriesRootDir, showFolder);
                if (showFolder.startsWith('.') || !fs.lstatSync(showPath).isDirectory()) return;

                const metaFile = path.join(showPath, 'metadata.json');
                let metaData = { title: showFolder.replace(/[-_.]/g, ' '), year: '', plot: '', genre: '', contentType: 'series' };

                if (fs.existsSync(metaFile)) {
                    try { metaData = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch (e) {}
                }

                temporaryCache.push({
                    // Kept un-encoded for series/ prefix parsing inside your media routes
                    id: `series/${encodeURIComponent(showFolder)}`,
                    title: metaData.title,
                    year: metaData.year,
                    plot: metaData.plot,
                    genre: metaData.genre,
                    contentType: 'series',
                    cover: `/movie-assets/series/${encodeURIComponent(showFolder)}/cover.jpg`
                });
            });
        }

        global.INSTANT_LIBRARY_CACHE = temporaryCache;
        logger.log(`⚡ [Cache Worker] RAM cache re-indexed. ${global.INSTANT_LIBRARY_CACHE.length} active assets mapped.`, 'info');
    } catch (err) {
        logger.log(`❌ Failed building internal memory cache maps: ${err.message}`, 'error');
    }
}

// Make the tracking routine globally accessible to background processing execution runs
global.rebuildLibraryCache = rebuildLibraryCache;

module.exports = { rebuildLibraryCache };