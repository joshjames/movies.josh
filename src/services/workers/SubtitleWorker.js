// src/services/workers/SubtitleWorker.js
// Multi-Provider Subtitle Extraction Engine featuring YIFY HTML Parsing & Subliminal Fallbacks.

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const AdmZip = require('adm-zip');
const logger = require('../logger');

const app = express();
app.use(express.json());

// Standard desktop configuration spoofing parameters to cleanly navigate Cloudflare filters
const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
};

/**
 * Strategy 1: Programmatic YIFY HTML Scratch-Pad Parser
 */
async function fetchYifySubtitles(imdbId, folderPath) {
    const targetImdb = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
    const tempZipPath = path.join(folderPath, `temp_subs_${targetImdb}.zip`);
    
    try {
        const movieUrl = `https://yifysubtitles.ch/movie-imdb/${targetImdb}`;
        
        logger.debug(`📡 Querying YIFY database for IMDB: ${targetImdb}`);
        const response = await axios.get(movieUrl, { headers: REQUEST_HEADERS, timeout: 15000 });
        const html = response.data;

        // Extract lines containing English subtitle detail paths
        const subtitlePageMatches = html.match(/\/subtitles\/[a-zA-Z0-9-]+-english-yify-\d+/g);
        if (!subtitlePageMatches || subtitlePageMatches.length === 0) {
            throw new Error("No explicit English subtitle track links found in HTML manifest.");
        }

        // Isolate the highest quality or first matched variant path reference
        const chosenSubPagePath = subtitlePageMatches[0];
        const detailPageUrl = `https://yifysubtitles.ch${chosenSubPagePath}`;
        
        logger.debug(`🔍 Navigating to sub-page tracking link: ${detailPageUrl}`);
        const detailResponse = await axios.get(detailPageUrl, { headers: REQUEST_HEADERS, timeout: 15000 });
        const detailHtml = detailResponse.data;

        // Isolate the exact .zip file stream locator endpoint
        const zipDownloadMatch = detailHtml.match(/\/subtitle\/[a-zA-Z0-9-]+-english-yify-\d+\.zip/);
        if (!zipDownloadMatch) {
            throw new Error("Failed extracting binary zip stream path from details segment.");
        }

        const downloadUrl = `https://yifysubtitles.ch${zipDownloadMatch[0]}`;

        logger.debug(`📥 Streaming subtitle binary file: ${downloadUrl}`);
        
        // Anti-403 Configuration: Spoof headers and include Referer target
        const binaryStream = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'arraybuffer',
            headers: {
                ...REQUEST_HEADERS,
                'Referer': detailPageUrl // Crucial header to prove context to Cloudflare
            },
            timeout: 20000
        });

        // Write buffer out to block space cleanly
        fs.writeFileSync(tempZipPath, Buffer.from(binaryStream.data));

        // 🛠️ FIX: Use adm-zip with the correct native method map (.getEntries())
        const zip = new AdmZip(tempZipPath);
        const zipEntries = zip.getEntries();
        
        let srtExtracted = false;
        const standardizedName = 'English.srt';

        zipEntries.forEach((entry) => {
            if (entry.entryName.toLowerCase().endsWith('.srt') && !srtExtracted) {
                // Extract to the target folder natively
                zip.extractEntryTo(entry, folderPath, false, true);
                
                const rawExtractedPath = path.join(folderPath, entry.entryName);
                const finalSrtPath = path.join(folderPath, standardizedName);
                
                if (fs.existsSync(rawExtractedPath)) {
                    fs.renameSync(rawExtractedPath, finalSrtPath);
                    srtExtracted = true;
                }
            }
        });

        // Clean up temporary tracking artifacts instantly
        if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);

        if (srtExtracted) {
            logger.debug(`✨ YIFY Pipeline successfully downloaded and mapped: English.srt`);
            return [{ language: 'eng', relativePath: 'English.srt', source: 'yify' }];
        } else {
            throw new Error("No usable SRT files found inside the downloaded archive container.");
        }

    } catch (err) {
        // Safe clean up fallback check if zip processing bombed out midway
        if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
        logger.debug(`⚠️ YIFY subtitle ingestion skipped: ${err.message}. Routing to fallbacks...`, 'warn');
        return null;
    }
}

/**
 * Strategy 2: CLI Subliminal Backup Engine
 */
function fetchSubliminalFallback(imdbId, folderPath) {
    return new Promise((resolve) => {
        logger.debug(`⏳ Starting Subliminal verification routines on folder target...`);
        const cmd = `subliminal download -l en -i ${imdbId} "${folderPath}"`;

        exec(cmd, (err) => {
            if (err) {
                logger.debug(`⚠️ Subliminal worker execution finished empty. Moving down pipeline.`, 'warn');
                return resolve([]);
            }

            const files = fs.readdirSync(folderPath);
            const srtFile = files.find(f => f.endsWith('.srt') && f.toLowerCase() !== 'english.srt');

            if (srtFile) {
                const standardizedName = 'English.srt';
                fs.renameSync(path.join(folderPath, srtFile), path.join(folderPath, standardizedName));
                return resolve([{ language: 'eng', relativePath: standardizedName, source: 'subliminal' }]);
            }

            resolve([]);
        });
    });
}

// =========================================================================
// 📥 PROCESS API ENDPOINT ROUTING
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, imdbId, folderName } = req.body;

    if (!folderPath || !imdbId) {
        return res.status(400).json({ success: false, error: "Missing required folderPath or imdbId context parameters." });
    }

    try {
        // ✨ FAST PASS SYSTEM CHECK: Scan files for ANY common subtitle tracks to bypass APIs entirely
        const filesOnDisk = fs.existsSync(folderPath) ? fs.readdirSync(folderPath) : [];
        const subtitleExists = filesOnDisk.some(f => 
            f.toLowerCase() === 'english.srt' || f.toLowerCase().endsWith('.vtt')
        );

        if (subtitleExists) {
            logger.debug(`⏭️ [SUBTITLES] Skipping [${folderName || path.basename(folderPath)}]. Subtitle track already present on disk.`);
            return res.json({
                success: true,
                message: "Subtitle track verified instantly via local storage check.",
                patchData: { subtitles: [{ language: 'eng', relativePath: 'English.srt', source: 'local-cached' }] }
            });
        }

        // Step 1: Fire high-speed YIFY custom pipeline
        let records = await fetchYifySubtitles(imdbId, folderPath);

        // Step 2: If YIFY comes up short or hits a wall, execute Subliminal
        if (!records || records.length === 0) {
            records = await fetchSubliminalFallback(imdbId, folderPath);
        }

        // Return unified response structures cleanly back to the Orchestrator loop
        return res.json({
            success: true,
            message: records.length > 0 ? "Subtitle profiles resolved successfully." : "Subtitle sweeps completed with empty records.",
            patchData: { subtitles: records }
        });

    } catch (err) {
        logger.error(`❌ Subtitle Worker structural exception on ${folderName}: ${err.message}`, 'error');
        return res.json({ success: true, patchData: { subtitles: [] } });
    }
});

const PORT = process.env.SUBTITLE_WORKER_PORT || 5002;
app.listen(PORT, () => console.log(`💬 Atomic Subtitle Engine running on loopback port ${PORT}`));