// tests/cdnSync.test.js
// Guards the safety contract of the real-time CDN push accelerator: a push/delete must
// never throw or hit the network unless write credentials are fully configured, a
// successful transfer must be the only thing that mutates the manifest, and a failed
// transfer must leave the manifest untouched. The actual S3 client is stubbed at the
// module level so these run offline and deterministically.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Stub '@aws-sdk/client-s3' before CdnSyncService's lazy require ever resolves it. ---
// CdnSyncService only requires the SDK the first time a push/delete actually attempts a
// network call (isWriteEnabled() gates that), so injecting the fake into the module cache
// up front means every real credential path in this file talks to the fake, never AWS.
const clientS3Path = require.resolve('@aws-sdk/client-s3');
const sentCommands = [];
let nextSendShouldFail = false;

class FakePutObjectCommand {
    constructor(input) { this.input = input; this.commandName = 'PutObjectCommand'; }
}
class FakeDeleteObjectCommand {
    constructor(input) { this.input = input; this.commandName = 'DeleteObjectCommand'; }
}
class FakeS3Client {
    constructor(config) { this.config = config; }
    async send(command) {
        sentCommands.push(command);
        if (nextSendShouldFail) throw new Error('simulated R2 failure');
        return {};
    }
}

require.cache[clientS3Path] = {
    id: clientS3Path,
    filename: clientS3Path,
    loaded: true,
    exports: {
        S3Client: FakeS3Client,
        PutObjectCommand: FakePutObjectCommand,
        DeleteObjectCommand: FakeDeleteObjectCommand
    }
};

const CdnSyncService = require('../src/services/CdnSyncService');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-sync-test-'));
const MANIFEST_PATH = path.join(TMP_DIR, 'cdn-images-manifest.json');
const MOVIES_ROOT = path.join(TMP_DIR, 'movies');
const SERIES_ROOT = path.join(TMP_DIR, 'series');

fs.mkdirSync(path.join(MOVIES_ROOT, 'The.Incredible.Hulk.2008'), { recursive: true });
fs.writeFileSync(path.join(MOVIES_ROOT, 'The.Incredible.Hulk.2008', 'cover.jpg'), 'movie-cover-bytes');

fs.mkdirSync(path.join(SERIES_ROOT, 'Breaking.Bad'), { recursive: true });
fs.writeFileSync(path.join(SERIES_ROOT, 'Breaking.Bad', 'cover.jpg'), 'series-cover-bytes');

function readManifestKeys() {
    try {
        return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')).keys || [];
    } catch (_err) {
        return null; // manifest absent
    }
}

const WRITE_ENABLED = {
    CDN_IMAGES_WRITE_ENABLED: 'true',
    CDN_IMAGES_WRITE_ACCESS_KEY_ID: 'fake-key',
    CDN_IMAGES_WRITE_SECRET_ACCESS_KEY: 'fake-secret',
    ACCOUNT_ID: 'fake-account',
    R2_IMAGES_BUCKET: 'imagesanymovie',
    CDN_IMAGES_BASE_URL: 'https://images.any.movie',
    CDN_IMAGES_MANIFEST_PATH: MANIFEST_PATH,
    MOVIES_DIR: MOVIES_ROOT,
    SERIES_DIR: SERIES_ROOT
};

