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
app.post('/process', async (req, res) => {
    const { folderPath, folderName, contentType } = req.body;

    if (!folderPath || !folderName) {
        return res.status(400).json({ success: false, error: "Missing folderPath or folderName parameters." });
    }

    try {
        // 1. Run deep junk filesystem purges instantly on the current target path
        cleanJunkFiles(folderPath);

        // 2. Compute canonical naming standard using original regex structures
        const { title: cleanTitle, year: parsedYear } = cleanReleaseName(folderName);
        const dotNotationTitle = cleanTitle.replace(/\s+/g, '.');
        
        let targetFolderName = dotNotationTitle;
        if (contentType !== 'series' && parsedYear) {
            targetFolderName = `${dotNotationTitle}.${parsedYear}`;
        }

        let finalPath = folderPath;

        // 3. Handle atomic directory structural rename if names don't match standard
        if (folderName !== targetFolderName) {
            const parentDir = path.dirname(folderPath);
            const computedPath = path.join(parentDir, targetFolderName);

            if (!fs.existsSync(computedPath)) {
                // Drop processing file lock directly to isolate filesystem state mutations
                const lockFile = path.join(folderPath, '.processing');
                await fsp.writeFile(lockFile, JSON.stringify({ status: "renaming" }));

                await fsp.unlink(lockFile).catch(() => {});
                await fsp.rename(folderPath, computedPath);
                
                finalPath = computedPath;
                logger.log(`🗂️ Ingest Alignment Mutator: [${folderName}] ➡️ [${targetFolderName}]`, 'info');
            }
        }

        // Return clean patchData parameters to update Orchestrator database logs
        return res.json({
            success: true,
            message: "File structures sanitized and aligned cleanly.",
            patchData: {
                folderPath: finalPath,
                folderName: targetFolderName,
                pipelineState: {
                    currentStep: 'METADATA',
                    lastUpdated: new Date().toISOString()
                }
            }
        });

    } catch (err) {
        logger.log(`❌ Ingest Sanitizer operational error on ${folderName}: ${err.message}`, 'error');
        return res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.INGEST_WORKER_PORT || 5000;
app.listen(PORT, () => console.log(`🧹 Atomic Ingest Sanitizer Worker online on port ${PORT}`));