// src/services/workers/CloudSyncWorker.js
// Stateless Atomic Object Storage Sync Worker with Multi-Cloud Provider Drop-Ins.

const express = require('express');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const path = require('path');
const fs = require('fs');
const logger = require('../logger');

const app = express();
app.use(express.json());

const BUCKET_NAME = process.env.CLOUD_BUCKET_NAME || 'joshflixmedia';

const s3Client = new S3Client({
    endpoint: process.env.CLOUD_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com',
    credentials: {
        accessKeyId: process.env.BBkeyID,
        secretAccessKey: process.env.BBapplicationKey
    },
    region: process.env.CLOUD_REGION || 'us-west-004'
});

// =========================================================================
// 📥 PRIMARY INGESTION WORKER ROUTE
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName, forceActualUpload } = req.body;

    // Check both request body and optional URL query string flags for manual overrides
    const executeCloudUpload = forceActualUpload === true || req.query.forceActualUpload === 'true';

    if (!folderPath || !folderName) {
        return res.status(400).json({ success: false, error: "Missing required folderPath or folderName contexts." });
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
            } else {
                logger.info(`🔒 [LOCAL SAFEMODE] Bypassing cloud upload pipelines for [${profile}] inside ${folderName}. Updating manifest directly to synced.`);
                // Keep the location descriptor local since the physical asset wasn't copied to B2
                patchData.storage.location = 'local';
            }

            // Advance state values safely to unblock pipeline trees
            patchData.storage.files[profile] = {
                status: "synced",
                localPath: path.basename(localVideoPath),
                remoteKey: executeCloudUpload ? remoteKey : null
            };
            
            hasProcessedAny = true;
        }

        // Force downstream pipeline tracking state to fully clear out 'UPLOAD' steps
        patchData.pipelineState = {
            currentStep: 'COMPLETED',
            lastUpdated: new Date().toISOString(),
            error: null
        };

        return res.json({
            success: true,
            message: executeCloudUpload 
                ? "Cloud synchronization cycles finalized seamlessly." 
                : "Safe-mode manifest translation finalized successfully. Pipeline state updated to COMPLETED.",
            patchData: patchData
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