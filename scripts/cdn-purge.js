#!/usr/bin/env node
// scripts/cdn-purge.js
// Purge cached objects from the Cloudflare edge for the image CDN.
//
// Normally you should NOT need this: covers are served with an immutable Cache-Control
// and every app-emitted URL carries a ?v=<mtime> token, so replacing an object and
// re-running the sync produces a new URL that misses cache naturally. Reach for purge
// when a bad object was cached under a URL that will not change, or when you replace a
// file without its mtime moving.
//
// Usage:
//   node scripts/cdn-purge.js --key catalog-covers/tt0111161.jpg
//   node scripts/cdn-purge.js --key tv-covers/tt0903747.jpg --key catalog-covers/tt1375666.jpg
//   node scripts/cdn-purge.js --prefix catalog-covers/      # purge-by-prefix (Enterprise only)
//   node scripts/cdn-purge.js --all                         # purge everything on the zone

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const REPO_ROOT = path.join(__dirname, '..');
const CRED_FILE = process.env.CDN_CRED_FILE || path.join(REPO_ROOT, 'cftoken.env');
const ZONE_NAME = process.env.CDN_IMAGES_ZONE || 'any.movie';
const CDN_BASE = String(process.env.CDN_IMAGES_BASE_URL || 'https://images.any.movie').replace(/\/+$/, '');
const API_BASE = 'https://api.cloudflare.com/client/v4';

// Cloudflare caps a single purge-by-url call at 30 entries.
const PURGE_BATCH_SIZE = 30;

function loadCreds() {
    if (!fs.existsSync(CRED_FILE)) {
        throw new Error(`Credential file not found: ${CRED_FILE}`);
    }
    const env = {};
    for (const line of fs.readFileSync(CRED_FILE, 'utf-8').split('\n')) {
        const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (match) env[match[1]] = match[2].trim();
    }
    const token = env.ACCOUNT_API_KEY || env.ACCOUNT_API_TOKEN || env.CF_API_TOKEN || env.AUTH_TOKEN;
    if (!token) throw new Error(`No Cloudflare API token found in ${CRED_FILE}`);
    return { token };
}

function parseArgs(argv) {
    const options = { keys: [], prefixes: [], all: false };
    for (let i = 0; i < argv.length; i += 1) {
        switch (argv[i]) {
            case '--key': options.keys.push(argv[++i]); break;
            case '--prefix': options.prefixes.push(argv[++i]); break;
            case '--all': options.all = true; break;
            case '-h':
            case '--help': options.help = true; break;
            default: throw new Error(`Unknown argument: ${argv[i]}`);
        }
    }
    return options;
}

async function cfRequest(token, method, urlPath, data) {
    const response = await axios({
        method,
        url: `${API_BASE}${urlPath}`,
        data,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 20000,
        validateStatus: () => true
    });

    if (!response.data || response.data.success !== true) {
        const details = response.data && response.data.errors
            ? JSON.stringify(response.data.errors)
            : `HTTP ${response.status}`;
        throw new Error(details);
    }

    return response.data.result;
}

async function resolveZoneId(token) {
    const zones = await cfRequest(token, 'GET', `/zones?name=${encodeURIComponent(ZONE_NAME)}&per_page=1`);
    const zone = Array.isArray(zones) ? zones[0] : null;
    if (!zone) throw new Error(`Zone not found or not accessible: ${ZONE_NAME}`);
    return zone.id;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help || (!options.keys.length && !options.prefixes.length && !options.all)) {
        console.log(fs.readFileSync(__filename, 'utf-8').split('\n').slice(1, 18).join('\n'));
        process.exit(options.help ? 0 : 2);
    }

    const { token } = loadCreds();
    const zoneId = await resolveZoneId(token);
    console.log(`🌐 Zone ${ZONE_NAME} (${zoneId})`);

    if (options.all) {
        console.log('⚠️  Purging EVERYTHING on this zone — this affects all hostnames, not just the CDN.');
        await cfRequest(token, 'POST', `/zones/${zoneId}/purge_cache`, { purge_everything: true });
        console.log('✅ Full zone purge submitted.');
        return;
    }

    if (options.prefixes.length) {
        const prefixes = options.prefixes.map((p) => `${CDN_BASE.replace(/^https?:\/\//, '')}/${p.replace(/^\/+/, '')}`);
        console.log(`🧹 Purging ${prefixes.length} prefix(es): ${prefixes.join(', ')}`);
        try {
            await cfRequest(token, 'POST', `/zones/${zoneId}/purge_cache`, { prefixes });
            console.log('✅ Prefix purge submitted.');
        } catch (err) {
            console.error(`❌ Prefix purge failed: ${err.message}`);
            console.error('   Purge-by-prefix requires an Enterprise plan. Use --key, or rely on');
            console.error('   the ?v= version token which makes replaced covers miss cache anyway.');
            process.exitCode = 1;
        }
    }

    if (options.keys.length) {
        const urls = options.keys.map((key) => `${CDN_BASE}/${String(key).replace(/^\/+/, '')}`);
        for (let i = 0; i < urls.length; i += PURGE_BATCH_SIZE) {
            const batch = urls.slice(i, i + PURGE_BATCH_SIZE);
            await cfRequest(token, 'POST', `/zones/${zoneId}/purge_cache`, { files: batch });
            console.log(`✅ Purged ${batch.length} url(s):`);
            for (const url of batch) console.log(`     ${url}`);
        }
    }
}

main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
});
