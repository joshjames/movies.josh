#!/usr/bin/env node
// scripts/cdn-build-images-manifest.js
// Turn a newline-delimited list of R2 object keys into the manifest that
// CdnAssetService reads to decide whether a given asset may be served from the edge.
//
// Invoked by scripts/cdn-sync-images.sh, but usable standalone:
//   rclone lsf -R --files-only :s3:imagesanymovie ... > /tmp/keys.txt
//   CDN_BASE=https://images.any.movie node scripts/cdn-build-images-manifest.js /tmp/keys.txt

const fs = require('fs');
const path = require('path');

const keyListPath = process.argv[2];
const cdnBase = String(process.env.CDN_BASE || 'https://images.any.movie').replace(/\/+$/, '');
const bucket = String(process.env.BUCKET || 'imagesanymovie');
const manifestPath = String(
    process.env.MANIFEST_PATH || '/home/epic/movie-streamer-data/cdn-images-manifest.json'
);

if (!keyListPath || !fs.existsSync(keyListPath)) {
    console.error(`❌ Key list not found: ${keyListPath}`);
    process.exit(1);
}

const keys = fs
    .readFileSync(keyListPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // Housekeeping objects are not servable assets.
    .filter((key) => !key.startsWith('_') && !key.startsWith('.'))
    .sort();

const byPrefix = {};
for (const key of keys) {
    const prefix = key.includes('/') ? key.slice(0, key.indexOf('/')) : '(root)';
    byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
}

const manifest = {
    schemaVersion: 1,
    bucket,
    baseUrl: cdnBase,
    generatedAt: new Date().toISOString(),
    totalKeys: keys.length,
    countsByPrefix: byPrefix,
    keys
};

fs.mkdirSync(path.dirname(manifestPath), { recursive: true });

// Write-then-rename so a reader never observes a half-written manifest.
const tmpPath = `${manifestPath}.tmp`;
fs.writeFileSync(tmpPath, JSON.stringify(manifest), 'utf-8');
fs.renameSync(tmpPath, manifestPath);

console.log(`   ${keys.length} keys -> ${manifestPath}`);
for (const [prefix, count] of Object.entries(byPrefix).sort()) {
    console.log(`     ${prefix.padEnd(20)} ${count}`);
}
