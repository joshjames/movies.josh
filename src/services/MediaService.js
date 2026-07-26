// src/services/MediaService.js
// Cloud storage abstraction layer handling secure Backblaze B2 presigned URLs via native S3 bindings.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');

function normalizeAbsoluteUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        return parsed.toString();
    } catch (_err) {
        return null;
    }
}

function normalizeSiteRoot(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
        const parsed = new URL(raw);
        const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        return `${parsed.origin}${pathname === '/' ? '' : pathname}`;
    } catch (_err) {
        return null;
    }
}

function normalizePathForUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    return raw.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
}

function buildSiteAbsoluteUrl(siteUrl, localPath) {
    const siteRoot = normalizeSiteRoot(siteUrl);
    const normalizedPath = normalizePathForUrl(localPath);
    if (!siteRoot) return null;
    if (!normalizedPath) return siteRoot;
    return `${siteRoot}/${normalizedPath}`;
}

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

function resolvePlaybackUrlCandidate(metadata, resolutionProfile, localFallbackPath) {
    const storage = metadata?.storage;
    const fileMeta = storage?.files?.[resolutionProfile];

    const explicitAbsoluteUrl = normalizeAbsoluteUrl(
        fileMeta?.absoluteUrl || metadata?.absoluteUrl || metadata?.playbackUrl || metadata?.sourceUrl
    );
    if (explicitAbsoluteUrl) {
        return explicitAbsoluteUrl;
    }

    if (!storage || storage.location !== 'remote' || !fileMeta) {
        return localFallbackPath;
    }

    const fallbackAbsoluteUrl = buildSiteAbsoluteUrl(metadata?.siteUrl, fileMeta?.localPath || metadata?.localPath);
    if (fallbackAbsoluteUrl) {
        return fallbackAbsoluteUrl;
    }

    if (fileMeta.status !== 'synced' || !fileMeta.remoteKey) {
        return localFallbackPath;
    }

    return null;
}

const MediaService = {
    /**
     * Resolve a secure, executable playback URL contextually based on file locality states.
     * Handles local fallback cleanly if files aren't uploaded or if credentials fail.
     */
    async getPlaybackUrl(metadata, resolutionProfile, localFallbackPath) {
        const directCandidate = resolvePlaybackUrlCandidate(metadata, resolutionProfile, localFallbackPath);
        if (directCandidate && directCandidate !== localFallbackPath) {
            return directCandidate;
        }

        const storage = metadata?.storage;
        const fileMeta = storage?.files?.[resolutionProfile];

        if (!storage || storage.location !== 'remote' || !fileMeta) {
            return localFallbackPath;
        }

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

module.exports = {
    ...MediaService,
    resolvePlaybackUrlCandidate
};