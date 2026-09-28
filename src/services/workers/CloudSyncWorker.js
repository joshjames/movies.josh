// src/services/workers/CloudSyncWorker.js
// Stateless Atomic Object Storage Sync Worker with Multi-Cloud Provider Drop-Ins.

const express = require('express');
const axios = require('axios');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const path = require('path');
const fs = require('fs');
const logger = require('../logger');
const MetadataRegistry = require('../MetadataRegistry');
require('dotenv').config({ path: path.join(__dirname, '../../../.env'), quiet: true });
const app = express();
app.use(express.json());

const BUCKET_NAME = process.env.CLOUD_BUCKET_NAME || 'joshflixmedia';
// File-discovery logic (RESOLUTION_PROFILES/profileSuffix/
// parseEpisodeFromFilename/walkSeriesEpisodeFiles) now lives in the shared
// MediaFileWalker.js - see TranscoderWorker.js's own require for the
// matching rationale.
const { RESOLUTION_PROFILES, profileSuffix, parseEpisodeFromFilename, walkSeriesEpisodeFiles } = require('../MediaFileWalker');

const s3Client = new S3Client({
    endpoint: process.env.CLOUD_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com',
    credentials: {
        accessKeyId: process.env.BBkeyID,
        secretAccessKey: process.env.BBapplicationKey
    },
    region: process.env.CLOUD_REGION || 'us-west-004',
    maxAttempts: 3,
    // No timeout was configured before - a stalled TCP connection (e.g. a
    // transient network blip mid-upload) would hang forever with zero CPU
    // usage instead of failing and letting the caller/retry logic take over.
    requestHandler: new NodeHttpHandler({
        connectionTimeout: 10_000,
        requestTimeout: 5 * 60 * 1000
    })
});

// Confirmed root cause of a real incident (2026-09-27, Scott Pilgrim Takes
// Off episode 7): a profile's manifest entry can carry a remoteKey without
// the object actually existing in B2 (e.g. a write ordering race, or an
// upload that got interrupted after the manifest update but before the
// stream fully flushed). Everywhere that used to trust "remoteKey is set"
// as proof of being synced now verifies it against B2 directly instead -
// this is the one stage whose failure mode is silent data loss, so it's
// worth the extra round trip other stages don't need.
async function verifyRemoteObjectExists(key) {
    try {
        await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
        return true;
    } catch (_err) {
        return false;
    }
}

// =========================================================================
// 📺 SERIES/EPISODE OBJECT STORAGE - same bucket, a "series/" prefix instead
// of "movies/", keyed by episode instead of by folder.
// =========================================================================

