// src/services/LibraryScanner.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { syncLibraryToStorage } = require('./db');

const MOVIES_DIR = process.env.MOVIES_DIR || '/app/storage/movies';
const SERIES_DIR = process.env.SERIES_DIR || '/app/storage/series';

function scanDirectory(basePath, contentType) {
    const registry = [];
    if (!fs.existsSync(basePath)) {
        logger.log(`⚠️ Specified drive pathway missing index markers: ${basePath}`, 'warn');
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
                logger.log(`Mangled metadata configuration block at: ${folder}`, 'warn');
            }
        }

        // 🚨 THE CRITICAL CLOUD TRACKING PROTECTION FIX
        // If the metadata tells us the file is remote, we mark it safe immediately
        const isRemote = meta.storage?.location === 'remote';
        
        // Scan for local video assets if it's not hosted in the cloud cloud environment
        let mediaFiles = [];
        if (fs.existsSync(itemPath)) {
            mediaFiles = fs.readdirSync(itemPath).filter(f => f.endsWith('.mp4') || f.endsWith('.mkv'));
        }

        if (mediaFiles.length > 0 || isRemote || contentType === 'series') {
    registry.push({
        // 🚨 FLATTENED ROOT PROPERTIES FOR THE FRONTEND
        id: contentType === 'series' ? `series/${encodeURIComponent(folder)}` : encodeURIComponent(folder),
        title: meta.title || folder.replace(/[-_.]/g, ' '),
        year: meta.year || '',
        plot: meta.plot || '',
        genre: meta.genre || '',
        contentType: contentType,
        storageLocation: isRemote ? 'remote' : 'local',
        cover: contentType === 'series' 
            ? `/movie-assets/series/${encodeURIComponent(folder)}/cover.jpg`
            : `/movie-assets/${encodeURIComponent(folder)}/cover.jpg`,
        
        // Keep the raw block intact just in case other services need it
        storage: meta.storage || { location: 'local', files: {} },
        updatedAt: new Date().toISOString()
        });
        } else {
            logger.log(`🗑️ Stripping empty untracked local trace directory from listings: ${folder}`, 'info');
        }
    }
    return registry;
}

async function runLibraryScanSweep() {
    logger.log('🔍 Executing system-wide library asset inventory sweep...');
    
    // Process distinct storage lines independently
    const movies = scanDirectory(MOVIES_DIR, 'movie');
    const shows = scanDirectory(SERIES_DIR, 'series');

    const masterPayload = { movies, shows, lastScan: new Date().toISOString() };
    
    // Sync to Redis hot memory + Fallback storage file instantly
    await syncLibraryToStorage(masterPayload);
    logger.log(`✨ Inventory sweep complete. Cached [${movies.length}] Movies and [${shows.length}] Series.`);
}

module.exports = { runLibraryScanSweep };