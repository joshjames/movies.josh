// src/services/workers/CloudSyncWorker.js
// Stateless Atomic Object Storage Sync Worker with Multi-Cloud Provider Drop-Ins.

const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const path = require('path');
const fs = require('fs');
const logger = require('../logger');
const MetadataRegistry = require('../MetadataRegistry');
require('dotenv').config({ path: path.join(__dirname, '../../../.env'), quiet: true });
const app = express();
app.use(express.json());

const BUCKET_NAME = process.env.CLOUD_BUCKET_NAME || 'joshflixmedia';
const RESOLUTION_PROFILES = ['1080p', '720p', '480p'];

const s3Client = new S3Client({
    endpoint: process.env.CLOUD_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com',
    credentials: {
        accessKeyId: process.env.BBkeyID,
        secretAccessKey: process.env.BBapplicationKey
    },
    region: process.env.CLOUD_REGION || 'us-west-004'
});

// =========================================================================
// 📺 SERIES/EPISODE OBJECT STORAGE - same bucket, a "series/" prefix instead
// of "movies/", keyed by episode instead of by folder.
// =========================================================================

// Same suffix convention used everywhere else in the pipeline for a
// browser-ready profile: ".web.mp4" for 1080p, ".720p.mp4"/".480p.mp4" for
// the rest (see TranscoderWorker.js / the movie logic below).
function profileSuffix(profile) {
    return profile === '1080p' ? '.web.mp4' : `.${profile}.mp4`;
}

// Same episode-matching regex MetadataWorker.js uses to build series.json,
// reused here so file discovery can never disagree with what series.json
// already thinks exists.
function parseEpisodeFromFilename(fileName) {
    const match = String(fileName || '').match(/s\s*(\d+)\s*e\s*(\d+)/i);
    if (!match) return null;
    return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
}

// Walk a series root's season subfolders and, for each episode found on
// disk, record the local file path for whichever resolution profiles
// already exist. One level deep only (season folders directly under the
// series root), matching how MetadataWorker.js scans for episode files.
function walkSeriesEpisodeFiles(seriesRootPath) {
    const episodes = new Map(); // key: "season-episode" -> { season, episode, files: { profile: absolutePath } }

    let entries;
    try {
        entries = fs.readdirSync(seriesRootPath, { withFileTypes: true });
    } catch (_err) {
        return episodes;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const seasonDir = path.join(seriesRootPath, entry.name);

        let files;
        try {
            files = fs.readdirSync(seasonDir);
        } catch (_err) {
            continue;
        }

        for (const file of files) {
            const parsed = parseEpisodeFromFilename(file);
            if (!parsed) continue;

            const key = `${parsed.season}-${parsed.episode}`;
            if (!episodes.has(key)) {
                episodes.set(key, { season: parsed.season, episode: parsed.episode, files: {} });
            }
            const record = episodes.get(key);

            for (const profile of RESOLUTION_PROFILES) {
                if (record.files[profile]) continue; // already matched one for this profile
                if (file.toLowerCase().endsWith(profileSuffix(profile))) {
                    record.files[profile] = path.join(seasonDir, file);
                }
            }
        }
    }

    return episodes;
}

function buildSeriesRemoteKey(directoryId, season, episode, profile) {
    const seasonPadded = String(season).padStart(2, '0');
    const episodePadded = String(episode).padStart(2, '0');
    return `series/${directoryId}/season.${seasonPadded}/s${seasonPadded}e${episodePadded}/${profile}.mp4`
        .replace(/\/+/g, '/');
}

