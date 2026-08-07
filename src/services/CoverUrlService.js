const fs = require('fs');
const path = require('path');
const { toCdnUrl } = require('./CdnAssetService');

const MOVIES_DIR = () => String(process.env.MOVIES_DIR || global.MOVIES_DIR || '').trim();
const SERIES_DIR = () => String(process.env.SERIES_DIR || global.SERIES_DIR || '').trim();
const CATALOG_COVER_DIR = path.join(__dirname, '../../public/images/catalog-covers');
const TV_COVER_DIR = path.join(__dirname, '../../metadata/tv-covers');

function cleanPublicUrl(publicUrl = '') {
    return String(publicUrl || '').trim().split('?')[0].split('#')[0];
}

function getVersionToken(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return '';
        const stats = fs.statSync(filePath);
        return String(stats.mtimeMs || stats.ctimeMs || Date.now());
    } catch (_err) {
        return '';
    }
}

function resolvePublicAssetPath(publicUrl = '') {
    const cleanUrl = cleanPublicUrl(publicUrl);
    if (!cleanUrl) return null;

    if (cleanUrl.startsWith('/movie-assets/series/')) {
        const folder = decodeURIComponent(cleanUrl.slice('/movie-assets/series/'.length).replace(/\/cover\.jpg$/i, ''));
        const baseDir = SERIES_DIR();
        if (!baseDir || !folder) return null;
        return path.join(baseDir, folder, 'cover.jpg');
    }

    if (cleanUrl.startsWith('/movie-assets/')) {
        const folder = decodeURIComponent(cleanUrl.slice('/movie-assets/'.length).replace(/\/cover\.jpg$/i, ''));
        const baseDir = MOVIES_DIR();
        if (!baseDir || !folder) return null;
        return path.join(baseDir, folder, 'cover.jpg');
    }

    if (cleanUrl.startsWith('/images/catalog-covers/')) {
        const fileName = decodeURIComponent(cleanUrl.slice('/images/catalog-covers/'.length));
        return path.join(CATALOG_COVER_DIR, fileName);
    }

    if (cleanUrl.startsWith('/images/tv-covers/')) {
        const fileName = decodeURIComponent(cleanUrl.slice('/images/tv-covers/'.length));
        return path.join(TV_COVER_DIR, fileName);
    }

    // The TV cover API route caches into TV_COVER_DIR, so it versions off the same file.
    const tvApiMatch = cleanUrl.match(/^\/api\/tv-shows\/(tt\d+)\/cover$/i);
    if (tvApiMatch) {
        return path.join(TV_COVER_DIR, `${tvApiMatch[1].toLowerCase()}.jpg`);
    }

    return null;
}

function versionCoverUrl(publicUrl = '') {
    const cleanUrl = cleanPublicUrl(publicUrl);
    if (!cleanUrl) return '';

    const filePath = resolvePublicAssetPath(cleanUrl);
    const version = getVersionToken(filePath);

    // Prefer the CDN when the sync job has confirmed this object is in the bucket.
    // toCdnUrl returns '' for anything unmapped, unsynced, or when the CDN is off,
    // in which case we fall through to the origin path unchanged.
    const cdnUrl = toCdnUrl(cleanUrl);
    const targetUrl = cdnUrl || cleanUrl;

    if (!version) return targetUrl;

    const separator = targetUrl.includes('?') ? '&' : '?';
    return `${targetUrl}${separator}v=${encodeURIComponent(version)}`;
}

/**
 * Canonical TV show cover URL. Resolves to the CDN object when it has been synced,
 * otherwise to the on-demand /api/tv-shows/:imdbId/cover route which fetches and caches.
 */
function tvCoverUrl(imdbId = '') {
    const raw = String(imdbId || '').trim();
    if (!raw) return '';
    return versionCoverUrl(`/api/tv-shows/${encodeURIComponent(raw)}/cover`);
}

module.exports = {
    versionCoverUrl,
    tvCoverUrl
};