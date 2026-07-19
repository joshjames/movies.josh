const axios = require('axios');

async function injectCloudflareGeoRoute(newServerIp) {
    const CF_ZONE_ID = process.env.CF_ZONE_ID;
    const CF_API_TOKEN = process.env.CF_API_TOKEN;
    const CF_RECORD_NAME = process.env.CF_RECORD_NAME || 'anyseries.online';

    // Trigger Cloudflare Routing Pool updates or DNS record pools
    await axios.post(
        `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`,
        {
            type: "A",
            name: CF_RECORD_NAME,
            content: newServerIp,
            ttl: 1, // Automatic
            proxied: true // Route through Cloudflare's smart routing network
        },
        { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } }
    );
    console.log(`⚡ [Cloudflare Integration] Registered edge routing pool for IP: ${newServerIp}`);
}

module.exports = { injectCloudflareGeoRoute };