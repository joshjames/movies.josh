// src/services/ConnectorService.js (Shared across both systems)
const crypto = require('crypto');
const redisClient = require('../utils/redisClient'); // Assuming a Redis client is set up in utils

function generateSecureToken(payload, sharedSecret) {
    // Generate a short-lived timestamp baseline to prevent replay attacks
    const timestamp = Date.now();
    const message = JSON.stringify(payload) + timestamp;
    
    const hmac = crypto.createHmac('sha256', sharedSecret)
                       .update(message)
                       .digest('hex');
                       
    return { hmac, timestamp };
}

// Master Endpoint: Export data matrices
async function exportRedisKeys() {
    const keys = await redisClient.keys('*');
    const pipelineData = {};
    for (const key of keys) {
        pipelineData[key] = await redisClient.get(key);
    }
    return pipelineData;
}

function verifySecureToken(payload, incomingHmac, timestamp, sharedSecret) {
    // Drop execution window instantly if the link request is older than 5 minutes
    if (Date.now() - timestamp > 300000) return false; 
    
    const message = JSON.stringify(payload) + timestamp;
    const computedHmac = crypto.createHmac('sha256', sharedSecret)
                               .update(message)
                               .digest('hex');
                               
    return crypto.timingSafeEqual(Buffer.from(incomingHmac), Buffer.from(computedHmac));
}