// tests/cdnAsset.test.js
// Guards the safety contract of the image CDN rewrite: it must only ever redirect
// assets the sync job confirmed are in the bucket, and every failure mode must fall
// back to the origin path rather than emitting a URL that 404s.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CdnAssetService = require('../src/services/CdnAssetService');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-test-'));
const MANIFEST_PATH = path.join(TMP_DIR, 'cdn-images-manifest.json');

fs.writeFileSync(MANIFEST_PATH, JSON.stringify({
    schemaVersion: 1,
    bucket: 'imagesanymovie',
    baseUrl: 'https://images.any.movie',
    keys: ['catalog-covers/tt0111161.jpg', 'tv-covers/tt0903747.jpg']
}));

function withEnv(overrides, fn) {
    const saved = {};
    for (const [key, value] of Object.entries(overrides)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    CdnAssetService.resetCache();
    try {
        return fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        CdnAssetService.resetCache();
    }
}

const ENABLED = {
    CDN_IMAGES_ENABLED: 'true',
    CDN_IMAGES_BASE_URL: 'https://images.any.movie',
    CDN_IMAGES_MANIFEST_PATH: MANIFEST_PATH
};

test('rewrites a synced catalog cover to the CDN', () => {
    withEnv(ENABLED, () => {
        assert.strictEqual(
            CdnAssetService.toCdnUrl('/images/catalog-covers/tt0111161.jpg'),
            'https://images.any.movie/catalog-covers/tt0111161.jpg'
        );
    });
});

test('maps the TV cover API route onto the tv-covers object', () => {
    withEnv(ENABLED, () => {
        assert.strictEqual(
            CdnAssetService.toCdnUrl('/api/tv-shows/tt0903747/cover'),
            'https://images.any.movie/tv-covers/tt0903747.jpg'
        );
    });
});

test('keeps origin for an asset that is not in the manifest', () => {
    withEnv(ENABLED, () => {
        assert.strictEqual(CdnAssetService.toCdnUrl('/images/catalog-covers/tt9999999.jpg'), '');
        assert.strictEqual(CdnAssetService.toCdnUrl('/api/tv-shows/tt9999999/cover'), '');
    });
});

test('keeps origin for unmapped paths', () => {
    withEnv(ENABLED, () => {
        assert.strictEqual(CdnAssetService.toCdnUrl('/movie-assets/Akira (1988)/cover.jpg'), '');
        assert.strictEqual(CdnAssetService.toCdnUrl('/images/avatars/josh.png'), '');
        assert.strictEqual(CdnAssetService.toCdnUrl(''), '');
    });
});

test('refuses path traversal', () => {
    withEnv(ENABLED, () => {
        assert.strictEqual(CdnAssetService.toObjectKey('/images/catalog-covers/../../etc/passwd'), '');
        assert.strictEqual(CdnAssetService.toCdnUrl('/images/catalog-covers/../../etc/passwd'), '');
    });
});

test('ignores query and hash when resolving the object key', () => {
    withEnv(ENABLED, () => {
        assert.strictEqual(
            CdnAssetService.toCdnUrl('/images/catalog-covers/tt0111161.jpg?v=123#x'),
            'https://images.any.movie/catalog-covers/tt0111161.jpg'
        );
    });
});

test('kill switch returns everything to origin', () => {
    withEnv({ ...ENABLED, CDN_IMAGES_ENABLED: 'false' }, () => {
        assert.strictEqual(CdnAssetService.toCdnUrl('/images/catalog-covers/tt0111161.jpg'), '');
    });
});

test('missing manifest returns everything to origin', () => {
    withEnv({ ...ENABLED, CDN_IMAGES_MANIFEST_PATH: path.join(TMP_DIR, 'absent.json') }, () => {
        assert.strictEqual(CdnAssetService.toCdnUrl('/images/catalog-covers/tt0111161.jpg'), '');
    });
});

test('corrupt manifest returns everything to origin', () => {
    const badPath = path.join(TMP_DIR, 'bad.json');
    fs.writeFileSync(badPath, '{ not json');
    withEnv({ ...ENABLED, CDN_IMAGES_MANIFEST_PATH: badPath }, () => {
        assert.strictEqual(CdnAssetService.toCdnUrl('/images/catalog-covers/tt0111161.jpg'), '');
    });
});

test('missing base URL returns everything to origin', () => {
    withEnv({ ...ENABLED, CDN_IMAGES_BASE_URL: undefined }, () => {
        assert.strictEqual(CdnAssetService.toCdnUrl('/images/catalog-covers/tt0111161.jpg'), '');
    });
});

test('versionCoverUrl appends the version token to the CDN URL', () => {
    // CoverUrlService reads the local file for its mtime; use a real synced cover so
    // both the manifest hit and the version token are exercised together.
    const localCover = path.join(__dirname, '../public/images/catalog-covers/tt0111161.jpg');
    if (!fs.existsSync(localCover)) return; // catalog not populated in this checkout

    withEnv(ENABLED, () => {
        // Required because CoverUrlService caches the CdnAssetService binding at require time.
        const { versionCoverUrl } = require('../src/services/CoverUrlService');
        const url = versionCoverUrl('/images/catalog-covers/tt0111161.jpg');
        assert.match(url, /^https:\/\/images\.any\.movie\/catalog-covers\/tt0111161\.jpg\?v=/);
    });
});
