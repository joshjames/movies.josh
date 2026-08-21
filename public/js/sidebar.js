// public/js/sidebar.js
// Shared left-hand navigation drawer: hamburger button (mobile + desktop) and
// a hover-reveal edge tab (desktop). Self-contained - injects its own markup
// and styles, so any page just needs a single <script src="/js/sidebar.js">.
//
// "My Library" / "My Shows" link straight to their existing rows on the
// homepage (index.html already renders them via /api/home-feed's
// per-user myLibraryCollection/myShowsCollection - see media.routes.js -
// with stable ids `my-library-row` / `my-shows-row` on the slider div), so
// this is just an anchor link, no new backend/page needed.
//
// "New Episodes" and "+ New Row" are placeholders for features not built yet
// (a dedicated unwatched-episodes view, and user-created CDN-backed
// collections per docs/flat-cdn-json-architecture-plan.md) - they show a
// "coming soon" toast rather than linking anywhere.
(function () {
    'use strict';

    // Big, generally-applicable genres - not computed from the library, since
    // the point is a short, stable, recognizable list. Everything else is one
    // click away via "More genres" -> gridview.html's full genre dropdown.
    const FEATURED_GENRES = ['Action', 'Comedy', 'Drama', 'Horror', 'Animation', 'Sci-Fi'];

    function genreHref(genre) {
        const q = encodeURIComponent(genre);
        return `/gridview.html?title=${q}&genre=${q}&sort=title`;
    }

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
            .app-sidebar-genres.open { max-height: 320px; }
        `;
        document.head.appendChild(style);
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
                <a class="app-sidebar-link" href="/index.html#my-library-row">My Library</a>
                <a class="app-sidebar-link app-sidebar-indent" href="/index.html#my-shows-row">My Shows</a>
                <button type="button" class="app-sidebar-add-row" data-coming-soon="Custom rows">+ New Row</button>
                <button type="button" class="app-sidebar-placeholder app-sidebar-indent" data-coming-soon="New episodes">New Episodes</button>
                <div class="app-sidebar-divider"></div>
                <button type="button" class="app-sidebar-toggle" id="app-sidebar-categories-toggle">
                    Categories <span class="app-sidebar-caret">&#9656;</span>
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
        const categoriesToggle = document.getElementById('app-sidebar-categories-toggle');
        const genresContainer = document.getElementById('app-sidebar-genres');
        const caret = categoriesToggle.querySelector('.app-sidebar-caret');

        buildGenreLinks(genresContainer);

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

        categoriesToggle.addEventListener('click', () => {
            genresContainer.classList.toggle('open');
            caret.classList.toggle('open');
        });

        panel.addEventListener('click', (e) => {
            const target = e.target.closest('[data-coming-soon]');
            if (target) {
                showComingSoonToast(target.getAttribute('data-coming-soon'));
                return;
            }
            if (e.target.closest('a.app-sidebar-link')) closeSidebar();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
