require('dotenv').config();
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage'); // 🧠 Optimized for large multi-part video streams
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;

// --- CONFIGURATION MANAGEMENT ---
const MOVIES_DIR = process.env.MOVIES_DIR || '/home/epic/movies'; 
const BUCKET_NAME = 'joshflixmedia';
const B2_ENDPOINT = 'https://s3.us-west-004.backblazeb2.com'; 

// TARGET TEST FOLDER: Slashes will be automatically stripped for the key path
const TEST_FOLDER_NAME = '/The.Avengers.2012/';

const cleanNamingId = TEST_FOLDER_NAME.replace(/^\/+|\/+$/g, '');

// Initialize our S3 Client connection using Master Keys
const s3Client = new S3Client({
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.BBkeyID,
        secretAccessKey: process.env.BBapplicationKey
    },
    region: 'us-west-004'
});

async function runManualOneOffTest() {
    // Keep local path resolution sane
    const localFolder = path.join(MOVIES_DIR, TEST_FOLDER_NAME);
    const metaFilePath = path.join(localFolder, 'metadata.json');

    console.log(`🚀 [TEST ENGINE] Initializing manual upload sequence for: ${cleanNamingId}`);

    // 1. Verify target paths are completely real
    if (!fs.existsSync(localFolder)) {
        console.error(`❌ Local directory does not exist at: ${localFolder}`);
        return;
    }

    // 2. Unpack metadata configuration or create a baseline structure if empty
    let metadata = { title: cleanNamingId.replace(/[-_.]/g, ' '), imdbId: 'unknown_id', contentType: 'movie' };
    if (fs.existsSync(metaFilePath)) {
        try {
            metadata = JSON.parse(await fsPromises.readFile(metaFilePath, 'utf-8'));
        } catch (e) {
            console.warn(`⚠️ metadata.json parsing failed, falling back to folder layouts.`);
        }
    }

    // Ensure we have a valid structural path key using the IMDB ID or folder fallback name
    const namingId = (metadata.imdbId && metadata.imdbId !== 'N/A') ? metadata.imdbId : cleanNamingId;

    // 3. Look for the local 1080p target video file
    const expectedVideoFile = `${cleanNamingId}.web.mp4`;
    let localVideoPath = path.join(localFolder, expectedVideoFile);

    // Fallback: search for standard .mp4 container files inside the directory if .web.mp4 is absent
    if (!fs.existsSync(localVideoPath)) {
        const files = await fsPromises.readdir(localFolder);
        const alternativeMp4 = files.find(f => f.endsWith('.mp4') && !f.includes('720p') && !f.includes('480p'));
        if (alternativeMp4) {
            localVideoPath = path.join(localFolder, alternativeMp4);
            console.log(`🔍 [TEST] Matched fallback video file target: ${alternativeMp4}`);
        } else {
            console.error(`❌ Could not locate a target movie file in folder.`);
            return;
        }
    }

    // Define the exact remote target file structure path mapping (No more double slashes!)
    //const remoteKey = `movies/${namingId}/1080p.mp4`;
    const rawRemoteKey = `movies/${namingId}/1080p.mp4`;
    const remoteKey = rawRemoteKey.replace(/\/+/g, '/'); // 🚀 Strips '//' down to '/' safely right before upload

    console.log(`📦 [TEST] Streaming target: ${path.basename(localVideoPath)}`);
    console.log(`☁️ [TEST] Upload destination path key: ${remoteKey}`);

    try {
        const fileStream = fs.createReadStream(localVideoPath);

        const uploadWorker = new Upload({
            client: s3Client,
            params: {
                Bucket: BUCKET_NAME,
                Key: remoteKey,
                Body: fileStream,
                ContentType: 'video/mp4'
            },
            queueSize: 4, // 4 concurrent chunks running simultaneously
            partSize: 1024 * 1024 * 5 // 5MB part thresholds
        });

        uploadWorker.on('httpUploadProgress', (progress) => {
            const uploadedMB = (progress.loaded / (1024 * 1024)).toFixed(2);
            const totalMB = progress.total ? (progress.total / (1024 * 1024)).toFixed(2) : 'Unknown';
            console.log(`⏳ [UPLOAD PROGRESS] Sent: ${uploadedMB} MB / ${totalMB} MB`);
        });

        await uploadWorker.done();
        console.log(`✨ [SUCCESS] File uploaded cleanly to your Backblaze B2 bucket.`);

        // 4. Update the storage configuration data matrix layout
        metadata.storage = {
            location: "remote",
            bucket: BUCKET_NAME,
            files: {
                "1080p": {
                    "status": "synced",
                    "remoteKey": remoteKey
                },
                "720p": metadata.storage?.files?.["720p"] || { "status": "pending", "remoteKey": null },
                "480p": metadata.storage?.files?.["480p"] || { "status": "pending", "remoteKey": null }
            }
        };

        // Write the modifications back to your local metadata.json
        await fsPromises.writeFile(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');
        console.log(`💾 [SUCCESS] Updated metadata.json configuration maps.`);
        console.log(`\n👉 TEST READY! Open player.html for this movie and verify the network tab loads from B2!`);

    } catch (err) {
        console.error(`❌ [CRITICAL TEST EXCEPTION]:`, err);
    }
}

// Fire execution routine
runManualOneOffTest();