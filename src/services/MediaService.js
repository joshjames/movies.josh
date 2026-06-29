// src/services/MediaService.js
// Cloud storage abstraction layer handling secure Backblaze B2 presigned URLs via native S3 bindings.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');

// Backblaze B2 configuration context
const B2_ENDPOINT = `https://s3.us-west-004.backblazeb2.com`;

const s3Client = new S3Client({
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.BBkeyID,
        secretAccessKey: process.env.BBapplicationKey
    },
    region: 'us-west-004' 
});

const MediaService = {
    /**
     * Resolve a secure, executable playback URL contextually based on file locality states.
     * Handles local fallback cleanly if files aren't uploaded or if credentials fail.
     */
    async getPlaybackUrl(metadata, resolutionProfile, localFallbackPath) {
        const storage = metadata?.storage;

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
                Key: cleanKey
            });

            // Stream connections keep the URL alive for 7200 seconds (2 Hours)
            const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 7200 });
            return presignedUrl;
        } catch (err) {
            logger.error(`[B2 ENGINE ERROR] Presigned translation failed for ${fileMeta.remoteKey}: ${err.message}`);
            return localFallbackPath; 
        }
    }
};

module.exports = MediaService;