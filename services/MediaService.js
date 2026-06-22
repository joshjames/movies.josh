const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const fs = require('fs').promises;

// Backblaze B2 requires the explicit S3 API endpoint matching your bucket's region
const B2_ENDPOINT = `https://s3.us-west-004.backblazeb2.com`; // 🧠 Check your exact B2 bucket console details for this URL!

const s3Client = new S3Client({
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.BBkeyID,
        secretAccessKey: process.env.BBapplicationKey
    },
    region: 'us-west-004' // Parsed from your endpoint sub-domain segment
});

const MediaService = {
    /**
     * Resolve a secure, executable playback URL contextually based on file locality states
     */
    async getPlaybackUrl(metadata, resolutionProfile, localFallbackPath) {
        const storage = metadata.storage;

        if (!storage || storage.location !== 'remote' || !storage.files || !storage.files[resolutionProfile]) {
            return localFallbackPath;
        }

        const fileMeta = storage.files[resolutionProfile];

        if (fileMeta.status !== 'synced' || !fileMeta.remoteKey) {
            return localFallbackPath;
        }

        try {
            // 🧹 SANITIZE THE KEY: Remove duplicate forward slashes completely
            let cleanKey = fileMeta.remoteKey.replace(/\/+/g, '/');
            
            // If it accidentally picked up a leading slash (e.g. "/movies/..."), strip it out
            if (cleanKey.startsWith('/')) {
                cleanKey = cleanKey.substring(1);
            }

            const command = new GetObjectCommand({
                Bucket: storage.bucket || 'joshflixmedia',
                Key: cleanKey // Using the completely clean key string
            });

            // Stream connections keep the URL alive for 7200 seconds (2 Hours)
            const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 7200 });
            return presignedUrl;
        } catch (err) {
            console.error(`[B2 ENGINE ERROR] Presigned translation failed for ${fileMeta.remoteKey}:`, err);
            return localFallbackPath; 
        }
    }
};

module.exports = MediaService;