// public/js/sidebar.js
// Shared left-hand navigation drawer: hamburger button (mobile + desktop) and
// a hover-reveal edge tab (desktop). Self-contained - injects its own markup
// and styles, so any page just needs a single <script src="/js/sidebar.js">.
//
// Every real row link here (anything not a "coming soon" placeholder or a
// section toggle) is a pair: the label text is an anchor jump to that row on
// index.html, and a chevron next to it opens gridview.html for a full "show
// all" grid view of that row's items - the exact same gridview.html page
// used by index.html's own "View all" link at the end of a row (see
// getCollectionViewAllHref there), just linked to directly instead of via a
// rendered row. Rows built from PublicRowBuilderService.js's public rows
// route through gridview.html?rowId=<id> (reads /api/rows, see that file's
// own rowId handling); "My Library"/"My Shows" aren't public rows at all,
// so their chevrons go to the same plain local-library grid view
// getCollectionViewAllHref already uses for those.
(function () {
    'use strict';

    // Big, generally-applicable genres - not computed from the library, since
    // the point is a short, stable, recognizable list. Everything else is one
    // click away via "More genres" -> gridview.html's full genre dropdown.
    const FEATURED_GENRES = ['Action', 'Comedy', 'Drama', 'Horror', 'Animation', 'Sci-Fi'];

    function encodeQ(value) {
        return encodeURIComponent(String(value || '').trim());
    }

    function genreHref(genre) {
        const q = encodeQ(genre);
        return `/gridview.html?title=${q}&genre=${q}&sort=title`;
    }

    // A PublicRowBuilderService row's "show all" - reads /api/rows,
    // filtered to this rowId (see gridview.html's fetchRowItems()).
    function rowGridHref(rowId, label) {
        return `/gridview.html?rowId=${encodeQ(rowId)}&title=${encodeQ(label)}`;
    }

    // Mirrors PublicRowBuilderService.js's getRowDisplayOrder() grouping -
    // keep these in sync if a row id/label changes there.
    const STREAMING_CONTENT_ROWS = [
        { anchorId: 'popular-streaming-movies', label: 'Popular Streaming Movies' },
        { anchorId: 'netflix-movies', label: 'Top Movies on Netflix' },
        { anchorId: 'netflix-tv', label: 'Top TV Shows on Netflix' },
        { anchorId: 'prime-movies', label: 'Top Movies on Prime Video' },
        { anchorId: 'prime-tv', label: 'Top TV Shows on Prime Video' },
        { anchorId: 'disney-movies', label: 'Top Movies on Disney+' },
        { anchorId: 'disney-tv', label: 'Top TV Shows on Disney+' },
        { anchorId: 'appletv-movies', label: 'Top Movies on Apple TV+' },
        { anchorId: 'appletv-tv', label: 'Top TV Shows on Apple TV+' },
        { anchorId: 'hbomax-movies', label: 'Top Movies on HBO Max' },
        { anchorId: 'hbomax-tv', label: 'Top TV Shows on HBO Max' }
    ].map((row) => ({ ...row, gridHref: rowGridHref(row.anchorId, row.label) }));

    // Not under a section toggle - sits between Streaming Content and
    // Movie Categories as its own small standalone block. Airing Today is
    // a placeholder (the TV calendar/air-date view discussed but not built
    // yet) - "coming soon" like New Episodes below.
    const TV_DISCOVERY_ROWS = [
        { anchorId: 'popular-tv', label: 'Popular TV', gridHref: rowGridHref('popular-tv', 'Popular TV') }
    ];

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            #app-sidebar-hamburger-btn {
                position: fixed; top: 14px; left: 14px; z-index: 2001;
                width: 40px; height: 40px; border-radius: 8px;
                background: rgba(15, 23, 42, 0.85); border: 1px solid #334155;
                color: #e2e8f0; font-size: 20px; line-height: 1; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
            }
            #app-sidebar-hamburger-btn:hover { background: rgba(30, 41, 59, 0.95); }

            #app-sidebar-edge-tab {
                position: fixed; top: 50%; left: 0; transform: translateY(-50%);
                width: 14px; height: 64px; z-index: 2000; cursor: pointer;
                background: rgba(15, 23, 42, 0.7); border: 1px solid #334155; border-left: none;
                border-radius: 0 8px 8px 0; display: flex; align-items: center; justify-content: center;
                transition: width 0.15s ease, background 0.15s ease;
            }
            #app-sidebar-edge-tab:hover { width: 22px; background: rgba(30, 41, 59, 0.95); }
            #app-sidebar-edge-tab svg { width: 9px; height: 13px; }
            #app-sidebar-edge-tab path { fill: #94a3b8; }

            #app-sidebar-overlay {
                position: fixed; inset: 0; z-index: 2002;
                background: rgba(0, 0, 0, 0.55); opacity: 0; pointer-events: none;
                transition: opacity 0.2s ease;
            }
            #app-sidebar-overlay.open { opacity: 1; pointer-events: auto; }

            #app-sidebar-panel {
                position: fixed; top: 0; left: 0; bottom: 0; z-index: 2003;
                width: 25%; min-width: 260px; max-width: 380px;
                background: #0f172a; border-right: 1px solid #334155;
                transform: translateX(-100%); transition: transform 0.25s ease;
                display: flex; flex-direction: column; padding: 18px 0 24px;
                overflow-y: auto; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
            }
            #app-sidebar-panel.open { transform: translateX(0); }
            @media (max-width: 640px) {
                #app-sidebar-panel { width: 82%; max-width: none; }
            }

            .app-sidebar-close-btn {
                align-self: flex-end; margin: 0 16px 8px; background: none; border: none;
                color: #94a3b8; font-size: 24px; line-height: 1; cursor: pointer; padding: 4px 8px;
            }
            .app-sidebar-close-btn:hover { color: #e2e8f0; }

            .app-sidebar-link, .app-sidebar-toggle, .app-sidebar-placeholder {
                display: block; width: 100%; text-align: left; box-sizing: border-box;
                padding: 12px 24px; color: #e2e8f0; text-decoration: none;
                font-size: 0.95rem; font-weight: 500; background: none; border: none; cursor: pointer;
            }
            .app-sidebar-link:hover, .app-sidebar-toggle:hover { background: rgba(255, 255, 255, 0.06); }

            .app-sidebar-indent { padding-left: 40px; font-size: 0.88rem; font-weight: 400; color: #cbd5e1; }
            .app-sidebar-placeholder { color: #64748b; cursor: default; }
            .app-sidebar-placeholder:hover { background: rgba(255, 255, 255, 0.03); }

            .app-sidebar-add-row {
                padding-left: 40px; font-size: 0.85rem; color: #38bdf8;
            }
            .app-sidebar-add-row:hover { text-decoration: underline; background: none; }

            .app-sidebar-divider { height: 1px; background: #1e293b; margin: 10px 0; }

            .app-sidebar-caret { float: right; transition: transform 0.2s ease; color: #64748b; }
            .app-sidebar-caret.open { transform: rotate(90deg); }

            .app-sidebar-genres { max-height: 0; overflow: hidden; transition: max-height 0.25s ease; }
            .app-sidebar-genres.open { max-height: 520px; }

            /* Row link with a "show all" chevron alongside the jump-to-row
               text link - two separate clickable targets in one row. */
            .app-sidebar-row-link {
                display: flex; align-items: stretch;
            }
            .app-sidebar-row-link .app-sidebar-link {
                flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .app-sidebar-chevron {
                flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
                width: 36px; color: #64748b; text-decoration: none; font-size: 1.1rem;
                cursor: pointer;
            }
            .app-sidebar-chevron:hover { color: #e2e8f0; background: rgba(255, 255, 255, 0.06); }
        `;
        document.head.appendChild(style);
    }

    // indent=false renders a top-level row link (Recently Added, My
    // Library) instead of the indented style used inside a section.
    function buildRowLinkHtml(row, { indent = true } = {}) {
        const anchorHref = `/index.html#${encodeQ(row.anchorId)}`;
        const linkClass = indent ? 'app-sidebar-link app-sidebar-indent' : 'app-sidebar-link';
        const chevronHtml = row.gridHref
            ? `<a class="app-sidebar-chevron" href="${row.gridHref}" title="Show all" aria-label="Show all: ${row.label}">&rsaquo;</a>`
            : '';
        return `
            <div class="app-sidebar-row-link">
                <a class="${linkClass}" href="${anchorHref}">${row.label}</a>
                ${chevronHtml}
            </div>
        `;
    }

    function buildMarkup() {
        const root = document.createElement('div');
        root.innerHTML = `
            <button type="button" id="app-sidebar-hamburger-btn" aria-label="Open menu">&#9776;</button>
            <div id="app-sidebar-edge-tab" aria-label="Open menu" title="Menu">
                <svg viewBox="0 0 9 13" xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L9 6.5 L0 13 Z"/></svg>
            </div>
            <div id="app-sidebar-overlay"></div>
            <nav id="app-sidebar-panel" aria-hidden="true">
                <button type="button" class="app-sidebar-close-btn" aria-label="Close menu">&times;</button>

                ${buildRowLinkHtml({ anchorId: 'recently-added', label: 'Recently Added', gridHref: rowGridHref('recently-added', 'Recently Added') }, { indent: false })}
                ${buildRowLinkHtml({ anchorId: 'continue-watching-row', label: 'Continue Watching' }, { indent: false })}
                ${buildRowLinkHtml({ anchorId: 'my-library-row', label: 'My Library', gridHref: `/gridview.html?title=${encodeQ('My Library')}&sort=recent` }, { indent: false })}
                <div class="app-sidebar-divider"></div>

                <button type="button" class="app-sidebar-add-row" data-coming-soon="Custom rows">+ New Row</button>
                ${buildRowLinkHtml({ anchorId: 'my-shows-row', label: 'My Shows', gridHref: `/gridview.html?title=${encodeQ('TV Shows')}&type=series&sort=title` })}
                <button type="button" class="app-sidebar-placeholder app-sidebar-indent" data-coming-soon="Unwatched episodes view">New Episodes</button>
                <div class="app-sidebar-divider"></div>

                <button type="button" class="app-sidebar-toggle" data-toggle-target="app-sidebar-streaming-rows">
                    Streaming Content <span class="app-sidebar-caret">&#9656;</span>
                </button>
                <div class="app-sidebar-genres" id="app-sidebar-streaming-rows">
                    ${STREAMING_CONTENT_ROWS.map((row) => buildRowLinkHtml(row)).join('')}
                </div>
                <div class="app-sidebar-divider"></div>

                ${TV_DISCOVERY_ROWS.map((row) => buildRowLinkHtml(row)).join('')}
                <button type="button" class="app-sidebar-placeholder app-sidebar-indent" data-coming-soon="TV airing calendar">Airing Today</button>
                <div class="app-sidebar-divider"></div>

                <button type="button" class="app-sidebar-toggle" data-toggle-target="app-sidebar-genres">
                    Movie Categories <span class="app-sidebar-caret">&#9656;</span>
                </button>
                <div class="app-sidebar-genres" id="app-sidebar-genres"></div>
            </nav>
        `;
        return root;
    }

    function buildGenreLinks(container) {
        const links = FEATURED_GENRES
            .map((genre) => `<a class="app-sidebar-link app-sidebar-indent" href="${genreHref(genre)}">${genre}</a>`)
            .join('');
        container.innerHTML = `${links}<a class="app-sidebar-link app-sidebar-indent" href="/gridview.html">More genres &rsaquo;</a>`;
    }

    function showComingSoonToast(label) {
        if (typeof window.showToast === 'function') {
            window.showToast(`${label} is coming soon.`, 'info', 2600);
            return;
        }
        // Fallback for pages without the shared toast helper.
        const el = document.createElement('div');
        el.textContent = `${label} is coming soon.`;
        el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1e293b;color:#e2e8f0;padding:10px 18px;border-radius:8px;z-index:2100;font-size:0.85rem;border:1px solid #334155;';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2600);
    }

    function init() {
        if (document.getElementById('app-sidebar-panel')) return; // already injected

        injectStyles();
        document.body.appendChild(buildMarkup());

        const panel = document.getElementById('app-sidebar-panel');
        const overlay = document.getElementById('app-sidebar-overlay');
        const hamburger = document.getElementById('app-sidebar-hamburger-btn');
        const edgeTab = document.getElementById('app-sidebar-edge-tab');
        const closeBtn = panel.querySelector('.app-sidebar-close-btn');

        buildGenreLinks(document.getElementById('app-sidebar-genres'));

        function openSidebar() {
            panel.classList.add('open');
            overlay.classList.add('open');
            panel.setAttribute('aria-hidden', 'false');
        }
        function closeSidebar() {
            panel.classList.remove('open');
            overlay.classList.remove('open');
            panel.setAttribute('aria-hidden', 'true');
        }

        hamburger.addEventListener('click', openSidebar);
        edgeTab.addEventListener('click', openSidebar);
        overlay.addEventListener('click', closeSidebar);
        closeBtn.addEventListener('click', closeSidebar);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeSidebar();
        });

        // Every collapsible section (Streaming Content / Movie Categories)
        // shares the same open/close toggle behavior, keyed off
        // data-toggle-target rather than one hardcoded element per section.
        panel.querySelectorAll('.app-sidebar-toggle[data-toggle-target]').forEach((toggleBtn) => {
            const targetId = toggleBtn.getAttribute('data-toggle-target');
            const target = document.getElementById(targetId);
            const caret = toggleBtn.querySelector('.app-sidebar-caret');
            if (!target) return;
            toggleBtn.addEventListener('click', () => {
                target.classList.toggle('open');
                if (caret) caret.classList.toggle('open');
            });
        });

        panel.addEventListener('click', (e) => {
            const comingSoon = e.target.closest('[data-coming-soon]');
            if (comingSoon) {
                showComingSoonToast(comingSoon.getAttribute('data-coming-soon'));
                return;
            }
            if (e.target.closest('a.app-sidebar-link, a.app-sidebar-chevron')) closeSidebar();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
