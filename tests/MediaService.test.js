const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePlaybackUrlCandidate } = require('../src/services/MediaService');

test('prefers an explicit absolute playback URL from metadata', () => {
  const metadata = {
    siteUrl: 'https://peer.example',
    storage: {
      location: 'remote',
      files: {
        '1080p': {
          status: 'synced',
          remoteKey: 'movies/demo/1080p.mp4',
          absoluteUrl: 'https://cdn.example/demo/1080p.mp4'
        }
      }
    }
  };

  assert.equal(resolvePlaybackUrlCandidate(metadata, '1080p', '/local/1080p.mp4'), 'https://cdn.example/demo/1080p.mp4');
});

test('builds a site-based absolute URL when a file is still local to a site', () => {
  const metadata = {
    siteUrl: 'https://primary.example',
    storage: {
      location: 'remote',
      files: {
        '720p': {
          status: 'synced',
          localPath: '/movies/demo/720p.mp4'
        }
      }
    }
  };

  assert.equal(resolvePlaybackUrlCandidate(metadata, '720p', '/local/720p.mp4'), 'https://primary.example/movies/demo/720p.mp4');
});