async function processSeriesFolder({ folderPath, folderName, imdbId, executeCloudUpload }) {
    const seriesJsonPath = path.join(folderPath, 'series.json');
    if (!fs.existsSync(seriesJsonPath)) {
        return { success: false, error: 'Aborting series sync: series.json tracking manifest missing.' };
    }

    const directoryId = (imdbId && imdbId !== 'N/A') ? imdbId : folderName;
    const episodeFiles = walkSeriesEpisodeFiles(folderPath);

    let currentStructure;
    try {
        currentStructure = JSON.parse(fs.readFileSync(seriesJsonPath, 'utf-8'));
    } catch (err) {
        return { success: false, error: `series.json is unreadable: ${err.message}` };
    }

    // What's already synced, per the tracking manifest - not the disk walk
    // alone - so a re-run never re-uploads something that already has a
    // remoteKey.
    const existingStorageByKey = {};
    for (const season of Object.values(currentStructure.seasons || {})) {
        for (const ep of (season.episodes || [])) {
            existingStorageByKey[`${season.seasonNumber}-${ep.episodeNumber}`] = ep.storage || null;
        }
    }

    const uploads = [];
    for (const { season, episode, files } of episodeFiles.values()) {
        const existingStorage = existingStorageByKey[`${season}-${episode}`];

        for (const profile of RESOLUTION_PROFILES) {
            const localPath = files[profile];
            if (!localPath) continue; // nothing local for this profile yet (needs transcode first)
            if (existingStorage?.files?.[profile]?.remoteKey) continue; // already synced

            uploads.push({ season, episode, profile, localPath });
        }
    }

    const completePatch = { pipelineState: { currentStep: 'COMPLETE', lastUpdated: new Date().toISOString() } };

    if (!executeCloudUpload) {
        return {
            success: true,
            message: `Safe-mode scan found ${uploads.length} episode profile(s) ready to sync.`,
            pending: uploads.map(({ season, episode, profile }) => ({ season, episode, profile })),
            patchData: completePatch
        };
    }

    if (uploads.length === 0) {
        return {
            success: true,
            message: 'No new episode profiles to sync - already up to date.',
            patchData: completePatch
        };
    }

    const errors = [];
    let uploadedCount = 0;

    for (const { season, episode, profile, localPath } of uploads) {
        const remoteKey = buildSeriesRemoteKey(directoryId, season, episode, profile);
        try {
            logger.info(`🚀 [Series Cloud Sync] Uploading S${season}E${episode} [${profile}] -> ${remoteKey}`);
            await uploadLargeFileStream(localPath, remoteKey, profile);

            await MetadataRegistry.mergeAndCommit(seriesJsonPath, folderName, async (structure) => {
                const next = { ...structure, seasons: { ...structure.seasons } };
                const seasonEntry = next.seasons[season];
                if (!seasonEntry) return next; // season vanished from series.json since we scanned - skip safely

                const episodes = [...(seasonEntry.episodes || [])];
                const idx = episodes.findIndex((e) => Number(e.episodeNumber) === episode);
                if (idx === -1) return next;

                const currentEp = episodes[idx];
                const existingFiles = currentEp.storage?.files || {};
                episodes[idx] = {
                    ...currentEp,
                    storage: {
                        location: 'remote',
                        files: {
                            ...existingFiles,
                            [profile]: { status: 'synced', localPath: path.basename(localPath), remoteKey }
                        }
                    }
                };

                next.seasons[season] = { ...seasonEntry, episodes };
                return next;
            });

            uploadedCount += 1;
        } catch (err) {
            const msg = `S${season}E${episode} [${profile}]: ${err.message}`;
            logger.error(`❌ [Series Cloud Sync] Upload failed for ${msg}`);
            errors.push(msg);
        }
    }

    return {
        success: errors.length === 0,
        message: `Synced ${uploadedCount}/${uploads.length} episode profile(s) to cloud storage.`,
        uploadedCount,
        totalQueued: uploads.length,
        errors,
        patchData: completePatch
    };
}