// profileSuffix/parseEpisodeFromFilename/walkSeriesEpisodeFiles now come
// from the shared MediaFileWalker.js require above.

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
    const claimedSynced = [];
    for (const { season, episode, files } of episodeFiles.values()) {
        const existingStorage = existingStorageByKey[`${season}-${episode}`];

        for (const profile of RESOLUTION_PROFILES) {
            const localPath = files[profile];
            const existingRemoteKey = existingStorage?.files?.[profile]?.remoteKey;

            if (existingRemoteKey) {
                // Manifest claims this is already synced - verified below,
                // not trusted blindly (see verifyRemoteObjectExists comment).
                claimedSynced.push({ season, episode, profile, remoteKey: existingRemoteKey, localPath: localPath || null });
                continue;
            }
            if (!localPath) continue; // nothing local for this profile yet (needs transcode first) - legitimately not ready, not an error

            uploads.push({ season, episode, profile, localPath });
        }
    }

    // 'COMPLETED' (not 'COMPLETE') to match the movie path below and every
    // other pipelineState.currentStep writer (TranscoderWorker.js,
    // admin.routes.js) - PipelineWorker.js translates either spelling to the
    // job queue's own 'COMPLETE' convention at the one place they meet.
    const completePatch = { pipelineState: { currentStep: 'COMPLETED', lastUpdated: new Date().toISOString() } };

    if (!executeCloudUpload) {
        return {
            success: true,
            message: `Safe-mode scan found ${uploads.length} episode profile(s) ready to sync.`,
            pending: uploads.map(({ season, episode, profile }) => ({ season, episode, profile })),
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

    // Verify what the manifest already claims is synced - not just what we
    // just uploaded. This is the check that would have caught the confirmed
    // incident: episode 7 had a remoteKey in series.json but the object was
    // never actually in B2, and nothing here ever asked B2 to confirm it.
    let verifiedCount = 0;
    for (const item of claimedSynced) {
        const exists = await verifyRemoteObjectExists(item.remoteKey);
        if (exists) {
            verifiedCount += 1;
            continue;
        }

        const msg = `S${item.season}E${item.episode} [${item.profile}]: manifest claims synced (${item.remoteKey}) but the object is missing from B2.`;
        logger.error(`❌ [Series Cloud Sync Verify] ${msg}`);

        if (item.localPath && fs.existsSync(item.localPath)) {
            try {
                logger.info(`🚑 [Series Cloud Sync Verify] Local source still present - re-uploading S${item.season}E${item.episode} [${item.profile}].`);
                await uploadLargeFileStream(item.localPath, item.remoteKey, item.profile);
                verifiedCount += 1;
            } catch (err) {
                errors.push(`${msg} Re-upload attempt also failed: ${err.message}`);
            }
        } else {
            errors.push(`${msg} Local source file is also missing - this episode needs to be re-transcoded before it can sync.`);
        }
    }

    const totalConsidered = uploads.length + claimedSynced.length;
    const totalGood = uploadedCount + verifiedCount;

    return {
        success: errors.length === 0,
        message: totalConsidered === 0
            ? 'No episode profiles found to sync.'
            : `${totalGood}/${totalConsidered} episode profile(s) confirmed synced to cloud storage (${uploadedCount} newly uploaded, ${verifiedCount} verified already present).`,
        uploadedCount,
        verifiedCount,
        totalQueued: uploads.length,
        totalVerified: claimedSynced.length,
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
        const errors = [];

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
                // A named, real failure - not a silent skip. This profile was
                // marked 'pending' (meaning TRANSCODE said it was ready), so a
                // missing file here means something deleted the transcoded
                // output between stages, not "nothing to do yet".
                const msg = `Profile ${profile} for ${folderName} is marked pending but its local file is missing on disk.`;
                logger.error(`❌ [Cloud Sync] ${msg}`);
                errors.push(msg);
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

    if (executeCloudUpload && !hasProcessedAny && errors.length > 0) {
        return res.json({
            success: false,
            error: errors.join('; '),
            errors,
            patchData: metadata
        });
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

    // Verify what the manifest claims is already synced, not just what this
    // pass uploaded - closes the same silent-data-loss gap fixed on the
    // series path (a remoteKey in the manifest isn't proof the object is
    // actually in B2). Only runs in real (non-safe-mode) execution.
    if (executeCloudUpload) {
        for (const profile of resolutionProfiles) {
            const fileBlock = metadata.storage.files?.[profile];
            if (!fileBlock || fileBlock.status !== 'synced' || !fileBlock.remoteKey) continue;

            const exists = await verifyRemoteObjectExists(fileBlock.remoteKey);
            if (exists) continue;

            const msg = `Profile ${profile} for ${folderName}: manifest claims synced (${fileBlock.remoteKey}) but the object is missing from B2.`;
            logger.error(`❌ [Cloud Sync Verify] ${msg}`);

            const localVideoPath = fileBlock.localPath ? path.join(folderPath, fileBlock.localPath) : null;
            if (localVideoPath && fs.existsSync(localVideoPath)) {
                try {
                    logger.info(`🚑 [Cloud Sync Verify] Local source still present - re-uploading [${profile}] for ${folderName}.`);
                    await uploadLargeFileStream(localVideoPath, fileBlock.remoteKey, profile);
                } catch (err) {
                    errors.push(`${msg} Re-upload attempt also failed: ${err.message}`);
                    metadata.storage.files[profile] = { ...fileBlock, status: 'pending' };
                }
            } else {
                errors.push(`${msg} Local source file is also missing - this title needs to be re-transcoded before it can sync.`);
                metadata.storage.files[profile] = { ...fileBlock, status: 'pending' };
            }
        }
    }

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
        success: errors.length === 0,
        message: errors.length > 0
            ? `Completed with ${errors.length} error(s) - see errors[] for detail.`
            : (executeCloudUpload
                ? "Cloud synchronization cycles finalized seamlessly and state persisted to disk."
                : "Safe-mode manifest translation finalized successfully. Pipeline state updated to COMPLETED."),
        errors: errors.length ? errors : undefined,
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

// =========================================================================
// 🧵 BULLMQ CONSUMER (pipeline orchestrator redesign, phased migration)
// =========================================================================
// Thin adapter, not a rewrite - see IngestSanitizerWorker.js for the same
// pattern and its rationale. Only reached for jobs tagged
// payload.pipelineMode === 'bullmq'.
const { Worker } = require('bullmq');
const { getPipelineRedisConnection } = require('../BullMQConnection');
const { STAGE_QUEUE_NAMES, STAGE_JOB_OPTIONS, LOCK_DURATION_MS } = require('../PipelineQueues');

const cloudsyncQueueWorker = new Worker(
    STAGE_QUEUE_NAMES.CLOUDSYNC,
    async (job) => {
        const response = await axios.post(`http://localhost:${PORT}/process`, job.data, { timeout: 1800000 });
        if (response.data?.success === false) {
            throw new Error(response.data?.error || 'Cloud sync worker reported failure.');
        }
        return response.data;
    },
    { connection: getPipelineRedisConnection(), concurrency: STAGE_JOB_OPTIONS.CLOUDSYNC.concurrency, lockDuration: LOCK_DURATION_MS }
);

cloudsyncQueueWorker.on('completed', (job) => {
    logger.debug(`🧵 [BullMQ] pipeline-cloudsync job ${job.id} completed.`);
});
cloudsyncQueueWorker.on('failed', (job, err) => {
    logger.error(`🧵 [BullMQ] pipeline-cloudsync job ${job?.id} failed: ${err.message}`);
});