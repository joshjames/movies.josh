function parseBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(value).trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function resolveSameSite() {
    const candidate = String(process.env.COOKIE_SAMESITE || 'lax').trim().toLowerCase();
    if (candidate === 'none' || candidate === 'strict' || candidate === 'lax') return candidate;
    return 'lax';
}

function normalizeDomain(value) {
    return String(value || '').trim().toLowerCase().replace(/^\.+/, '');
}

function getRequestHost(req) {
    return normalizeDomain(req?.hostname || String(req?.headers?.host || '').split(':')[0] || '');
}

function resolveCookieDomain(req) {
    const host = getRequestHost(req);
    const configuredDomains = String(process.env.COOKIE_DOMAIN || '')
        .split(',')
        .map(normalizeDomain)
        .filter(Boolean);

    if (!configuredDomains.length) return undefined;
    if (!host) return undefined;

    const matched = configuredDomains.find((domain) => host === domain || host.endsWith(`.${domain}`));
    return matched || undefined;
}

function getSessionCookieOptions(req) {
    const sameSite = resolveSameSite();
    const secureFromEnv = parseBool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production');
    const secure = sameSite === 'none' ? true : secureFromEnv;

    return {
        maxAge: 31536000000,
        path: '/',
        httpOnly: true,
        sameSite,
        secure,
        domain: resolveCookieDomain(req)
    };
}

function getClearCookieOptions(req) {
    const sameSite = resolveSameSite();
    const secureFromEnv = parseBool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production');
    const secure = sameSite === 'none' ? true : secureFromEnv;

    return {
        path: '/',
        sameSite,
        secure,
        domain: resolveCookieDomain(req)
    };
}

module.exports = {
    getSessionCookieOptions,
    getClearCookieOptions
};
