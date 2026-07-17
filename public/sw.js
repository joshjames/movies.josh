const CACHE_VERSION = 'anymovie-static-v5';
const CACHE_NAME = CACHE_VERSION;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/browse.html',
  '/series.html',
  '/player.html',
  '/images/avatar.png',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => Promise.resolve())
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function shouldCacheResponse(request, response) {
  if (!response || response.status !== 200 || response.redirected) {
    return false;
  }

  const contentType = response.headers.get('content-type') || '';
  if (request.destination === 'image') {
    return contentType.startsWith('image/');
  }

  if (request.destination === 'script') {
    return contentType.includes('javascript') || contentType.includes('ecmascript') || contentType.includes('text/plain');
  }

  if (request.destination === 'style') {
    return contentType.includes('text/css');
  }

  if (request.destination === 'font') {
    return contentType.startsWith('font/') || contentType.includes('application/font') || contentType.includes('application/octet-stream');
  }

  return true;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const requestUrl = new URL(request.url);
  if (!isSameOrigin(requestUrl)) return;

  if (requestUrl.pathname.startsWith('/api/')) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (shouldCacheResponse(request, response)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  const cacheableDestinations = new Set(['script', 'style', 'image', 'font']);
  if (!cacheableDestinations.has(request.destination)) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          if (shouldCacheResponse(request, response)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
