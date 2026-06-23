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

// =========================================================================
// 🌐 MULTI-CLOUD STORAGE CLIENT SETUP MATRIX (CHOOSE YOUR BACKEND)
// =========================================================================

// OPTION A: BACKBLAZE B2 (Your current production-ready configuration)
const s3Client = new S3Client({
    endpoint: process.env.CLOUD_ENDPOINT || 'https://s3.us-west-004.backblazeb2.com',
    credentials: {
        accessKeyId: process.env.BBkeyID,
        secretAccessKey: process.env.BBapplicationKey
    },
    region: process.env.CLOUD_REGION || 'us-west-004'
});

/* // OPTION B: CLOUDFLARE R2 (Zero Egress Fees - Perfect for heavy streaming)
// npm install @aws-sdk/client-s3
const s3Client = new S3Client({
    endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    },
    region: 'auto'
});

// OPTION C: WEBDAV / HETZNER STORAGE BOX / NEXTCLOUD
// npm install webdav
const { createClient } = require("webdav");
const webdavClient = createClient("https://your-storage-box.your-host.com/webdav", {
    username: process.env.WEBDAV_USER,
    password: process.env.WEBDAV_PASSWORD
});
// (To use WebDAV, you would replace the uploadLargeFileStream function with:
// await webdavClient.putFileContents(remoteKey, fs.createReadStream(localPath));)

// OPTION D: GOOGLE CLOUD STORAGE
// npm install @google-cloud/storage
const { Storage } = require('@google-cloud/storage');
const gcs = new Storage({ keyFilename: 'gcs-credentials.json' });
// (To upload: await gcs.bucket(BUCKET_NAME).upload(localPath, { destination: remoteKey }));
*/

// =========================================================================
// 📥 PRIMARY INGESTION WORKER ROUTE
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName } = req.body;

    if (!folderPath || !folderName) {
        return res.status(400).json({ success: false, error: "Missing required folderPath or folderName contexts." });
    }

    try {
        const metaFilePath = path.join(folderPath, 'metadata.json');
        if (!fs.existsSync(metaFilePath)) {
            return res.json({ success: false, error: "Aborting sync: metadata.json tracking manifest missing." });
        }

        let metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));

        // Initialize storage schema structures dynamically if missing
        if (!metadata.storage) { 
            metadata.storage = { location: 'local', files: {} };
        }

        const resolutionProfiles = ['1080p', '720p', '480p'];
        let patchData = { storage: { ...metadata.storage } };
        let hasUploadedAny = false;

        for (const profile of resolutionProfiles) {
            const fileBlock = metadata.storage.files?.[profile];
            
            // Core processing gate: Only push files marked explicitly as 'pending'
            if (!fileBlock || fileBlock.status !== 'pending') continue;

            // Resolve file system location names cleanly
            let localVideoPath = fileBlock.localPath ? path.join(folderPath, fileBlock.localPath) : null;

            // Fallback strategy if localPath string reference was missed but physical asset is present
            if (!localVideoPath || !fs.existsSync(localVideoPath)) {
                const files = fs.readdirSync(folderPath);
                const targetSuffix = profile === '1080p' ? '.web.mp4' : `.${profile}.mp4`;
                const matchedFile = files.find(f => f.endsWith(targetSuffix));
                
                if (matchedFile) {
                    localVideoPath = path.join(folderPath, matchedFile);
                }
            }

            if (!localVideoPath || !fs.existsSync(localVideoPath)) {
                logger.log(`ℹ️ [Cloud Sync Skip] Profile ${profile} for ${folderName} is pending but file is physically absent. Skipping.`, 'warn');
                continue;
            }

            // Group media assets securely under their unique IMDB fingerprint to allow seamless re-indexing
            const directoryId = (metadata.imdbId && metadata.imdbId !== 'N/A') ? metadata.imdbId : folderName;
            const remoteKey = `movies/${directoryId}/${profile}.mp4`.replace(/\/+/g, '/');

            logger.log(`🚀 [Cloud Sync Engine] Stream-uploading [${profile}] to cloud block store: ${remoteKey}`);
            
            // Execute atomic streaming multipart push chunks
            await uploadLargeFileStream(localVideoPath, remoteKey, profile);

            // Update patch tracking object state markers
            patchData.storage.files[profile] = {
                status: "synced",
                localPath: path.basename(localVideoPath),
                remoteKey: remoteKey
            };
            hasUploadedAny = true;

            // OPTIONAL LOCAL STORAGE CLEANUP FOR CHEAP VPS PACKAGES:
            // Un-comment the line below if you want to delete the local file the instant it hits your cloud bucket!
            // fs.unlinkSync(localVideoPath); logger.log(`🗑️ Swept local storage cache for [${profile}] to maintain VPS disk space limits.`);
        }

        // Switch overall location descriptor state if any asset goes remote
        if (hasUploadedAny) {
            patchData.storage.location = 'remote';
        }

        return res.json({
            success: true,
            message: "Cloud synchronization cycles finalized seamlessly.",
            patchData: patchData
        });

    } catch (err) {
        logger.log(`❌ Cloud Sync Worker failure on target ${folderName}: ${err.message}`, 'error');
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
        queueSize: 4,               // Uploads up to 4 parts concurrently
        partSize: 1024 * 1024 * 5   // 5MB chunk allocations (Standard S3 floor limit)
    });

    uploadWorker.on('httpUploadProgress', (p) => {
        const mbSent = (p.loaded / (1024 * 1024)).toFixed(2);
        logger.log(`⏳ [Sync Chunk Tracking] [${profile}] Progressed: ${mbSent} MB`);
    });

    await uploadWorker.done();
}

const PORT = process.env.CLOUD_SYNC_WORKER_PORT || 5004;
app.listen(PORT, () => console.log(`☁️ Atomic Cloud Sync Engine online on port ${PORT}`));