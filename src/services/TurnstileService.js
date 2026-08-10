const logger = require('./logger');

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

// Turnstile is meant to be a silent, best-effort bot deterrent for a small
// friends-and-family install (see TODO.md) — it must never be the reason a
// genuine person can't log in or sign up. So we only ever hard-block when
// Cloudflare actively looks at a submitted token and says it's invalid.
// Anything that means "we couldn't get a verdict at all" (no token because
// the widget was blocked/never loaded, our config is broken, or Cloudflare's
// endpoint is unreachable/slow) fails OPEN — logged for visibility, but the
// request proceeds.
function softFail(code, reason, extra = {}) {
    logger.warn(`[TURNSTILE] Soft-failing open (${code}): ${reason}`);
    return { success: true, softFailed: true, code, ...extra };
}

async function verifyRequest(req, options = {}) {
    const enabled = isEnabled();
    if (!enabled) {
        return { success: true, skipped: true, reason: 'turnstile_disabled' };
    }

    const secret = getSecretKey();
    if (!secret) {
        return softFail('missing_secret', 'TURNSTILE_SECRET is not configured.');
    }

    const token = String(options.token || '').trim();
    if (!token) {
        return softFail('missing_token', 'Request arrived without a verification token (widget likely blocked or not yet loaded).');
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
            const errors = Array.isArray(payload['error-codes']) ? payload['error-codes'] : [];
            return {
                success: false,
                code: 'verification_failed',
                errors,
                publicMessage: 'We couldn\'t confirm you\'re human. Please retry — if this keeps happening, refresh the page first.'
            };
        }

        return { success: true, payload };
    } catch (err) {
        return softFail('verification_request_failed', `Could not reach Cloudflare's verification endpoint: ${err.message}`);
    }
}

module.exports = {
    isEnabled,
    getSiteKey,
    verifyRequest
};