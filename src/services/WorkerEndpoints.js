function normalizeUrl(value, fallback) {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    return raw;
}

function buildDefaultWorkerEndpoints() {
    return {
        INGEST: normalizeUrl(process.env.WORKER_URL_INGEST, 'http://ingest-worker:5000/process'),
        METADATA: normalizeUrl(process.env.WORKER_URL_METADATA, 'http://metadata-worker:5001/process'),
        SUBTITLES: normalizeUrl(process.env.WORKER_URL_SUBTITLES, 'http://subtitle-worker:5002/process'),
        TRANSCODE: normalizeUrl(process.env.WORKER_URL_TRANSCODE, 'http://transcoder-worker:5003/process'),
        CLOUDSYNC: normalizeUrl(process.env.WORKER_URL_CLOUDSYNC || process.env.WORKER_URL_UPLOAD, 'http://cloudsync-worker:5004/process')
    };
}

function processToHealthUrl(processUrl) {
    const clean = String(processUrl || '').trim();
    if (!clean) return '';
    if (clean.endsWith('/process')) return `${clean.slice(0, -'/process'.length)}/health`;
    if (clean.endsWith('/process-low-res')) return `${clean.slice(0, -'/process-low-res'.length)}/health`;
    return `${clean.replace(/\/$/, '')}/health`;
}

module.exports = {
    buildDefaultWorkerEndpoints,
    processToHealthUrl
};
