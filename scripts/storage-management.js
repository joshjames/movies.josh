#!/usr/bin/env node

// Reports disk space on every volume this app touches, plus the size of
// regenerable cache/staging directories, and can clear those caches on
// request. Runs inside the app container, so it can only see what's bind-
// mounted into it (see docker-compose.yml's x-app-common.volumes) - it has
// no access to the Docker daemon itself (no docker.sock mounted), so it
// cannot report or prune Docker images/build cache. That would need a
// separate, deliberate decision to mount the socket into the container.
//
// Usage:
//   node scripts/storage-management.js                  Report only.
//   node scripts/storage-management.js --clear-audio-cache [--dry-run]
//   node scripts/storage-management.js --clear-script-logs [--days N] [--dry-run]

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MOUNTS = [
    { label: 'Movies library', path: '/app/storage/movies' },
    { label: 'Series library', path: '/app/storage/series' },
    { label: 'App metadata (movie-streamer-data)', path: '/app/metadata' },
    { label: 'Audio remux cache', path: '/app/cache/audio' },
    { label: 'Archive / to-be-deleted', path: '/app/archive' }
];

const ROOT = path.join(__dirname, '..');
const SCRIPT_LOG_DIR = path.join(ROOT, 'logs', 'script-runs');

function parseArgs(argv) {
    const args = { dryRun: false, clearAudioCache: false, clearScriptLogs: false, days: 14 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dry-run') args.dryRun = true;
        else if (argv[i] === '--clear-audio-cache') args.clearAudioCache = true;
        else if (argv[i] === '--clear-script-logs') args.clearScriptLogs = true;
        else if (argv[i] === '--days') args.days = parseInt(argv[++i], 10) || 14;
    }
    return args;
}

function dirSize(dirPath) {
    let total = 0;
    let fileCount = 0;
    if (!fs.existsSync(dirPath)) return { total: 0, fileCount: 0 };
    const stack = [dirPath];
    while (stack.length) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_err) {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else {
                try {
                    total += fs.statSync(full).size;
                    fileCount += 1;
                } catch (_err) { /* file vanished mid-walk, ignore */ }
            }
        }
    }
    return { total, fileCount };
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = -1;
    do {
        value /= 1024;
        unitIndex += 1;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function printDiskUsage() {
    console.log('=== Disk space (host filesystems visible to this container) ===');
    const existing = MOUNTS.filter((m) => fs.existsSync(m.path));
    if (!existing.length) {
        console.log('  No known mount points found.');
        return;
    }
    try {
        const out = execSync(`df -h ${existing.map((m) => `"${m.path}"`).join(' ')}`, { encoding: 'utf-8' });
        const lines = out.trim().split('\n');
        const header = lines[0];
        console.log(`  ${header}`);
        // df collapses to one line per distinct filesystem, but keeps mount order -
        // print each with its friendly label so it's clear what's what.
        for (let i = 1; i < lines.length; i++) {
            const mount = existing[i - 1];
            console.log(`  ${lines[i]}   <- ${mount.label}`);
        }
    } catch (err) {
        console.log(`  df failed: ${err.message}`);
    }
}

function printCacheAndStagingSizes() {
    console.log('\n=== Regenerable / disposable directories ===');
    const audio = dirSize('/app/cache/audio');
    console.log(`  Audio remux cache (/app/cache/audio): ${formatBytes(audio.total)} across ${audio.fileCount} file(s) - safe to clear, rebuilt on demand when a user picks a non-default audio track.`);

    const archive = dirSize('/app/archive');
    console.log(`  Archive / to-be-deleted (/app/archive): ${formatBytes(archive.total)} across ${archive.fileCount} file(s) - review before deleting, this is a staging area not an automatic cache.`);

    if (fs.existsSync(SCRIPT_LOG_DIR)) {
        const logs = dirSize(SCRIPT_LOG_DIR);
        console.log(`  Script-run logs (${SCRIPT_LOG_DIR}): ${formatBytes(logs.total)} across ${logs.fileCount} file(s) - output history from the admin Run Script tool, safe to prune old ones.`);
    }
}

function printDockerNote() {
    console.log('\n=== Docker image / build-cache usage ===');
    console.log('  Not visible from inside this container (no /var/run/docker.sock mounted).');
    console.log('  To check or reclaim Docker disk usage, run directly on the host:');
    console.log('    docker system df           # see the breakdown');
    console.log('    docker system prune -f     # remove stopped containers, dangling images, unused build cache (safe)');
    console.log('    docker system prune -a -f  # also remove any image not used by a running container (frees more, but drops old deploy-tag images you might want for a quick rollback)');
}

function clearAudioCache(dryRun) {
    console.log(`\n=== ${dryRun ? '[dry-run] ' : ''}Clearing audio remux cache ===`);
    const dirPath = '/app/cache/audio';
    if (!fs.existsSync(dirPath)) {
        console.log('  Nothing to clear - directory does not exist.');
        return;
    }
    const before = dirSize(dirPath);
    const entries = fs.readdirSync(dirPath);
    let removed = 0;
    for (const entry of entries) {
        const full = path.join(dirPath, entry);
        if (dryRun) {
            console.log(`  Would remove: ${full}`);
        } else {
            fs.rmSync(full, { recursive: true, force: true });
        }
        removed += 1;
    }
    console.log(`  ${dryRun ? 'Would free' : 'Freed'} ${formatBytes(before.total)} (${removed} entr${removed === 1 ? 'y' : 'ies'}).`);
}

function clearScriptLogs(days, dryRun) {
    console.log(`\n=== ${dryRun ? '[dry-run] ' : ''}Clearing script-run logs older than ${days} day(s) ===`);
    if (!fs.existsSync(SCRIPT_LOG_DIR)) {
        console.log('  Nothing to clear - directory does not exist.');
        return;
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(SCRIPT_LOG_DIR);
    let removed = 0;
    let freed = 0;
    for (const entry of entries) {
        const full = path.join(SCRIPT_LOG_DIR, entry);
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
            freed += stat.size;
            if (dryRun) {
                console.log(`  Would remove: ${entry} (${formatBytes(stat.size)})`);
            } else {
                fs.rmSync(full, { force: true });
            }
            removed += 1;
        }
    }
    console.log(`  ${dryRun ? 'Would free' : 'Freed'} ${formatBytes(freed)} across ${removed} log file(s).`);
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    printDiskUsage();
    printCacheAndStagingSizes();
    printDockerNote();

    if (args.clearAudioCache) clearAudioCache(args.dryRun);
    if (args.clearScriptLogs) clearScriptLogs(args.days, args.dryRun);
}

main();
