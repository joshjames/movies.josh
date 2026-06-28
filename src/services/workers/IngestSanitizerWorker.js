// src/services/workers/IngestSanitizerWorker.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const fsp = require('fs').promises;
const axios = require('axios');
const logger = require('../logger');
//const MetadataRegistry = require('../MetadataRegistry'); // Core disk + Redis index sync engine

const app = express();
app.use(express.json());

// 🚨 CONTAINER MOUNT DIRECTORY MAPS
const MOVIES_DIR = '/app/storage/movies';
const SERIES_DIR = '/app/storage/series';
const KEEP_EXTENSIONS = ['.mp4', '.mkv', '.m4v', '.avi', '.mov', '.srt', '.vtt', '.json', '.jpg', '.jpeg', '.png', '.ts'];
const OMDB_API_KEY = process.env.OMDB_API_KEY || '84196d01';

// =========================================================================
// 🧹 UTILITY REGEX PATTERNS AND FILTERS (100% PRESERVED & LOCKED DOWN)
// =========================================================================
function cleanReleaseName(folderName) {
    let title = folderName.replace(/\[.*?\]/g, '').replace(/\((.*?)\)/g, '$1').replace(/\/+$/, '');
    
    title = title.replace(/^www\.[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');
    title = title.replace(/^[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');

    const junkPatterns = [
        /[._-]v\d+/i, /[._-]v[eE]r\d+/i, /720p|1080p|2160p|4k/i,
        /HDTS|CAM|TS|TC|HDRip|WEBRip|BluRay|BRRip/i,
        /x264|x265|h264|hevc|AVC|AAC|MP3|DDP5\.1/i,
        /\b(yts|yts\.mx|yts\.am|yts\.gg|yts\.bz)\b/i, 
        /-[a-zA-Z0-9]+$/
    ];
    
    junkPatterns.forEach(pattern => title = title.replace(pattern, ''));

    const yearMatch = title.match(/(.*?)[._-\s](\d{4})/);
    let year = '';
    if (yearMatch) { title = yearMatch[1]; year = yearMatch[2]; }
    
    title = title.replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
    return { title, year };
}

function cleanJunkFiles(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const contents = fs.readdirSync(dirPath);
    contents.forEach(item => {
        const itemPath = path.join(dirPath, item);
        const itemStat = fs.lstatSync(itemPath);
        if (itemStat.isDirectory()) {
            if (item.toLowerCase() === 'sample') deleteFolderRecursive(itemPath);
            else cleanJunkFiles(itemPath); 
        } else {
            const ext = path.extname(item).toLowerCase();
            if (item.toLowerCase().includes('sample') && ext !== '.srt') fs.unlinkSync(itemPath);
            else if (!KEEP_EXTENSIONS.includes(ext)) fs.unlinkSync(itemPath);
        }
    });
}

function deleteFolderRecursive(directoryPath) {
    if (fs.existsSync(directoryPath)) {
        fs.readdirSync(directoryPath).forEach((file) => {
            const curPath = path.join(directoryPath, file);
            if (fs.lstatSync(curPath).isDirectory()) deleteFolderRecursive(curPath);
            else fs.unlinkSync(curPath);
        });
        fs.rmdirSync(directoryPath);
    }
}

function generateSkeletonSeason(seasonNum, structure, physicalFileMap) {
    Object.keys(physicalFileMap).forEach(key => {
        const [s, e] = key.split('-').map(Number);
        if (s === seasonNum) {
            structure.seasons[seasonNum].episodes.push({
                episodeNumber: e,
                title: `Episode ${e}`,
                released: 'Unknown',
                plot: 'No internet overview map file processed.',
                imdbRating: 'N/A',
                available: true,
                localRelativePath: physicalFileMap[key]
            });
        }
    });
    structure.seasons[seasonNum].episodes.sort((a,b) => a.episodeNumber - b.episodeNumber);
}

// =========================================================================
// 📥 UNIFIED INGEST PROCESSING ENDPOINT
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName, contentType } = req.body;

    // SCENARIO A: Global loop trigger from Orchestrator -> Directory sweep discovery
    if (!folderPath || !folderName) {
        try {
            logger.log("🔍 Running global recursive Ingest sweep to discover untracked media assets...");
            await autoDiscoverAndOrganize(MOVIES_DIR);
            return res.json({ success: true, message: "Global collection discovery sweep complete." });
        } catch (crawlErr) {
            return res.status(500).json({ success: false, error: crawlErr.message });
        }
    }

    // SCENARIO B: Targeted pipeline processing for an active download
    try {
        // 1. Run immediate layout scrub to purge torrent spam and trash files
        cleanJunkFiles(folderPath);

        // 2. Resolve clean directory name strings
        const { title: cleanTitle, year: parsedYear } = cleanReleaseName(folderName);
        const dotNotationTitle = cleanTitle.replace(/\s+/g, '.');
        
        let targetFolderName = dotNotationTitle;
        if (contentType !== 'series' && parsedYear) {
            targetFolderName = `${dotNotationTitle}.${parsedYear}`;
        }

        let finalPath = folderPath;

        // 3. Mutate directory if structural adjustments are needed
        if (folderName !== targetFolderName) {
            const parentDir = path.dirname(folderPath);
            const computedPath = path.join(parentDir, targetFolderName);

            if (!fs.existsSync(computedPath)) {
                await fsp.rename(folderPath, computedPath);
                finalPath = computedPath;
                logger.log(`🗂️ Ingest Alignment Mutator: [${folderName}] ➡️ [${targetFolderName}]`, 'info');
            }
        }

        // =====================================================================
        // 📺 BRANCH OVER: TV SERIES DETAILED EXTENSION INGESTION
        // =====================================================================
        if (contentType === 'series') {
            logger.log(`📺 Mapping deep TV configuration manifests for series structural tree: [${targetFolderName}]`);
            
            let mainMeta = { title: cleanTitle, year: parsedYear || '', plot: '', genre: '', contentType: 'series' };
            let totalSeasons = 1;

            // Step B.1: Hit OMDb API for high-level envelope structure definitions
            try {
                const showRes = await axios.get(`http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(cleanTitle)}&type=series`, { timeout: 5000 });
                if (showRes.data && showRes.data.Response === "True") {
                    mainMeta.title = showRes.data.Title;
                    mainMeta.year = showRes.data.Year;
                    mainMeta.plot = showRes.data.Plot;
                    mainMeta.genre = showRes.data.Genre;
                    totalSeasons = parseInt(showRes.data.totalSeasons, 10) || 1;
                }
            } catch (err) {
                logger.log(`⚠️ OMDb API series query exception for ${cleanTitle}: ${err.message}`, 'warn');
            }

            // Step B.2: Index physical files to establish mapping tracking keys
            let physicalFileMap = {};
            const diskItems = fs.readdirSync(finalPath);

            diskItems.forEach(item => {
                const itemPath = path.join(finalPath, item);
                if (!fs.lstatSync(itemPath).isDirectory()) return;

                const files = fs.readdirSync(itemPath);
                files.forEach(file => {
                    if (!KEEP_EXTENSIONS.includes(path.extname(file).toLowerCase())) return;
                    
                    const match = file.match(/s\s*(\d+)\s*e\s*(\d+)/i);
                    if (match) {
                        const sNum = parseInt(match[1], 10);
                        const eNum = parseInt(match[2], 10);
                        physicalFileMap[`${sNum}-${eNum}`] = `series/${targetFolderName}/${item}/${file}`;
                    }
                });
            });

            // Step B.3: Build individual season episode matrices
            let fullSeriesStructure = { totalSeasons: totalSeasons.toString(), seasons: {} };

            for (let s = 1; s <= totalSeasons; s++) {
                fullSeriesStructure.seasons[s] = { seasonNumber: s.toString(), episodes: [] };
                try {
                    const seasonRes = await axios.get(`http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(cleanTitle)}&Season=${s}`, { timeout: 4000 });
                    if (seasonRes.data && seasonRes.data.Response === "True" && seasonRes.data.Episodes) {
                        for (const ep of seasonRes.data.Episodes) {
                            const epNum = parseInt(ep.Episode, 10);
                            const lookupKey = `${s}-${epNum}`;
                            const isAvailable = !!physicalFileMap[lookupKey];

                            fullSeriesStructure.seasons[s].episodes.push({
                                episodeNumber: epNum,
                                title: ep.Title || `Episode ${epNum}`,
                                released: ep.Released || 'Unknown',
                                plot: 'Fetch individual plot details via extended loop if desired or leave crisp summary snapshots.',
                                imdbRating: ep.imdbRating || 'N/A',
                                available: isAvailable,
                                localRelativePath: isAvailable ? physicalFileMap[lookupKey] : null
                            });
                        }
                    } else {
                        generateSkeletonSeason(s, fullSeriesStructure, physicalFileMap);
                    }
                } catch (err) {
                    generateSkeletonSeason(s, fullSeriesStructure, physicalFileMap);
                }
            }

            // Step B.4: Commit structured artifacts to disk
                fs.writeFileSync(path.join(finalPath, 'series.json'), JSON.stringify(fullSeriesStructure, null, 2));

                // Set final pipeline states and write directly to disk locally instead of hitting the raw Redis Registry
                const metaFilePath = path.join(finalPath, 'metadata.json');
                mainMeta.pipelineState = { currentStep: 'COMPLETED', lastUpdated: new Date().toISOString() };

                // Write the file locally to the disk right here
                fs.writeFileSync(metaFilePath, JSON.stringify(mainMeta, null, 4));

                logger.log(`⚙️ [Ingest Sanitizer] Saved metadata.json for ${targetFolderName} and marked pipeline COMPLETED.`);

                return res.json({
                    success: true,
                    patchData: {
                        folderPath: finalPath,
                        folderName: targetFolderName,
                        pipelineState: { currentStep: 'COMPLETED', lastUpdated: new Date().toISOString() }
                    }
                });
        }

        // =====================================================================
        // 🎬 STANDARD MOVIE BRANCH TERMINATION (RETAINED VERBATIM)
        // =====================================================================
        return res.json({
            success: true,
            patchData: {
                folderPath: finalPath,
                folderName: targetFolderName,
                pipelineState: { currentStep: 'METADATA', lastUpdated: new Date().toISOString() }
            }
        });

    } catch (err) {
        logger.log(`❌ Error encountered during data normalization loops: ${err.message}`, 'error');
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Recursive crawler (Maintained for standalone collection sweeps)
async function autoDiscoverAndOrganize(currentDir) {
    const items = await fsp.readdir(currentDir, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(currentDir, item.name);

        if (item.isDirectory()) {
            await autoDiscoverAndOrganize(fullPath); 
        } else {
            const ext = path.extname(item.name).toLowerCase();
            const isUglyName = item.name.includes(' ') || item.name.toLowerCase().includes('www.');
            
            if (KEEP_EXTENSIONS.includes(ext) && isUglyName && !item.name.startsWith('.')) {
                const tvMatch = item.name.match(/S(\d{2})E(\d{2})/i);
                
                if (tvMatch) {
                    const seasonStr = `Season.${parseInt(tvMatch[1], 10)}`;
                    const cleanEpTitle = item.name.replace(/^[^\s]*\s*-\s*/, '').replace(/\s+/g, '.'); 
                    
                    const pathParts = fullPath.split(path.sep);
                    const seriesIndex = pathParts.indexOf('series');
                    
                    if (seriesIndex !== -1 && pathParts[seriesIndex + 1]) {
                        const showFolderName = pathParts[seriesIndex + 1];
                        const standardizedDir = path.join(SERIES_DIR, showFolderName, seasonStr);
                        const cleanFinalPath = path.join(standardizedDir, cleanEpTitle);

                        logger.log(`🎯 [AUTOMATION DISCOVERY] Realigning TV asset node: ${item.name}`);
                        await fsp.mkdir(standardizedDir, { recursive: true });
                        await fsp.rename(fullPath, cleanFinalPath);
                    }
                }
            }
        }
    }
}

const PORT = process.env.INGEST_WORKER_PORT || 5000;
app.listen(PORT, () => console.log(`🧹 Atomic Ingest Sanitizer Worker online on port ${PORT}`));