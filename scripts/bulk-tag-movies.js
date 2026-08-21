#!/usr/bin/env node

// Prepend a genre/category value (e.g. "Anime") to a batch of movies' genre
// field, so HomeFeedService.js's existing genre-row logic picks them up as
// their own dedicated home-page row - no new row-building code needed, since
// "genre" already doubles as this app's category system (see the admin UI's
// "Genres / Categories" field).
//
// Reads folder names one-per-line from a list file. Movies with no
// metadata.json yet are skipped (logged), since there's nothing to tag.
//
// Must run inside a container (e.g. `docker exec movie-streamer-cloudsync-worker
// node scripts/bulk-tag-movies.js ...`), not on the bare host - same reason as
// the other backfill scripts (container-native paths, root-owned metadata.json,
// MetadataRegistry needs the container's redis connection).
//
// Usage (from inside a container):
//   node scripts/bulk-tag-movies.js --list /tmp/folders.txt --tag Anime --dry-run
//   node scripts/bulk-tag-movies.js --list /tmp/folders.txt --tag Anime

'use strict';

const fs = require('fs');
const path = require('path');
const MetadataRegistry = require('../src/services/MetadataRegistry');

const MOVIES_ROOT = process.env.MOVIES_DIR || process.env.BACKFILL_MOVIES_DIR || '/app/storage/movies';

function parseArgs(argv) {
    const flags = {};
    for (let i = 2; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) { flags[key] = 'true'; continue; }
        flags[key] = next;
        i += 1;
    }
    return flags;
}

function parseBool(value, fallback = false) {
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

async function main() {
    const flags = parseArgs(process.argv);
    const listPath = flags.list;
    const tag = String(flags.tag || '').trim();
    const dryRun = parseBool(flags['dry-run'], false);

    if (!listPath || !tag) {
        console.error('[bulk-tag] Usage: node scripts/bulk-tag-movies.js --list <file> --tag <GenreName> [--dry-run]');
        process.exitCode = 1;
        return;
    }

    const folders = fs.readFileSync(listPath, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    console.log(`[bulk-tag] ${folders.length} folder(s) to tag with "${tag}"`);

    let tagged = 0;
    let alreadyTagged = 0;
    let skippedNoMeta = 0;
    let failed = 0;

    for (const folderName of folders) {
        const folderPath = path.join(MOVIES_ROOT, folderName);
        const metaPath = path.join(folderPath, 'metadata.json');

        if (!fs.existsSync(metaPath)) {
            console.warn(`[bulk-tag] SKIP (no metadata.json): ${folderName}`);
            skippedNoMeta += 1;
            continue;
        }

        try {
            let didTag = false;
            let wasAlreadyTagged = false;

            if (dryRun) {
                const current = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                const existingGenres = String(current.genre || '').split(',').map((g) => g.trim()).filter(Boolean);
                wasAlreadyTagged = existingGenres.some((g) => g.toLowerCase() === tag.toLowerCase());
            } else {
                await MetadataRegistry.mergeAndCommit(metaPath, folderName, async (current) => {
                    const existingGenres = String(current.genre || '').split(',').map((g) => g.trim()).filter(Boolean);
                    if (existingGenres.some((g) => g.toLowerCase() === tag.toLowerCase())) {
                        wasAlreadyTagged = true;
                        return current;
                    }
                    didTag = true;
                    return {
                        ...current,
                        genre: [tag, ...existingGenres].join(', ')
                    };
                });
            }

            if (wasAlreadyTagged) {
                alreadyTagged += 1;
            } else {
                tagged += 1;
                if (dryRun) console.log(`[bulk-tag] Would tag: ${folderName}`);
            }
        } catch (err) {
            console.warn(`[bulk-tag] FAILED ${folderName}: ${err.message}`);
            failed += 1;
        }
    }

    console.log(`[bulk-tag] Done. Tagged=${tagged} AlreadyTagged=${alreadyTagged} SkippedNoMeta=${skippedNoMeta} Failed=${failed} Total=${folders.length}`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[bulk-tag] Fatal error:', err.message || err);
        process.exit(1);
    });
