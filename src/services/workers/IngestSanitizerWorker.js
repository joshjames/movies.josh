// src/services/workers/IngestSanitizerWorker.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const fsp = require('fs').promises;
const logger = require('../logger');

const app = express();
app.use(express.json());

const MOVIES_DIR = process.env.MOVIES_DIR || '/app/movies';
const KEEP_EXTENSIONS = ['.mp4', '.mkv', '.m4v', '.avi', '.mov', '.srt', '.vtt', '.json', '.jpg', '.jpeg', '.png', '.ts'];

// =========================================================================
// 🧹 LEGACY REGEX PATTERN AND EXTENSION FILTERS (RETAINED)
// =========================================================================
function cleanReleaseName(folderName) {
    let title = folderName.replace(/\/+$/, '').replace(/\[.*?\]/g, '').replace(/\((.*?)\)/g, '$1');
    title = title.replace(/^www\.[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');
    title = title.replace(/^[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');

    const junkPatterns = [
        /[._-]v\d+/i, /[._-]v[eE]r\d+/i, /720p|1080p|2160p|4k/i,
        /HDTS|CAM|TS|TC|HDRip|WEBRip|BluRay|BRRip/i,
        /x264|x265|h264|hevc|AVC|AAC|MP3|DDP5\.1/i, /-[a-zA-Z0-9]+$/
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

// =========================================================================
// 📥 ATOMIC PROCESS API ENDPOINT
// =========================================================================
// =========================================================================
// 📥 INTELLECTUAL INGEST/CRAWL PROCESS ENDPOINT
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName, contentType } = req.body;

    // SCENARIO A: Global loop trigger from Orchestrator (No parameters) -> Run directory sweep discovery
    if (!folderPath || !folderName) {
        try {
            logger.log("🔍 Running global recursive Ingest sweep to discover untracked media assets...");
            await autoDiscoverAndOrganize(MOVIES_DIR);
            return res.json({ success: true, message: "Global collection discovery sweep complete." });
        } catch (crawlErr) {
            return res.status(500).json({ success: false, error: crawlErr.message });
        }
    }

    // SCENARIO B: Legacy pipeline tracking targeting a specific directory asset
    try {
        cleanJunkFiles(folderPath);
        const { title: cleanTitle, year: parsedYear } = cleanReleaseName(folderName);
        const dotNotationTitle = cleanTitle.replace(/\s+/g, '.');
        
        let targetFolderName = dotNotationTitle;
        if (contentType !== 'series' && parsedYear) {
            targetFolderName = `${dotNotationTitle}.${parsedYear}`;
        }

        let finalPath = folderPath;

        if (folderName !== targetFolderName) {
            const parentDir = path.dirname(folderPath);
            const computedPath = path.join(parentDir, targetFolderName);

            if (!fs.existsSync(computedPath)) {
                await fsp.rename(folderPath, computedPath);
                finalPath = computedPath;
                logger.log(`🗂️ Ingest Alignment Mutator: [${folderName}] ➡️ [${targetFolderName}]`, 'info');
            }
        }

        return res.json({
            success: true,
            patchData: {
                folderPath: finalPath,
                folderName: targetFolderName,
                pipelineState: { currentStep: 'METADATA', lastUpdated: new Date().toISOString() }
            }
        });
    } catch (err) {
        return res.json({ success: false, error: err.message });
    }
});

// Recursive crawler to find ugly torrent prints and fit them inside structural trees
async function autoDiscoverAndOrganize(currentDir) {
    const items = await fsp.readdir(currentDir, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(currentDir, item.name);

        if (item.isDirectory()) {
            await autoDiscoverAndOrganize(fullPath); // Keep digging down
        } else {
            const ext = path.extname(item.name).toLowerCase();
            // Match ugly names or spaces
            const isUglyName = item.name.includes(' ') || item.name.toLowerCase().includes('www.');
            
            if (KEEP_EXTENSIONS.includes(ext) && isUglyName && !item.name.startsWith('.')) {
                // Parse file patterns like S09E05
                const tvMatch = item.name.match(/S(\d{2})E(\d{2})/i);
                
                if (tvMatch) {
                    const seasonStr = `Season.${parseInt(tvMatch[1], 10)}`;
                    const cleanEpTitle = item.name.replace(/^[^\s]*\s*-\s*/, '').replace(/\s+/g, '.'); // Clear out web tags
                    
                    // Trace up to ensure it matches your target structure
                    // Expected structure: /app/movies/series/ShowName/Season.X/Episode.ext
                    const pathParts = fullPath.split(path.sep);
                    const seriesIndex = pathParts.indexOf('series');
                    
                    if (seriesIndex !== -1 && pathParts[seriesIndex + 1]) {
                        const showFolderName = pathParts[seriesIndex + 1];
                        const standardizedDir = path.join(MOVIES_DIR, 'series', showFolderName, seasonStr);
                        const cleanFinalPath = path.join(standardizedDir, cleanEpTitle);

                        logger.log(`🎯 [AUTOMATION DISCOVERY] Found out-of-spec asset. Realigning: ${item.name}`);
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