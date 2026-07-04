// src/services/workers/MetadataWorker.js
// Stateless Service Plugin handling unified OMDb lookups for Movies and complex TV Multi-Season maps.

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const metadataService = require('../MetadataService');
const metadataProvider = require('../MetadataProvider');

const app = express();
app.use(express.json());

function normalizeTagList(value, fallback = []) {
    const source = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(',') : fallback);

    return [...new Set(source.map(tag => String(tag).trim()).filter(Boolean))].sort();
}

function buildEnrichmentBlock(data = {}, fallback = {}) {
    const genre = data.Genre || fallback.genre || 'Media';
    return {
        genre,
        tags: normalizeTagList(data.tags || data.Tags || fallback.tags || genre),
        imdbScore: data.imdbRating || fallback.imdbScore || 'N/A',
        parentalRating: data.Rated || fallback.parentalRating || 'N/A',
        popularity: data.imdbVotes || fallback.popularity || 'N/A',
        popularitySource: data.imdbVotes ? 'imdbVotes' : (fallback.popularitySource || 'unknown')
    };
}

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

        const searchQueryTitle = cleanTitle.replace(/\b(19|20)\d{2}\b.*/g, '').trim();
        const lookup = await metadataProvider.fetchMetadataWithFallback({
            imdbId: manualImdbId || '',
            title: searchQueryTitle,
            year: parsedYear || '',
            contentType: targetType
        });
        const data = lookup.data;

        logger.debug(`🧭 [Metadata] Resolved lookup for ${folderName} | provider=${lookup.provider} | imdbId=${data?.imdbID || 'unknown'} | title=${data?.Title || cleanTitle} | mode=${targetType}`);

        // Fallback profile object if external lookup fails entirely
        if (!data || data.Response === "False") {
            logger.debug(`⚠️ Metadata lookup failed for ${folderName}. Implementing local asset fallbacks.`, 'warn');
            const fallbackEnrichment = buildEnrichmentBlock(
                {
                    Genre: 'Media',
                    imdbRating: 'N/A',
                    Rated: 'N/A',
                    imdbVotes: 'N/A',
                    tags: [targetType, 'media']
                },
                { popularitySource: 'fallback' }
            );
            return res.json({
                success: true,
                message: "Resolved using local data fallbacks.",
                patchData: {
                    title: cleanTitle.replace(/\b(19|20)\d{2}\b.*/g, '').trim(),
                    year: parsedYear || "Unknown",
                    plot: "Local library file registry asset wrapper.",
                    genre: "Media",
                    tags: fallbackEnrichment.tags,
                    imdbScore: fallbackEnrichment.imdbScore,
                    parentalRating: fallbackEnrichment.parentalRating,
                    popularity: fallbackEnrichment.popularity,
                    enrichment: fallbackEnrichment,
                    contentType: targetType,
                    pipelineState: { currentStep: 'SUBTITLES', lastUpdated: new Date().toISOString() }
                }
            });
        }

        // Atomically handle poster streaming download directly into storage location
        if (data.Poster && data.Poster !== "N/A") {
            try {
                const posterPath = path.join(folderPath, 'cover.jpg');
                await metadataService.downloadCover(data.Poster, posterPath);
                logger.debug(`🖼️ [Metadata] Poster saved to ${posterPath}`);
            } catch (imgErr) {
                logger.error(`⚠️ Poster download skipped seamlessly: ${imgErr.message}`, 'warn');
            }
        }

        // Core metadata structure to apply back to metadata.json
        const enrichment = buildEnrichmentBlock(data);
        let basePatchData = {
            imdbId: data.imdbID,
            title: data.Title,
            year: data.Year,
            plot: data.Plot,
            genre: data.Genre,
            tags: enrichment.tags,
            imdbScore: enrichment.imdbScore,
            parentalRating: enrichment.parentalRating,
            popularity: enrichment.popularity,
            enrichment,
            rating: enrichment.imdbScore,
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
                    const episodes = await metadataProvider.fetchSeasonEpisodesWithFallback({
                        imdbId: data.imdbID || '',
                        title: data.Title || cleanTitle,
                        season: s,
                        tmdbId: data.tmdbId || null
                    });

                    if (Array.isArray(episodes) && episodes.length > 0) {
                        for (const ep of episodes) {
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