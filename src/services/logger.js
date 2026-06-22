// src/services/logger.js
// Unified runtime event logger engine supporting tiered system event classifications.

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../../production.log');

const logger = {
    log(message, tier = 'info') {
        const timestamp = new Date().toISOString();
        const normalizedTier = tier.toUpperCase().padEnd(5);
        const formatPayload = `[${timestamp}] [${normalizedTier}]: ${message}\n`;

        // Output cleanly to standard console streams
        if (tier === 'error') {
            console.error(formatPayload.trim());
        } else if (tier === 'warn') {
            console.warn(formatPayload.trim());
        } else {
            console.log(formatPayload.trim());
        }

        // Persist directly onto systemic fallback logs
        try {
            fs.appendFileSync(LOG_FILE, formatPayload, 'utf-8');
        } catch (err) {
            console.error(`⚠️ Logger failed writing to logfile: ${err.message}`);
        }
    }
};

module.exports = logger;