function withEnv(overrides, fn) {
    const saved = {};
    for (const [key, value] of Object.entries(overrides)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    return (async () => {
        try {
            return await fn();
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    })();
}

test.beforeEach(() => {
    sentCommands.length = 0;
    nextSendShouldFail = false;
    fs.rmSync(MANIFEST_PATH, { force: true });
});

test('isWriteEnabled is false with no credentials configured', () => {
    return withEnv({
        CDN_IMAGES_WRITE_ENABLED: undefined,
        CDN_IMAGES_WRITE_ACCESS_KEY_ID: undefined,
        CDN_IMAGES_WRITE_SECRET_ACCESS_KEY: undefined,
        ACCOUNT_ID: undefined
    }, () => {
        assert.equal(CdnSyncService.isWriteEnabled(), false);
    });
});

test('isWriteEnabled is false when the flag is set but credentials are missing', () => {
    return withEnv({
        CDN_IMAGES_WRITE_ENABLED: 'true',
        CDN_IMAGES_WRITE_ACCESS_KEY_ID: undefined,
        CDN_IMAGES_WRITE_SECRET_ACCESS_KEY: undefined,
        ACCOUNT_ID: undefined
    }, () => {
        assert.equal(CdnSyncService.isWriteEnabled(), false);
    });
});

test('isWriteEnabled is true only once the flag and all three credentials are present', () => {
    return withEnv(WRITE_ENABLED, () => {
        assert.equal(CdnSyncService.isWriteEnabled(), true);
    });
});

test('getStatus reports the configured bucket, base URL and manifest path', () => {
    return withEnv(WRITE_ENABLED, () => {
        const status = CdnSyncService.getStatus();
        assert.equal(status.writeEnabled, true);
        assert.equal(status.bucket, 'imagesanymovie');
        assert.equal(status.baseUrl, 'https://images.any.movie');
        assert.equal(status.manifestPath, MANIFEST_PATH);
    });
});

test('pushObject no-ops without touching the network or manifest when write is disabled', () => {
    return withEnv({ ...WRITE_ENABLED, CDN_IMAGES_WRITE_ENABLED: 'false' }, async () => {
        const localFile = path.join(MOVIES_ROOT, 'The.Incredible.Hulk.2008', 'cover.jpg');
        const result = await CdnSyncService.pushObject('movie-assets/x/cover.jpg', localFile);
        assert.equal(result, false);
        assert.equal(sentCommands.length, 0);
        assert.equal(readManifestKeys(), null);
    });
});

test('pushObject returns false for a local file that does not exist, without hitting the network', () => {
    return withEnv(WRITE_ENABLED, async () => {
        const result = await CdnSyncService.pushObject('movie-assets/ghost/cover.jpg', path.join(TMP_DIR, 'nope.jpg'));
        assert.equal(result, false);
        assert.equal(sentCommands.length, 0);
        assert.equal(readManifestKeys(), null);
    });
});

test('pushObject uploads and records the key in the manifest on success', () => {
    return withEnv(WRITE_ENABLED, async () => {
        const localFile = path.join(MOVIES_ROOT, 'The.Incredible.Hulk.2008', 'cover.jpg');
        const result = await CdnSyncService.pushObject('movie-assets/The.Incredible.Hulk.2008/cover.jpg', localFile);

        assert.equal(result, true);
        assert.equal(sentCommands.length, 1);
        assert.equal(sentCommands[0].commandName, 'PutObjectCommand');
        assert.equal(sentCommands[0].input.Bucket, 'imagesanymovie');
        assert.equal(sentCommands[0].input.Key, 'movie-assets/The.Incredible.Hulk.2008/cover.jpg');
        assert.equal(sentCommands[0].input.CacheControl, 'public, max-age=31536000, immutable');
        assert.deepEqual(readManifestKeys(), ['movie-assets/The.Incredible.Hulk.2008/cover.jpg']);
    });
});

test('pushObject leaves the manifest untouched when the transfer fails', () => {
    return withEnv(WRITE_ENABLED, async () => {
        nextSendShouldFail = true;
        const localFile = path.join(MOVIES_ROOT, 'The.Incredible.Hulk.2008', 'cover.jpg');
        const result = await CdnSyncService.pushObject('movie-assets/The.Incredible.Hulk.2008/cover.jpg', localFile);

        assert.equal(result, false);
        assert.equal(readManifestKeys(), null);
    });
});

test('pushObject de-duplicates a key that is already in the manifest', () => {
    return withEnv(WRITE_ENABLED, async () => {
        const localFile = path.join(MOVIES_ROOT, 'The.Incredible.Hulk.2008', 'cover.jpg');
        const key = 'movie-assets/The.Incredible.Hulk.2008/cover.jpg';
        await CdnSyncService.pushObject(key, localFile);
        await CdnSyncService.pushObject(key, localFile);

        assert.equal(sentCommands.length, 2); // both transfers still happen -- only the manifest is deduped
        assert.deepEqual(readManifestKeys(), [key]);
    });
});

test('deleteObject removes the key from the manifest on success', () => {
    return withEnv(WRITE_ENABLED, async () => {
        const localFile = path.join(MOVIES_ROOT, 'The.Incredible.Hulk.2008', 'cover.jpg');
        const key = 'movie-assets/The.Incredible.Hulk.2008/cover.jpg';
        await CdnSyncService.pushObject(key, localFile);

        const result = await CdnSyncService.deleteObject(key);
        assert.equal(result, true);
        assert.equal(sentCommands[1].commandName, 'DeleteObjectCommand');
        assert.equal(sentCommands[1].input.Key, key);
        assert.deepEqual(readManifestKeys(), []);
    });
});

test('deleteObject leaves the manifest untouched when the delete fails', () => {
    return withEnv(WRITE_ENABLED, async () => {
        const localFile = path.join(MOVIES_ROOT, 'The.Incredible.Hulk.2008', 'cover.jpg');
        const key = 'movie-assets/The.Incredible.Hulk.2008/cover.jpg';
        await CdnSyncService.pushObject(key, localFile);

        nextSendShouldFail = true;
        const result = await CdnSyncService.deleteObject(key);
        assert.equal(result, false);
        assert.deepEqual(readManifestKeys(), [key]);
    });
});

test('pushMovieCover resolves the folder under MOVIES_DIR and uses the movie-assets key', () => {
    return withEnv(WRITE_ENABLED, async () => {
        const result = await CdnSyncService.pushMovieCover('The.Incredible.Hulk.2008');
        assert.equal(result, true);
        assert.equal(sentCommands[0].input.Key, 'movie-assets/The.Incredible.Hulk.2008/cover.jpg');
    });
});

test('pushSeriesCover resolves the folder under SERIES_DIR and uses the movie-assets/series key', () => {
    return withEnv(WRITE_ENABLED, async () => {
        const result = await CdnSyncService.pushSeriesCover('Breaking.Bad');
        assert.equal(result, true);
        assert.equal(sentCommands[0].input.Key, 'movie-assets/series/Breaking.Bad/cover.jpg');
    });
});

test('pushCoverForContentType dispatches to the series path only for contentType "series"', () => {
    return withEnv(WRITE_ENABLED, async () => {
        await CdnSyncService.pushCoverForContentType('series', 'Breaking.Bad');
        assert.equal(sentCommands[0].input.Key, 'movie-assets/series/Breaking.Bad/cover.jpg');

        sentCommands.length = 0;
        await CdnSyncService.pushCoverForContentType('movies', 'The.Incredible.Hulk.2008');
        assert.equal(sentCommands[0].input.Key, 'movie-assets/The.Incredible.Hulk.2008/cover.jpg');
    });
});

test('deleteCoverForContentType dispatches to the matching series/movie key', () => {
    return withEnv(WRITE_ENABLED, async () => {
        await CdnSyncService.pushCoverForContentType('series', 'Breaking.Bad');
        sentCommands.length = 0;

        const result = await CdnSyncService.deleteCoverForContentType('series', 'Breaking.Bad');
        assert.equal(result, true);
        assert.equal(sentCommands[0].commandName, 'DeleteObjectCommand');
        assert.equal(sentCommands[0].input.Key, 'movie-assets/series/Breaking.Bad/cover.jpg');
    });
});

test('pushCatalogCover and pushTvCover use their flat key prefixes', () => {
    return withEnv(WRITE_ENABLED, async () => {
        const catalogFile = path.join(TMP_DIR, 'tt0111161.jpg');
        fs.writeFileSync(catalogFile, 'catalog-cover-bytes');

        await CdnSyncService.pushCatalogCover('tt0111161', catalogFile);
        assert.equal(sentCommands[0].input.Key, 'catalog-covers/tt0111161.jpg');

        sentCommands.length = 0;
        await CdnSyncService.pushTvCover('tt0903747', catalogFile);
        assert.equal(sentCommands[0].input.Key, 'tv-covers/tt0903747.jpg');
    });
});
