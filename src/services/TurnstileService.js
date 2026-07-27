const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function isEnabled() {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.TURNSTILE_ENABLED || '').trim().toLowerCase());
}

function getSiteKey() {
    return String(process.env.TURNSTILE_SITE_KEY || '').trim();
}

function getSecretKey() {
    return String(process.env.TURNSTILE_SECRET || '').trim();
}

function resolveClientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
    return String(req.socket?.remoteAddress || '').trim() || null;
}

async function verifyRequest(req, options = {}) {
    const enabled = isEnabled();
    if (!enabled) {
        return { success: true, skipped: true, reason: 'turnstile_disabled' };
    }

    const secret = getSecretKey();
    if (!secret) {
        return { success: false, code: 'missing_secret', publicMessage: 'Security verification is temporarily unavailable.' };
    }

    const token = String(options.token || '').trim();
    if (!token) {
        return { success: false, code: 'missing_token', publicMessage: 'Security verification failed. Please try again.' };
    }

    const body = new URLSearchParams();
    body.set('secret', secret);
    body.set('response', token);

    const ip = resolveClientIp(req);
    if (ip) {
        body.set('remoteip', ip);
    }

    try {
        const response = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        const payload = await response.json().catch(() => ({}));
        const success = Boolean(payload && payload.success);

        if (!success) {
            return {
                success: false,
                code: 'verification_failed',
                errors: Array.isArray(payload['error-codes']) ? payload['error-codes'] : [],
                publicMessage: 'Security verification failed. Please retry.'
            };
        }

        return { success: true, payload };
    } catch (_err) {
        return { success: false, code: 'verification_request_failed', publicMessage: 'Security verification could not be completed.' };
    }
}

module.exports = {
    isEnabled,
    getSiteKey,
    verifyRequest
};