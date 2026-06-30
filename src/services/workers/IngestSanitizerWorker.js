// src/services/workers/IngestSanitizerWorker.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const fsp = require('fs').promises;
const axios = require('axios');
const logger = require('../logger');

const app = express();
app.use(express.json());

// 🚨 CONTAINER MOUNT DIRECTORY MAPS
const MOVIES_DIR = '/app/storage/movies';
const SERIES_DIR = '/app/storage/series';
const KEEP_EXTENSIONS = ['.mp4', '.mkv', '.m4v', '.avi', '.mov', '.srt', '.vtt', '.mpeg', '.nfo', '.ogg', '.ogv', '.json', '.jpg', '.jpeg', '.png', '.ts'];
const OMDB_API_KEY = process.env.OMDB_API_KEY || '84196d01';

// =========================================================================
// 🧹 UTILITY REGEX PATTERNS AND FILTERS
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
    let removedCount = 0;
    contents.forEach(item => {
        const itemPath = path.join(dirPath, item);
        const itemStat = fs.lstatSync(itemPath);
        if (itemStat.isDirectory()) {
            if (item.toLowerCase() === 'sample') {
                deleteFolderRecursive(itemPath);
                removedCount += 1;
            } else {
                removedCount += cleanJunkFiles(itemPath) || 0;
            }
        } else {
            const ext = path.extname(item).toLowerCase();
            if (item.toLowerCase().includes('sample') && ext !== '.srt') {
                fs.unlinkSync(itemPath);
                removedCount += 1;
            } else if (!KEEP_EXTENSIONS.includes(ext)) {
                fs.unlinkSync(itemPath);
                removedCount += 1;
            }
        }
    });
    return removedCount;
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

function analyzeDirectoryContents(dirPath) {
    if (!fs.existsSync(dirPath)) return { isSeasonPack: false, detectedEpisodes: [] };
    
    // If it's a file instead of a directory, handle gracefully
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return { isSeasonPack: false, detectedEpisodes: [] };

    const files = fs.readdirSync(dirPath);
    let tvMatches = [];
    let mediaCount = 0;

    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (!KEEP_EXTENSIONS.includes(ext)) continue;
        if (file.toLowerCase().includes('sample')) continue;

        mediaCount++;
        const match = file.match(/s\s*(\d+)\s*e\s*(\d+)/i);
        if (match) {
            tvMatches.push({
                fileName: file,
                season: parseInt(match[1], 10),
                episode: parseInt(match[2], 10)
            });
        }
    }

    return {
        isSeasonPack: tvMatches.length > 0 && tvMatches.length === mediaCount,
        detectedEpisodes: tvMatches
    };
}

function findExistingShowFolder(cleanTitle, targetSeriesDir) {
    if (!fs.existsSync(targetSeriesDir)) return null;
    
    const normalizedTarget = cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    const currentFolders = fs.readdirSync(targetSeriesDir);

    for (const folder of currentFolders) {
        const normalizedFolder = folder.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedFolder === normalizedTarget || normalizedFolder.includes(normalizedTarget)) {
            return folder;
        }
    }
    return null;
}

function flattenSingleChildMovieFolder(folderPath) {
    if (!fs.existsSync(folderPath)) return { flattened: false, moved: 0 };

    const entries = fs.readdirSync(folderPath);
    const directories = entries.filter(entry => fs.lstatSync(path.join(folderPath, entry)).isDirectory());
    const files = entries.filter(entry => fs.lstatSync(path.join(folderPath, entry)).isFile());

    // Only flatten when the release is wrapped in one child folder and the root has no usable media.
    const hasRootMedia = files.some(file => KEEP_EXTENSIONS.includes(path.extname(file).toLowerCase()));
    if (hasRootMedia || directories.length !== 1) {
        return { flattened: false, moved: 0 };
    }

    const childFolderName = directories[0];
    const childFolderPath = path.join(folderPath, childFolderName);
    const childEntries = fs.readdirSync(childFolderPath);
    let movedCount = 0;

    for (const entry of childEntries) {
        const sourcePath = path.join(childFolderPath, entry);
        const destinationPath = path.join(folderPath, entry);

        if (fs.existsSync(destinationPath)) continue;

        fs.renameSync(sourcePath, destinationPath);
        movedCount += 1;
    }

    if (fs.existsSync(childFolderPath)) {
        deleteFolderRecursive(childFolderPath);
    }

    return { flattened: movedCount > 0, moved: movedCount };
}

