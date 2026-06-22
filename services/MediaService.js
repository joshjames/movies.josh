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

        // 🛡️ Rule A: If no remote orchestration record exists, serve the local mount point instantly
        if (!storage || storage.location !== 'remote' || !storage.files || !storage.files[resolutionProfile]) {
            return localFallbackPath;
        }

        const fileMeta = storage.files[resolutionProfile];

        // 🛡️ Rule B: Record exists but data upload migration hasn't cleared successfully yet
        if (fileMeta.status !== 'synced' || !fileMeta.remoteKey) {
            return localFallbackPath;
        }

        // 🚀 Rule C: Asset is fully remote. Generate a 2-hour secure presigned play link
        try {
            const command = new GetObjectCommand({
                Bucket: process.env.joshflixmedia || 'joshflixmedia',
                Key: fileMeta.remoteKey
            });

            // Stream connections can keep the URL alive for 7200 seconds (2 Hours)
            const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 7200 });
            return presignedUrl;
        } catch (err) {
            console.error(`[B2 ENGINE ERROR] Presigned translation failed for ${fileMeta.remoteKey}:`, err);
            return localFallbackPath; // Fallback to safe local file gracefully if API drops
        }
    }
};

module.exports = MediaService;