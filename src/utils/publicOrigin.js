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

const DEFAULT_APP_URLS = [
    'https://any.movie',
    'https://anymovie.online',
    'https://anyseries.online'
];

function parseUrlList(...values) {
    const items = values
        .flatMap((value) => String(value || '').split(','))
        .map((item) => normalizeUrl(item))
        .filter(Boolean);

    return Array.from(new Set(items));
}

function getPrimaryAppUrl() {
    return normalizeUrl(
        process.env.APP_URL ||
        process.env.APP_URL_PRIMARY ||
        DEFAULT_APP_URLS[0]
    ) || DEFAULT_APP_URLS[0];
}

function getLegacyAppUrl() {
    const aliases = getLegacyAppUrls();
    return aliases[0] || '';
}

function getLegacyAppUrls() {
    return parseUrlList(
        process.env.APP_URL_LEGACY,
        process.env.LEGACY_APP_URL,
        process.env.APP_URL_ALIASES
    );
}

function getAllowedAppUrls() {
    const urls = parseUrlList(
        getPrimaryAppUrl(),
        ...getLegacyAppUrls(),
        ...DEFAULT_APP_URLS,
        process.env.APP_ALLOWED_ORIGINS
    );

    return urls;
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
    getLegacyAppUrls,
    getAllowedAppUrls,
    buildAbsoluteAppUrl
};
