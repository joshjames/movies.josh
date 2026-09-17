// src/middleware/controlForward.js
// Cross-region acquisition forwarding: qBittorrent (and everything built on
// top of it - search, add, pause/resume/cancel) only ever runs on the
// primary region now. A satellite sets CONTROL_API_URL to the primary's
// WireGuard-bound control port (see docker-compose.yml's movie-streamer
// "ports" entry); this middleware, mounted first on a router, forwards the
// entire incoming request there verbatim and relays back whatever the
// primary responds with, so every handler further down the router never
// runs on a satellite at all. Left unset on the primary itself, where this
// is a no-op and every request is handled locally exactly as before.
'use strict';

const axios = require('axios');
const logger = require('../services/logger');

const CONTROL_API_URL = String(process.env.CONTROL_API_URL || '').trim().replace(/\/+$/, '');

function isRunningAsSatellite() {
    return Boolean(CONTROL_API_URL);
}

async function forwardToPrimaryIfSatellite(req, res, next) {
    if (!CONTROL_API_URL) return next();

    try {
        const response = await axios({
            method: req.method,
            url: `${CONTROL_API_URL}${req.originalUrl}`,
            data: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
            headers: {
                'Content-Type': 'application/json',
                Cookie: req.headers.cookie || ''
            },
            timeout: 30000,
            validateStatus: () => true
        });

        return res.status(response.status).json(response.data);
    } catch (err) {
        logger.error(`[ControlForward] Failed forwarding ${req.method} ${req.originalUrl} to primary: ${err.message}`);
        return res.status(502).json({
            success: false,
            error: 'Could not reach the primary region to process this request.',
            code: 'CONTROL_FORWARD_UNREACHABLE'
        });
    }
}

module.exports = { forwardToPrimaryIfSatellite, isRunningAsSatellite, CONTROL_API_URL };
