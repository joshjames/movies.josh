#!/usr/bin/env node

require('dotenv').config();

const { runLibraryScanSweep } = require('../src/services/LibraryScanner');
const { loadIndex } = require('../src/services/TvSeriesIndexService');

async function main() {
    const startedAt = Date.now();

    console.log('Starting one-off TV backfill scan...');
    const summary = await runLibraryScanSweep();

    const index = loadIndex();
    const items = Array.isArray(index?.items) ? index.items : [];
    const withImdb = items.filter((item) => Boolean(String(item.imdbId || '').trim()));
    const missingImdb = items.filter((item) => !String(item.imdbId || '').trim());

    console.log('');
    console.log('Backfill complete.');
    console.log(`Scanned shows: ${summary?.shows ?? 0}`);
    console.log(`TV index items: ${items.length}`);
    console.log(`With IMDb: ${withImdb.length}`);
    console.log(`Missing IMDb: ${missingImdb.length}`);

    if (missingImdb.length > 0) {
        console.log('');
        console.log('Missing IMDb folders:');
        missingImdb.slice(0, 50).forEach((item) => {
            console.log(`- ${item.folderName || item.title || item.id || 'unknown'}`);
        });
        if (missingImdb.length > 50) {
            console.log(`...and ${missingImdb.length - 50} more`);
        }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log(`Done in ${elapsed}s.`);
}

main().catch((err) => {
    console.error('Backfill failed:', err.message || err);
    process.exit(1);
});