function mergeMovieFolderContents(sourcePath, targetPath) {
    if (!fs.existsSync(sourcePath) || !fs.existsSync(targetPath)) {
        return { moved: 0, removed: 0 };
    }

    const sourceEntries = fs.readdirSync(sourcePath);
    let moved = 0;
    let removed = 0;

    for (const entry of sourceEntries) {
        const sourceEntryPath = path.join(sourcePath, entry);
        const targetEntryPath = path.join(targetPath, entry);
        const stat = fs.lstatSync(sourceEntryPath);

        if (stat.isDirectory()) {
            if (!fs.existsSync(targetEntryPath)) {
                fs.renameSync(sourceEntryPath, targetEntryPath);
                moved += 1;
            }
            continue;
        }

        const ext = path.extname(entry).toLowerCase();
        if (!KEEP_EXTENSIONS.includes(ext)) continue;

        if (!fs.existsSync(targetEntryPath)) {
            fs.renameSync(sourceEntryPath, targetEntryPath);
            moved += 1;
        }
    }

    const remaining = fs.existsSync(sourcePath) ? fs.readdirSync(sourcePath) : [];
    if (remaining.length === 0) {
        try {
            fs.rmdirSync(sourcePath);
            removed += 1;
        } catch (_err) {
            // Ignore if folder is not empty or cannot be removed right now.
        }
    }

    return { moved, removed };
}

function safeDirectoryCandidate(candidatePath) {
    if (!candidatePath) return null;
    try {
        if (!fs.existsSync(candidatePath)) return null;
        const stat = fs.lstatSync(candidatePath);
        if (stat.isDirectory()) return candidatePath;
        if (stat.isFile()) return path.dirname(candidatePath);
    } catch (_err) {
        return null;
    }
    return null;
}

