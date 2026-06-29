// src/services/workers/MetadataWorker.js
// Stateless Service Plugin handling unified OMDb lookups for Movies and complex TV Multi-Season maps.

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const app = express();
app.use(express.json());

const API_KEY = process.env.OMDB_API_KEY || '84196d01';

// =========================================================================
// ATOMIC PROCESS API ENDPOINT
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName, contentType, manualImdbId } = req.body;

    if (!folderPath || !folderName) {
        return res.status(400).json({ success: false, error: "Missing folderPath or folderName parameters." });
    }

    try {
        // Reverse engineer clean terms from directory structures
        const cleanTitle = folderName.replace(/\./g, ' ');
        const yearMatch = folderName.match(/\.(\d{4})$/);
        const parsedYear = yearMatch ? yearMatch[1] : '';

        // Determine whether this target is treated as a movie or series branch
        const targetType = contentType || (folderPath.includes('/series') ? 'series' : 'movie');

        let queryUrl = `http://www.omdbapi.com/?apikey=${API_KEY}&type=${targetType}`;
        if (manualImdbId) {
            queryUrl += `&i=${manualImdbId}`;
        } else {
            const searchQueryTitle = cleanTitle.replace(/\b(19|20)\d{2}\b.*/g, '').trim();
            queryUrl += `&t=${encodeURIComponent(searchQueryTitle)}`;
            if (parsedYear) queryUrl += `&y=${parsedYear}`;
        }

        const omdbRes = await axios.get(queryUrl);
        const data = omdbRes.data;

        // Fallback profile object if external lookup fails entirely
        if (data.Response === "False") {
            logger.debug(`⚠️ OMDb lookup failed for ${folderName}: ${data.Error}. Implementing local asset fallbacks.`, 'warn');
            return res.json({
                success: true,
                message: "Resolved using local data fallbacks.",
                patchData: {
                    title: cleanTitle.replace(/\b(19|20)\d{2}\b.*/g, '').trim(),
                    year: parsedYear || "Unknown",
                    plot: "Local library file registry asset wrapper.",
                    genre: "Media",
                    contentType: targetType,
                    pipelineState: { currentStep: 'SUBTITLES', lastUpdated: new Date().toISOString() }
                }
            });
        }

        // Atomically handle poster streaming download directly into storage location
        if (data.Poster && data.Poster !== "N/A") {
            try {
                const imgRes = await axios({ method: 'GET', url: data.Poster, responseType: 'stream', timeout: 10000 });
                imgRes.data.pipe(fs.createWriteStream(path.join(folderPath, 'cover.jpg')));
            } catch (imgErr) {
                logger.error(`⚠️ Poster download skipped seamlessly: ${imgErr.message}`, 'warn');
            }
        }

        // Core metadata structure to apply back to metadata.json
        let basePatchData = {
            imdbId: data.imdbID,
            title: data.Title,
            year: data.Year,
            plot: data.Plot,
            genre: data.Genre,
            rating: data.imdbRating || 'N/A',
            runtime: data.Runtime || 'N/A',
            contentType: targetType,
            pipelineState: { currentStep: 'SUBTITLES', lastUpdated: new Date().toISOString() }
        };

        // =========================================================================
        // MULTI-SEASON TV SERIES EXTRACTION LOOP (RETAINED & SANITIZED)
        // =========================================================================
        if (targetType === 'series') {
            const totalSeasons = parseInt(data.totalSeasons, 10) || 1;
            const diskItems = fs.readdirSync(folderPath);
            let physicalFileMap = {};

            // Map physical season folders and child files
            diskItems.forEach(item => {
                const itemPath = path.join(folderPath, item);
                if (fs.lstatSync(itemPath).isDirectory()) {
                    fs.readdirSync(itemPath).forEach(file => {
                        const match = file.match(/s\s*(\d+)\s*e\s*(\d+)/i);
                        if (match) {
                            const sNum = parseInt(match[1], 10), eNum = parseInt(match[2], 10);
                            // Store relative asset pointer locations
                            physicalFileMap[`${sNum}-${eNum}`] = `series/${folderName}/${item}/${file}`;
                        }
                    });
                }
            });

            let fullSeriesStructure = { totalSeasons: totalSeasons.toString(), seasons: {} };

            for (let s = 1; s <= totalSeasons; s++) {
                fullSeriesStructure.seasons[s] = { seasonNumber: s.toString(), episodes: [] };
                try {
                    const seasonUrl = `http://www.omdbapi.com/?apikey=${API_KEY}&t=${encodeURIComponent(data.Title)}&Season=${s}`;
                    const seasonRes = await axios.get(seasonUrl);
                    
                    if (seasonRes.data && seasonRes.data.Response === "True" && seasonRes.data.Episodes) {
                        for (const ep of seasonRes.data.Episodes) {
                            const epNum = parseInt(ep.Episode, 10);
                            const isAvailable = !!physicalFileMap[`${s}-${epNum}`];
                            
                            fullSeriesStructure.seasons[s].episodes.push({
                                episodeNumber: epNum,
                                title: ep.Title || `Episode ${epNum}`,
                                released: ep.Released || 'Unknown',
                                plot: 'Official serialized episode tracking interface asset.',
                                imdbRating: ep.imdbRating || 'N/A',
                                available: isAvailable,
                                localRelativePath: isAvailable ? physicalFileMap[`${s}-${epNum}`] : null,
                                remoteRelativePath: null // Structural placeholder ready for cloud migration workflows
                            });
                        }
                    }
                } catch (seae) {
                    logger.error(`⚠️ Error processing details for season loop ${s}: ${seae.message}`, 'warn');
                }
                fullSeriesStructure.seasons[s].episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
            }

            // Write out the companion catalog mapping manifest file directly
            fs.writeFileSync(path.join(folderPath, 'series.json'), JSON.stringify(fullSeriesStructure, null, 4));
        }

        return res.json({
            success: true,
            message: "Metadata alignment completed successfully.",
            patchData: basePatchData
        });

    } catch (err) {
        logger.error(`❌ Critical Metadata Worker fault on folder ${folderName}: ${err.message}`, 'error');
        return res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.METADATA_WORKER_PORT || 5001;
app.listen(PORT, () => console.log(`📡 Atomic TV/Movie Metadata Worker listening on port ${PORT}`));