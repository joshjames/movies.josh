// public/js/cdn-fallback.js
// Origin fallback for images served from the R2 image CDN (images.any.movie).
//
// If a CDN image fails to load — bucket gap, edge incident, DNS blocked by a client
// network — this rewrites the element to the equivalent origin URL and lets the request
// go to the app server instead. Only after the origin copy also fails does the page's
// own onerror handler run and show the no-cover placeholder.
//
// The listener is registered on window in the capture phase so it runs before the
// element's inline onerror. stopPropagation() during capture prevents the event from
// reaching that inline handler, so a retry is not clobbered by a placeholder swap.

(function () {
    'use strict';

    var CDN_HOSTS = ['images.any.movie'];
    var RETRY_FLAG = 'cdnOriginRetried';

    // Bucket key prefix -> function building the equivalent origin URL.
    // Order matters: 'movie-assets/series/' must be checked before 'movie-assets/',
    // since the former is also a prefix match of the latter.
    var ORIGIN_ROUTES = [
        {
            prefix: 'catalog-covers/',
            toOrigin: function (rest) { return '/images/catalog-covers/' + rest; }
        },
        {
            // tv-covers are not on the static /images mount; the API route serves them
            // from the metadata volume and back-fills from OMDb/TMDB on a miss.
            prefix: 'tv-covers/',
            toOrigin: function (rest) {
                var imdbId = rest.replace(/\.jpg$/i, '');
                return '/api/tv-shows/' + encodeURIComponent(imdbId) + '/cover';
            }
        },
        {
            prefix: 'movie-assets/series/',
            toOrigin: function (rest) { return '/movie-assets/series/' + rest; }
        },
        {
            prefix: 'movie-assets/',
            toOrigin: function (rest) { return '/movie-assets/' + rest; }
        }
    ];

    function toOriginUrl(rawSrc) {
        var url;
        try {
            url = new URL(rawSrc, window.location.href);
        } catch (_err) {
            return '';
        }

        if (CDN_HOSTS.indexOf(url.hostname) === -1) return '';

        var key = url.pathname.replace(/^\/+/, '');
        for (var i = 0; i < ORIGIN_ROUTES.length; i++) {
            var route = ORIGIN_ROUTES[i];
            if (key.indexOf(route.prefix) !== 0) continue;
            return route.toOrigin(key.slice(route.prefix.length)) + (url.search || '');
        }

        return '';
    }

    window.addEventListener('error', function (event) {
        var target = event.target;
        if (!target || target.tagName !== 'IMG') return;
        if (target.dataset && target.dataset[RETRY_FLAG] === '1') return;

        var originUrl = toOriginUrl(target.currentSrc || target.src || '');
        if (!originUrl) return;

        // Mark first so a failing origin copy falls through to the page's own handler.
        if (target.dataset) target.dataset[RETRY_FLAG] = '1';

        event.stopPropagation();
        event.preventDefault();

        target.src = originUrl;
    }, true);
}());
