function normalizeUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        return parsed.toString().replace(/\/$/, '');
    } catch (_err) {
        return '';
    }
}

function getPrimaryAppUrl() {
    return normalizeUrl(
        process.env.APP_URL ||
        process.env.APP_URL_PRIMARY ||
        'https://anyseries.online'
    ) || 'https://anyseries.online';
}

function getLegacyAppUrl() {
    return normalizeUrl(process.env.APP_URL_LEGACY || process.env.LEGACY_APP_URL || '');
}

function getAllowedAppUrls() {
    const urls = [
        getPrimaryAppUrl(),
        getLegacyAppUrl()
    ].filter(Boolean);

    const extras = String(process.env.APP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((item) => normalizeUrl(item))
        .filter(Boolean);

    return Array.from(new Set([...urls, ...extras]));
}

function buildAbsoluteAppUrl(pathname = '/') {
    const base = getPrimaryAppUrl();
    const cleanPath = `/${String(pathname || '/').replace(/^\/+/, '')}`;
    return `${base}${cleanPath === '/' ? '' : cleanPath}`;
}

module.exports = {
    normalizeUrl,
    getPrimaryAppUrl,
    getLegacyAppUrl,
    getAllowedAppUrls,
    buildAbsoluteAppUrl
};
