(function () {
  'use strict';

  // Disabled: this used to silently redirect the whole page to a different
  // domain (window.location.replace) whenever any /api/* fetch threw a
  // TypeError. That included transient network blips, CORS hiccups, and ad
  // blockers - and it fired during login/register too, bouncing users to a
  // different origin mid-submit with no session and no explanation. That
  // was indistinguishable from "login just failed, no reason". Left as a
  // no-op (rather than removing the <script> tags from every page) so any
  // future failover work has a known place to live.
  return;

  if (window.__API_FAILOVER_INSTALLED__) return;
  window.__API_FAILOVER_INSTALLED__ = true;

  var now = Date.now();
  var lastAt = Number(sessionStorage.getItem('apiFailover.lastRedirectAt') || 0);
  var lastTarget = sessionStorage.getItem('apiFailover.lastRedirectTarget') || '';

  function parseOriginList(raw) {
    return String(raw || '')
      .split(',')
      .map(function (v) { return String(v || '').trim(); })
      .filter(Boolean)
      .filter(function (value, index, arr) { return arr.indexOf(value) === index; });
  }

  function normalizeOrigin(value) {
    try {
      var url = new URL(String(value || '').trim());
      return url.origin;
    } catch (_err) {
      return '';
    }
  }

  function configuredFallbackOrigins() {
    var windowConfigured = [];
    if (Array.isArray(window.__API_FAILOVER_ORIGINS)) {
      windowConfigured = window.__API_FAILOVER_ORIGINS.map(function (v) { return String(v || '').trim(); });
    } else if (typeof window.__API_FAILOVER_ORIGINS === 'string') {
      windowConfigured = parseOriginList(window.__API_FAILOVER_ORIGINS);
    }

    var local = parseOriginList(localStorage.getItem('apiFailover.origins'));
    var defaults = [
      'https://any.movie',
      'https://anyseries.online',
      'https://anymovie.us',
      'https://anymovie.au',
      'https://anymovie.eu'
    ];
    var merged = windowConfigured.concat(local).concat(defaults);
    var normalized = merged
      .map(normalizeOrigin)
      .filter(Boolean)
      .filter(function (value, index, arr) { return arr.indexOf(value) === index; });

    return normalized.filter(function (origin) {
      return origin !== window.location.origin;
    });
  }

  function isApiTarget(input) {
    try {
      if (typeof input === 'string') {
        if (input.indexOf('/api/') === 0) return true;
        var asUrl = new URL(input, window.location.origin);
        return asUrl.origin === window.location.origin && asUrl.pathname.indexOf('/api/') === 0;
      }

      if (input && typeof input.url === 'string') {
        var reqUrl = new URL(input.url, window.location.origin);
        return reqUrl.origin === window.location.origin && reqUrl.pathname.indexOf('/api/') === 0;
      }
    } catch (_err) {
      return false;
    }

    return false;
  }

  function shouldTriggerFailover(err, input) {
    if (!isApiTarget(input)) return false;

    var message = String((err && err.message) || '').toLowerCase();
    if (message.indexOf('failed to fetch') >= 0) return true;
    if (message.indexOf('name not resolved') >= 0) return true;
    if (message.indexOf('networkerror') >= 0) return true;

    return err instanceof TypeError;
  }

  function pickFailoverTarget() {
    var options = configuredFallbackOrigins();
    if (!options.length) return '';
    return options[0];
  }

  function redirectToFailover(origin) {
    if (!origin) return;

    var currentPath = window.location.pathname + window.location.search + window.location.hash;
    var target = origin + currentPath;

    // Avoid rapid redirect loops if fallback is also unhealthy.
    if (lastTarget === target && now - lastAt < 45000) return;

    try {
      sessionStorage.setItem('apiFailover.lastRedirectAt', String(Date.now()));
      sessionStorage.setItem('apiFailover.lastRedirectTarget', target);
    } catch (_err) {
      // ignore storage errors
    }

    window.location.replace(target);
  }

  var originalFetch = window.fetch.bind(window);

  window.fetch = function wrappedFetch(input, init) {
    return originalFetch(input, init).catch(function (err) {
      if (shouldTriggerFailover(err, input)) {
        var target = pickFailoverTarget();
        if (target) {
          redirectToFailover(target);
        }
      }
      throw err;
    });
  };
})();
