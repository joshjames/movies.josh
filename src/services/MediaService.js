// src/services/MediaService.js
// Cloud storage abstraction layer - presigns playback URLs against whichever
// provider a profile's storage.files[profile].provider says (R2 - the
// primary backend since 2026-10-12 - or absent/legacy B2), falling back to
// B2 and triggering a background lazy replication to R2 on a miss. See
// CloudStorageService.js and /home/epic/.claude/plans/peppy-dancing-yao.md.

const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');
const CloudStorageService = require('./CloudStorageService');
const { PROVIDER } = CloudStorageService;

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
    // onReplicated: optional async callback invoked only after a verified
    // successful lazy B2->R2 copy - lets the movie/episode call site (which
    // knows its own metadata.json/series.json patch shape) mark
    // provider:'r2' once it's actually true, without this module needing to
    // know either shape itself.
    async getPlaybackUrl(metadata, resolutionProfile, localFallbackPath, onReplicated) {
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

        const cleanKey = fileMeta.remoteKey.replace(/\/+/g, '/').replace(/^\//, '');
        const isR2Native = fileMeta.provider === PROVIDER.R2;

        if (isR2Native) {
            try {
                // Note: presigning is a local crypto operation - it can't
                // detect a genuinely-missing R2 object (that only surfaces to
                // the browser later, out of band). This catch only covers a
                // malformed key/client error, not real existence drift - an
                // intentional trade-off, since checking existence here would
                // mean a HEAD round trip on every single R2-native playback.
                return await CloudStorageService.getPresignedUrl(PROVIDER.R2, cleanKey);
            } catch (err) {
                logger.warn(`[CloudStorage] R2 presign failed for ${cleanKey}, falling back to B2: ${err.message}`);
            }
        }

        try {
            const presignedUrl = await CloudStorageService.getPresignedUrl(PROVIDER.B2, cleanKey);

            // Return the B2 URL immediately - never block the response on
            // replication - then fire the copy in the background.
            CloudStorageService.triggerLazyReplication(cleanKey, { onReplicated });

            return presignedUrl;
        } catch (err) {
            logger.error(`[CloudStorage] Presigned translation failed for ${fileMeta.remoteKey}: ${err.message}`);
            return localFallbackPath;
        }
    }
};

module.exports = {
    ...MediaService,
    resolvePlaybackUrlCandidate
};