// =========================================================================
// 📥 PRIMARY INGESTION WORKER ROUTE
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName, forceActualUpload, contentType, imdbId } = req.body;

    // Check both request body and optional URL query string flags for manual overrides
    const executeCloudUpload = forceActualUpload === true || req.query.forceActualUpload === 'true';

    if (!folderPath || !folderName) {
        return res.status(400).json({ success: false, error: "Missing required folderPath or folderName contexts." });
    }

    if (contentType === 'series') {
        try {
            const result = await processSeriesFolder({ folderPath, folderName, imdbId, executeCloudUpload });
            return res.json(result);
        } catch (err) {
            logger.error(`❌ Series Cloud Sync Worker failure on target ${folderName}: ${err.message}`);
            return res.json({ success: false, error: err.message });
        }
    }

    try {
        const metaFilePath = path.join(folderPath, 'metadata.json');
        if (!fs.existsSync(metaFilePath)) {
            return res.json({ success: false, error: "Aborting sync: metadata.json tracking manifest missing." });
        }

        let metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));

        if (!metadata.storage) { 
            metadata.storage = { location: 'local', files: {} };
        }

        const resolutionProfiles = ['1080p', '720p', '480p'];
        let patchData = { storage: { ...metadata.storage } };
        let hasProcessedAny = false;

        for (const profile of resolutionProfiles) {
            const fileBlock = metadata.storage.files?.[profile];
            
            if (!fileBlock || fileBlock.status !== 'pending') continue;

            let localVideoPath = fileBlock.localPath ? path.join(folderPath, fileBlock.localPath) : null;

            if (!localVideoPath || !fs.existsSync(localVideoPath)) {
                const files = fs.readdirSync(folderPath);
                const targetSuffix = profile === '1080p' ? '.web.mp4' : `.${profile}.mp4`;
                const matchedFile = files.find(f => f.endsWith(targetSuffix));
                
                if (matchedFile) {
                    localVideoPath = path.join(folderPath, matchedFile);
                }
            }

            if (!localVideoPath || !fs.existsSync(localVideoPath)) {
                logger.warn(`ℹ️ [Cloud Sync Skip] Profile ${profile} for ${folderName} is pending but file is physically absent. Skipping.`);
                continue;
            }

            const directoryId = (metadata.imdbId && metadata.imdbId !== 'N/A') ? metadata.imdbId : folderName;
            const remoteKey = `movies/${directoryId}/${profile}.mp4`.replace(/\/+/g, '/');

            // 🔀 OVERRIDE ROUTING GATEWAY
            if (executeCloudUpload) {
                logger.info(`🚀 [MANUAL OVERRIDE] Stream-uploading [${profile}] to cloud block store: ${remoteKey}`);
                await uploadLargeFileStream(localVideoPath, remoteKey, profile);
                patchData.storage.location = 'remote';

                // Advance state values only after successful upload
                patchData.storage.files[profile] = {
                    status: 'synced',
                    localPath: path.basename(localVideoPath),
                    remoteKey
                };
                hasProcessedAny = true;
            } else {
                logger.info(`🔒 [LOCAL SAFEMODE] Bypassing cloud upload for [${profile}] inside ${folderName}. Keeping profile pending.`);
                patchData.storage.location = metadata.storage?.location || 'local';

                patchData.storage.files[profile] = {
                    ...(metadata.storage?.files?.[profile] || {}),
                    status: 'pending',
                    localPath: path.basename(localVideoPath),
                    remoteKey: metadata.storage?.files?.[profile]?.remoteKey || null
                };
            }
        }

    if (executeCloudUpload && !hasProcessedAny) {
        return res.json({
            success: false,
            error: `No pending local stream profiles found for ${folderName}.` ,
            patchData: metadata
        });
    }

    // =========================================================================
    // 💾 PHYSICAL STATE PERSISTENCE FIX
    // =========================================================================
    // Deep merge the newly processed patchData back into the original metadata
    metadata.storage.location = patchData.storage.location;
    metadata.storage.files = {
        ...metadata.storage.files,
        ...patchData.storage.files
    };
    
    // Synchronize downstream pipeline tracking states completely
    metadata.pipelineState = {
        currentStep: 'COMPLETED',
        lastUpdated: new Date().toISOString(),
        error: null
    };

    // Physically overwrite the metadata.json manifest file on local storage disk
    fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
    logger.info(`💾 [Cloud Sync Manifest Update]: Successfully synced local state changes back to ${metaFilePath}`);

    return res.json({
        success: true,
        message: executeCloudUpload 
            ? "Cloud synchronization cycles finalized seamlessly and state persisted to disk." 
            : "Safe-mode manifest translation finalized successfully. Pipeline state updated to COMPLETED.",
        patchData: metadata // Return full synchronized object back to orchestration queue loops
    });

} catch (err) {
    logger.error(`❌ Cloud Sync Worker failure on target ${folderName}: ${err.message}`);
    return res.json({ success: false, error: err.message });
}
});

// =========================================================================
// 📦 HIGH-RELIABILITY MULTIPART S3 STREAM CHUNKER
// =========================================================================
async function uploadLargeFileStream(localPath, remoteKey, profile) {
    const fileStream = fs.createReadStream(localPath);
    
    const uploadWorker = new Upload({
        client: s3Client,
        params: {
            Bucket: BUCKET_NAME,
            Key: remoteKey,
            Body: fileStream,
            ContentType: 'video/mp4'
        },
        queueSize: 4,
        partSize: 1024 * 1024 * 5
    });

    uploadWorker.on('httpUploadProgress', (p) => {
        const mbSent = (p.loaded / (1024 * 1024)).toFixed(2);
        logger.debug(`⏳ [Sync Chunk Tracking] [${profile}] Progressed: ${mbSent} MB`);
    });

    await uploadWorker.done(); 
}

const PORT = process.env.CLOUD_SYNC_WORKER_PORT || 5004;
app.listen(PORT, () => console.log(`☁️ Atomic Cloud Sync Engine safe-mode engine online on port ${PORT}`));