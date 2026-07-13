const fs = require('fs');
const path = require('path');

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

    return null;
}

function versionCoverUrl(publicUrl = '') {
    const cleanUrl = cleanPublicUrl(publicUrl);
    if (!cleanUrl) return '';

    const filePath = resolvePublicAssetPath(cleanUrl);
    const version = getVersionToken(filePath);
    if (!version) return cleanUrl;

    const separator = cleanUrl.includes('?') ? '&' : '?';
    return `${cleanUrl}${separator}v=${encodeURIComponent(version)}`;
}

module.exports = {
    versionCoverUrl
};