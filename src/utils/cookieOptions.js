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

function resolveCookieDomain() {
    const domain = String(process.env.COOKIE_DOMAIN || '').trim();
    return domain || undefined;
}

function getSessionCookieOptions() {
    const sameSite = resolveSameSite();
    const secureFromEnv = parseBool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production');
    const secure = sameSite === 'none' ? true : secureFromEnv;

    return {
        maxAge: 31536000000,
        path: '/',
        httpOnly: true,
        sameSite,
        secure,
        domain: resolveCookieDomain()
    };
}

function getClearCookieOptions() {
    const sameSite = resolveSameSite();
    const secureFromEnv = parseBool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production');
    const secure = sameSite === 'none' ? true : secureFromEnv;

    return {
        path: '/',
        sameSite,
        secure,
        domain: resolveCookieDomain()
    };
}

module.exports = {
    getSessionCookieOptions,
    getClearCookieOptions
};