function normalizeNameKey(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function resolveInputFolderContext(folderPath, folderName, contentType) {
    const rawPath = String(folderPath || '').trim();
    const rawName = String(folderName || '').trim();
    const baseName = rawName ? path.basename(rawName) : '';

    if (baseName) {
        const primaryRoot = contentType === 'series' ? SERIES_DIR : MOVIES_DIR;
        const topLevelPath = safeDirectoryCandidate(path.join(primaryRoot, baseName));
        if (topLevelPath) {
            return { path: topLevelPath, name: path.basename(topLevelPath), source: `library-top-level:${primaryRoot}` };
        }
    }

    const directCandidates = [];
    if (rawPath) {
        directCandidates.push(rawPath);
        if (baseName) {
            directCandidates.push(path.join(rawPath, baseName));
            directCandidates.push(path.join(path.dirname(rawPath), baseName));
        }
    }

    for (const candidate of directCandidates) {
        const resolved = safeDirectoryCandidate(candidate);
        if (resolved) {
            return { path: resolved, name: path.basename(resolved), source: `direct:${candidate}` };
        }
    }

    if (!baseName) {
        return { path: null, name: null, source: 'unresolved:no-folder-name' };
    }

    const configuredDownloadRoot = process.env.QBIT_DOWNLOAD_DIR || process.env.DOWNLOADS_DIR || process.env.MOVIES_DIR || null;
    const searchRoots = [
        configuredDownloadRoot,
        contentType === 'series' ? SERIES_DIR : MOVIES_DIR,
        '/app/downloads',
        '/downloads',
        '/app/storage/movies',
        '/home/epic/movies'
    ].filter(Boolean);

    // Try exact folder-name match under known roots first.
    for (const root of searchRoots) {
        const exact = safeDirectoryCandidate(path.join(root, baseName));
        if (exact) {
            return { path: exact, name: path.basename(exact), source: `root-exact:${root}` };
        }
    }

    // Then try normalized fuzzy match one level deep within known roots.
    const targetKey = normalizeNameKey(baseName);
    for (const root of searchRoots) {
        if (!fs.existsSync(root)) continue;
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch (_err) {
            continue;
        }

        const match = entries.find(entry => {
            if (!entry.isDirectory()) return false;
            return normalizeNameKey(entry.name) === targetKey;
        });

        if (match) {
            const resolved = path.join(root, match.name);
            return { path: resolved, name: match.name, source: `root-fuzzy:${root}` };
        }
    }

    return { path: null, name: null, source: 'unresolved:not-found' };
}

// =========================================================================
// 📥 UNIFIED INGEST PROCESSING ENDPOINT
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName, contentType } = req.body;

    logger.debug(`🧹 [Ingest] Start | folderName=${folderName || 'unknown'} | folderPath=${folderPath || 'missing'} | contentType=${contentType || 'movie'}`);

    // SCENARIO A: Global manual sweep invocation
    if (!folderPath || !folderName) {
        try {
            logger.debug("🔍 Running global recursive Ingest sweep to discover untracked media assets...");
            await autoDiscoverAndOrganize(MOVIES_DIR);
            await autoDiscoverAndOrganize(SERIES_DIR); // 🎯 FIX: Scan series storage pools too
            return res.json({ success: true, message: "Global collection discovery sweep complete." });
        } catch (crawlErr) {
            return res.status(500).json({ success: false, error: crawlErr.message });
        }
    }

    // SCENARIO B: Target automated pipeline handler
    try {
        const resolved = resolveInputFolderContext(folderPath, folderName, contentType || 'movie');
        if (!resolved.path) {
            logger.warn(`⚠️ [Ingest] Could not resolve folder path | folderName=${folderName || 'unknown'} | folderPath=${folderPath || 'missing'} | source=${resolved.source}`);
            return res.status(400).json({ success: false, error: `Could not resolve ingest folder from provided context (${resolved.source}).` });
        }

        const workingFolderPath = resolved.path;
        const workingFolderName = resolved.name || folderName;

        logger.debug(`🧭 [Ingest] Resolved folder input | folderName=${workingFolderName} | folderPath=${workingFolderPath} | source=${resolved.source}`);

        const removedCount = cleanJunkFiles(workingFolderPath) || 0;
        logger.debug(`🧹 [Ingest] Junk cleanup complete | removed=${removedCount} | folderPath=${workingFolderPath}`);

        const flattenResult = flattenSingleChildMovieFolder(workingFolderPath);
        if (flattenResult.flattened) {
            logger.debug(`📦 [Ingest] Flattened nested movie release folder | moved=${flattenResult.moved} | folderPath=${workingFolderPath}`);
        }

        const { title: cleanTitle, year: parsedYear } = cleanReleaseName(workingFolderName);
        const dotNotationTitle = cleanTitle.replace(/\s+/g, '.');
        
        let targetFolderName = dotNotationTitle;
        if (contentType !== 'series' && parsedYear) {
            targetFolderName = `${dotNotationTitle}.${parsedYear}`;
        }

        let finalPath = workingFolderPath;

        if (workingFolderName !== targetFolderName) {
            const parentDir = path.dirname(workingFolderPath);
            const computedPath = path.join(parentDir, targetFolderName);

            if (!fs.existsSync(computedPath) && fs.existsSync(workingFolderPath)) {
                await fsp.rename(workingFolderPath, computedPath);
                finalPath = computedPath;
                logger.debug(`🗂️ Ingest Alignment Mutator: [${workingFolderName}] ➡️ [${targetFolderName}]`);
            } else {
                finalPath = fs.existsSync(computedPath) ? computedPath : workingFolderPath;

                if (fs.existsSync(computedPath) && fs.existsSync(workingFolderPath) && workingFolderPath !== computedPath) {
                    const mergeResult = mergeMovieFolderContents(workingFolderPath, computedPath);
                    logger.debug(`🗂️ [Ingest] Merge into existing normalized target | moved=${mergeResult.moved} | removed=${mergeResult.removed} | targetFolderName=${targetFolderName}`);
                } else {
                    logger.debug(`🗂️ [Ingest] Rename skipped | computedPathExists=${fs.existsSync(computedPath)} | sourceExists=${fs.existsSync(workingFolderPath)} | targetFolderName=${targetFolderName}`);
                }
            }
        } else {
            logger.debug(`🗂️ [Ingest] Folder already normalized: [${workingFolderName}]`);
        }

        // =====================================================================
        // 📺 TV SERIES BRANCH
        // =====================================================================
        if (contentType === 'series') {
            const analysis = analyzeDirectoryContents(finalPath);

            if (analysis.isSeasonPack) {
                logger.debug(`🧠 [Smart Ingest] Detected multi-file TV Season Pack inside: [${targetFolderName}]`);

                let showFolder = findExistingShowFolder(cleanTitle, SERIES_DIR);
                if (!showFolder) {
                    showFolder = dotNotationTitle;
                    fs.mkdirSync(path.join(SERIES_DIR, showFolder), { recursive: true });
                    logger.debug(`📁 [Smart Ingest] Established brand new show root entry: ${showFolder}`);
                } else {
                    logger.debug(`🎯 [Smart Ingest] Linked incoming assets to existing archive: ${showFolder}`);
                }

                for (const ep of analysis.detectedEpisodes) {
                    const seasonFolder = `Season.${String(ep.season).padStart(2, '0')}`;
                    const targetDir = path.join(SERIES_DIR, showFolder, seasonFolder);
                    
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }

                    const cleanFileTitle = `${showFolder}.S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}${path.extname(ep.fileName)}`;
                    const sourcePath = path.join(finalPath, ep.fileName);
                    const destinationPath = path.join(targetDir, cleanFileTitle);

                    if (!fs.existsSync(destinationPath)) {
                        fs.renameSync(sourcePath, destinationPath);
                    }
                }

                logger.debug(`✨ [Smart Ingest] Tree expansion complete for ${cleanTitle}. Purging remaining download residue...`);
                deleteFolderRecursive(finalPath);

                return res.json({
                    success: true,
                    message: "Season pack dispersed and merged into library successfully.",
                    patchData: { pipelineState: { currentStep: 'COMPLETED', lastUpdated: new Date().toISOString() } }
                });
            }

            logger.debug(`📺 Mapping deep TV configuration manifests for series structural tree: [${targetFolderName}]`);
            let mainMeta = { title: cleanTitle, year: parsedYear || '', plot: '', genre: '', contentType: 'series' };
            let totalSeasons = 1;

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
                logger.error(`⚠️ OMDb API series query exception for ${cleanTitle}: ${err.message}`, 'warn');
            }

            let physicalFileMap = {};
            if (fs.existsSync(finalPath)) {
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
            }

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
                                plot: 'Crisp summary snapshot placeholder.',
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

            if (fs.existsSync(finalPath)) {
                fs.writeFileSync(path.join(finalPath, 'series.json'), JSON.stringify(fullSeriesStructure, null, 2));
                const metaFilePath = path.join(finalPath, 'metadata.json');
                mainMeta.pipelineState = { currentStep: 'COMPLETED', lastUpdated: new Date().toISOString() };
                fs.writeFileSync(metaFilePath, JSON.stringify(mainMeta, null, 4));
                logger.debug(`⚙️ [Ingest Sanitizer] Saved metadata.json for ${targetFolderName} and marked pipeline COMPLETED.`);
            }

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
        // 🎬 STANDARD MOVIE BRANCH TERMINATION
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
        logger.error(`❌ Error encountered during data normalization loops: ${err.message}`, 'error');
        return res.status(500).json({ success: false, error: err.message });
    }
});

async function autoDiscoverAndOrganize(currentDir) {
    if (!fs.existsSync(currentDir)) return;
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

                        logger.debug(`🎯 [AUTOMATION DISCOVERY] Realigning TV asset node: ${item.name}`);
                        await fsp.mkdir(standardizedDir, { recursive: true });
                        await fsp.rename(fullPath, cleanFinalPath);
                    }
                }
            }
        }
    }
    logger.debug(`🔄 [AUTOMATION DISCOVERY] Initiating auto-discovery and organization of: ${currentDir}`);
}


const PORT = process.env.INGEST_WORKER_PORT || 5000;
app.listen(PORT, () => console.log(`🧹 Atomic Ingest Sanitizer Worker online on port ${PORT}`));