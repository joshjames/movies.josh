// public/js/region-badge.js
// Small corner badge showing which region/host/container is actually
// serving this page - useful for testing Cloudflare's Load Balancer routing
// (confirming Sydney vs LA actually answers as expected) and, once more
// satellites exist, for spotting a misbehaving node at a glance rather than
// digging through logs.
//
// Debug-only: off unless the page URL has ?locationbadge=true. It used to
// always render, fixed bottom-left - harmless on most pages, but on
// player.html at mobile widths it sits right on top of the play button.
// Append the query param to any URL to turn it on for a troubleshooting
// session; it's not meant to be on by default for real users.
(function () {
    'use strict';

    // Explicit colors for known regions read better than a hash-derived one;
    // anything new (a future satellite) still gets a consistent color
    // automatically instead of the badge silently doing nothing for it.
    var KNOWN_REGION_COLORS = {
        'la': '#2563eb',
        'sydney': '#ea580c'
    };

    function colorForRegion(name) {
        var key = String(name || '').trim().toLowerCase();
        if (KNOWN_REGION_COLORS[key]) return KNOWN_REGION_COLORS[key];
        if (!key) return '#6b7280';

        // Deterministic fallback so a new region name always gets the same
        // color across page loads without needing to hand-map it here.
        var hash = 0;
        for (var i = 0; i < key.length; i += 1) {
            hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
        }
        return 'hsl(' + (hash % 360) + ', 65%, 45%)';
    }

    function buildBadge(info) {
        var regionLabel = info.region || 'unknown';
        var color = colorForRegion(info.region);

        var badge = document.createElement('div');
        badge.setAttribute('title',
            'Region: ' + regionLabel +
            '\nHost: ' + (info.hostname || 'unknown') +
            '\nVersion: ' + (info.version || 'unknown') +
            '\nDeployed: ' + (info.deployedAt || 'unknown')
        );
        badge.textContent = regionLabel;

        var style = badge.style;
        style.position = 'fixed';
        style.bottom = '8px';
        style.left = '8px';
        style.zIndex = '2147483647';
        style.background = color;
        style.color = '#fff';
        style.font = '10px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        style.fontWeight = '600';
        style.letterSpacing = '0.02em';
        style.padding = '2px 7px';
        style.borderRadius = '999px';
        style.opacity = '0.45';
        style.cursor = 'default';
        style.userSelect = 'none';
        style.boxShadow = '0 1px 3px rgba(0,0,0,0.3)';
        style.transition = 'opacity 0.15s ease';
        style.pointerEvents = 'auto';

        badge.addEventListener('mouseenter', function () { style.opacity = '1'; });
        badge.addEventListener('mouseleave', function () { style.opacity = '0.45'; });

        return badge;
    }

    function isEnabled() {
        try {
            return new URLSearchParams(window.location.search).get('locationbadge') === 'true';
        } catch (_err) {
            return false;
        }
    }

    function init() {
        if (!isEnabled()) return;

        fetch('/api/runtime/version')
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (!data || !data.success) return;
                var badge = buildBadge(data);
                if (document.body) {
                    document.body.appendChild(badge);
                }
            })
            .catch(function () {
                // Best-effort only - never let this affect the real page.
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
