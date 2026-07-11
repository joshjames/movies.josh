const path = require('path');
const { spawn } = require('child_process');

function isEnabled(name, fallback = true) {
    const raw = String(process.env[name] || '').trim().toLowerCase();
    if (!raw) return fallback;
    return raw !== 'false' && raw !== '0' && raw !== 'no';
}

const processTable = [
    { env: 'ENABLE_WEB_SERVER', name: 'web', script: 'server.js', enabledByDefault: true },
    { env: 'ENABLE_INGEST_WORKER', name: 'ingest-worker', script: 'src/services/workers/IngestSanitizerWorker.js', enabledByDefault: true },
    { env: 'ENABLE_METADATA_WORKER', name: 'metadata-worker', script: 'src/services/workers/MetadataWorker.js', enabledByDefault: true },
    { env: 'ENABLE_SUBTITLE_WORKER', name: 'subtitle-worker', script: 'src/services/workers/SubtitleWorker.js', enabledByDefault: true },
    { env: 'ENABLE_TRANSCODER_WORKER', name: 'transcoder-worker', script: 'src/services/workers/TranscoderWorker.js', enabledByDefault: true },
    { env: 'ENABLE_CLOUDSYNC_WORKER', name: 'cloudsync-worker', script: 'src/services/workers/CloudSyncWorker.js', enabledByDefault: true }
];

const selected = processTable.filter(entry => isEnabled(entry.env, entry.enabledByDefault));

if (selected.length === 0) {
    console.error('No runtime processes enabled. Set at least one ENABLE_* flag to true.');
    process.exit(1);
}

const running = new Map();
let shuttingDown = false;

function stopAll(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    for (const child of running.values()) {
        if (!child.killed) {
            child.kill('SIGTERM');
        }
    }

    setTimeout(() => process.exit(exitCode), 200);
}

function prefixPipe(stream, target) {
    stream.on('data', (chunk) => {
        const text = String(chunk);
        const lines = text.split(/\r?\n/);
        lines.forEach((line, index) => {
            if (!line && index === lines.length - 1) return;
            target.write(`[${target === process.stderr ? 'stderr' : 'stdout'}] ${line}\n`);
        });
    });
}

selected.forEach((entry) => {
    const scriptPath = path.join(process.cwd(), entry.script);
    const child = spawn(process.execPath, [scriptPath], {
        env: process.env,
        stdio: ['inherit', 'pipe', 'pipe']
    });

    running.set(entry.name, child);

    child.stdout.on('data', (chunk) => {
        process.stdout.write(`[${entry.name}] ${String(chunk)}`);
    });

    child.stderr.on('data', (chunk) => {
        process.stderr.write(`[${entry.name}] ${String(chunk)}`);
    });

    child.on('exit', (code, signal) => {
        running.delete(entry.name);
        if (shuttingDown) return;

        if (code === 0 || signal === 'SIGTERM') {
            if (running.size === 0) {
                process.exit(0);
            }
            return;
        }

        console.error(`[launcher] ${entry.name} exited unexpectedly with code=${code} signal=${signal || 'none'}`);
        stopAll(code || 1);
    });
});

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));