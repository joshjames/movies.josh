// public/js/acquisition-widget.js
// Reusable "my acquisitions" widget - one script include, works the same
// way on every page. Polls /api/acquisition-status/mine (the standalone
// status interface - see AcquisitionStatusService.js) and renders:
//
//   - On the home page (which already has the full avatar/account menu,
//     #avatar-btn/#avatar-menu): overlays a progress ring onto the existing
//     avatar image, and injects the acquisition item list as a new section
//     at the TOP of the existing dropdown - reuses what's already there
//     instead of duplicating a second menu next to it.
//   - On every other page (no avatar menu present at all today): creates
//     its own small floating pie button, fixed top-right, hidden entirely
//     unless something's actually in flight, opening its own minimal
//     dropdown with just the acquisition list - no account/logout noise.
//
// Self-contained on purpose (own CSS injected here, own toast stack) so a
// single <script> tag is the whole integration - no page needs its own
// separate stylesheet link or to already have a showToast() of its own.
(function () {
    'use strict';

    const POLL_INTERVAL_MS = 8000;
    const STAGE_ORDER = ['searching', 'acquiring', 'processing'];
    const STAGE_LABELS = {
        searching: 'Searching',
        acquiring: 'Acquiring',
        processing: 'Processing',
        done: 'Ready to watch',
        error: 'Error - tap to retry',
        manual: 'Sent for manual acquisition'
    };

    let items = [];
    let lastKnownStage = new Map(); // jobId -> uiStage, for change-triggered toasts only
    let pollTimer = null;
    let homeMode = false;

    function injectStyles() {
        if (document.getElementById('acq-widget-styles')) return;
        const style = document.createElement('style');
        style.id = 'acq-widget-styles';
        style.textContent = `
            .acq-float-btn {
                position: fixed; top: 16px; right: 16px; width: 48px; height: 48px;
                border-radius: 50%; border: 2px solid #1e293b; background: #0f172a;
                cursor: pointer; z-index: 9000; display: none; align-items: center;
                justify-content: center; padding: 3px; box-shadow: 0 4px 10px rgba(0,0,0,0.4);
            }
            .acq-float-btn.show { display: flex; }
            .acq-pie {
                width: 100%; height: 100%; border-radius: 50%;
                background: conic-gradient(#3b82f6 var(--acq-pct, 0%), #1e293b 0);
                display: flex; align-items: center; justify-content: center;
            }
            .acq-pie.acq-error { background: conic-gradient(#ef4444 100%, #1e293b 0); }
            .acq-pie.acq-manual { background: conic-gradient(#f59e0b 100%, #1e293b 0); }
            .acq-pie::after { content: ''; width: 68%; height: 68%; border-radius: 50%; background: #0f172a; }
            .acq-avatar-overlay {
                /* .avatar-btn has overflow:hidden (it clips the avatar image
                   to a circle) - inset:0 keeps this within those bounds
                   instead of being clipped itself. */
                position: absolute; inset: 0; border-radius: 50%; pointer-events: none;
                background: conic-gradient(rgba(59,130,246,0.85) var(--acq-pct, 0%), transparent 0);
            }
            .acq-avatar-overlay.acq-error { background: conic-gradient(rgba(239,68,68,0.85) 100%, transparent 0); }
            .acq-avatar-overlay.acq-manual { background: conic-gradient(rgba(245,158,11,0.85) 100%, transparent 0); }
            .acq-dropdown {
                position: fixed; top: 70px; right: 16px; width: min(340px, calc(100vw - 32px));
                max-height: 60vh; overflow-y: auto; background: #0f172a; border: 1px solid #334155;
                border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); padding: 12px;
                z-index: 9001; display: none;
            }
            .acq-dropdown.show { display: block; }
            .acq-section-title {
                font-size: 0.72rem; font-weight: 700; color: #93c5fd; text-transform: uppercase;
                letter-spacing: 0.04em; margin-bottom: 8px;
            }
            .acq-item {
                position: relative; background: #1e293b; border: 1px solid #334155; border-radius: 8px;
                padding: 10px 28px 10px 10px; margin-bottom: 8px; font-size: 0.82rem; color: #e2e8f0;
            }
            .acq-item:last-child { margin-bottom: 0; }
            .acq-item-title { font-weight: 700; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .acq-item-stage { font-size: 0.72rem; color: #94a3b8; margin-bottom: 6px; }
            .acq-item-bar-track { height: 6px; border-radius: 3px; background: #0f172a; overflow: hidden; }
            .acq-item-bar-fill { height: 100%; background: #3b82f6; transition: width 0.3s ease; }
            .acq-item.acq-error .acq-item-bar-fill { background: #ef4444; }
            .acq-item.acq-manual .acq-item-bar-fill { background: #f59e0b; }
            .acq-item-close {
                position: absolute; top: 6px; right: 6px; width: 18px; height: 18px; border-radius: 50%;
                border: none; background: #334155; color: #cbd5e1; font-size: 11px; line-height: 1;
                cursor: pointer; display: flex; align-items: center; justify-content: center;
            }
            .acq-item-close:hover { background: #475569; }
            .acq-empty { color: #64748b; font-size: 0.78rem; text-align: center; padding: 6px 0; }
            .acq-menu-section { border-bottom: 1px solid #1e293b; padding-bottom: 10px; margin-bottom: 10px; }
            .acq-toast-stack {
                position: fixed; top: 70px; right: 16px; z-index: 9500;
                display: flex; flex-direction: column; gap: 8px; pointer-events: none;
            }
            .acq-toast {
                background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px;
                font-size: 0.82rem; color: #e2e8f0; box-shadow: 0 6px 16px rgba(0,0,0,0.4); max-width: 300px;
            }
            .acq-toast.success { border-color: #16a34a; }
            .acq-toast.error { border-color: #dc2626; }
            @media (max-width: 480px) {
                .acq-dropdown { right: 8px; width: calc(100vw - 16px); top: 64px; }
                .acq-float-btn { top: 10px; right: 10px; }
                .acq-toast-stack { right: 8px; top: 60px; }
            }
        `;
        document.head.appendChild(style);
    }

    function stagePercent(entry) {
        if (entry.uiStage === 'done' || entry.uiStage === 'manual') return 100;
        if (entry.uiStage === 'error') return 100;
        const idx = STAGE_ORDER.indexOf(entry.uiStage);
        if (idx === -1) return 0;
        // Each stage fills its own band (1/3, 2/3, 3/3 for a 3-stage run)
        // rather than jumping only at transitions, so the pie/bar still
        // looks alive while sitting inside one stage for a while.
        return Math.round(((idx + 1) / STAGE_ORDER.length) * 100);
    }

    function stageClass(entry) {
        if (entry.uiStage === 'error') return 'acq-error';
        if (entry.uiStage === 'manual') return 'acq-manual';
        return '';
    }

    function showAcqToast(message, level) {
        let stack = document.getElementById('acq-toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'acq-toast-stack';
            stack.className = 'acq-toast-stack';
            document.body.appendChild(stack);
        }
        const toast = document.createElement('div');
        toast.className = `acq-toast ${level || 'info'}`;
        toast.textContent = message;
        stack.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    async function dismissItem(jobId) {
        try {
            await fetch(`/api/acquisition-status/${encodeURIComponent(jobId)}/dismiss`, {
                method: 'POST',
                credentials: 'same-origin'
            });
        } catch (_err) {
            // Best-effort - it'll just reappear on next poll if this failed,
            // not worth surfacing a toast over.
        }
        items = items.filter((item) => item.jobId !== jobId);
        renderAll();
    }

    function renderItemsInto(container) {
        if (!items.length) {
            container.innerHTML = '<div class="acq-empty">Nothing in progress right now.</div>';
            return;
        }

        container.innerHTML = items.map((entry) => {
            const pct = stagePercent(entry);
            const cls = stageClass(entry);
            const label = STAGE_LABELS[entry.uiStage] || entry.uiStage;
            return `
                <div class="acq-item ${cls}">
                    <button type="button" class="acq-item-close" data-acq-dismiss="${escapeHtml(entry.jobId)}" aria-label="Dismiss">×</button>
                    <div class="acq-item-title" title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</div>
                    <div class="acq-item-stage">${escapeHtml(label)}</div>
                    <div class="acq-item-bar-track"><div class="acq-item-bar-fill" style="width:${pct}%;"></div></div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('[data-acq-dismiss]').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                dismissItem(btn.getAttribute('data-acq-dismiss'));
            });
        });
    }

    function overallPie() {
        // Collapsed/floating-button view only ever shows one ring - the
        // least-done active item (most likely to be what the user is
        // waiting on), not an average across several.
        if (!items.length) return null;
        const priority = { error: 0, manual: 1, searching: 2, acquiring: 3, processing: 4, done: 5 };
        return items.slice().sort((a, b) => (priority[a.uiStage] ?? 9) - (priority[b.uiStage] ?? 9))[0];
    }

    // =====================================================================
    // Home-page mode: overlay the existing avatar + inject into its menu
    // =====================================================================
    function setupHomeMode() {
        homeMode = true;
        const avatarBtn = document.getElementById('avatar-btn');
        const avatarMenu = document.getElementById('avatar-menu');

        let overlay = document.getElementById('acq-avatar-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'acq-avatar-overlay';
            overlay.className = 'acq-avatar-overlay';
            avatarBtn.style.position = avatarBtn.style.position || 'relative';
            avatarBtn.appendChild(overlay);
        }

        let section = document.getElementById('acq-menu-section');
        if (!section) {
            section = document.createElement('div');
            section.id = 'acq-menu-section';
            section.className = 'acq-menu-section';
            section.innerHTML = '<div class="acq-section-title">My Acquisitions</div><div id="acq-menu-list"></div>';
            avatarMenu.insertBefore(section, avatarMenu.firstChild);
        }

        return { overlay, list: document.getElementById('acq-menu-list') };
    }

    // =====================================================================
    // Standalone mode: own floating button + own minimal dropdown
    // =====================================================================
    function setupStandaloneMode() {
        let btn = document.getElementById('acq-float-btn');
        let pie = document.getElementById('acq-float-pie');
        let dropdown = document.getElementById('acq-float-dropdown');

        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'acq-float-btn';
            btn.className = 'acq-float-btn';
            btn.setAttribute('aria-label', 'Acquisition progress');
            pie = document.createElement('div');
            pie.id = 'acq-float-pie';
            pie.className = 'acq-pie';
            btn.appendChild(pie);
            document.body.appendChild(btn);

            dropdown = document.createElement('div');
            dropdown.id = 'acq-float-dropdown';
            dropdown.className = 'acq-dropdown';
            dropdown.innerHTML = '<div class="acq-section-title">My Acquisitions</div><div id="acq-float-list"></div>';
            document.body.appendChild(dropdown);

            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                dropdown.classList.toggle('show');
            });
            document.addEventListener('click', (event) => {
                if (!dropdown.classList.contains('show')) return;
                if (dropdown.contains(event.target) || btn.contains(event.target)) return;
                dropdown.classList.remove('show');
            });
        }

        return { btn, pie, list: document.getElementById('acq-float-list') };
    }

    function renderAll() {
        if (homeMode) {
            const overlay = document.getElementById('acq-avatar-overlay');
            const list = document.getElementById('acq-menu-list');
            const section = document.getElementById('acq-menu-section');
            if (!overlay || !list || !section) return;

            const top = overallPie();
            overlay.style.display = top ? 'block' : 'none';
            overlay.className = `acq-avatar-overlay ${top ? stageClass(top) : ''}`.trim();
            if (top) overlay.style.setProperty('--acq-pct', `${stagePercent(top)}%`);

            section.style.display = items.length ? 'block' : 'none';
            renderItemsInto(list);
        } else {
            const btn = document.getElementById('acq-float-btn');
            const pie = document.getElementById('acq-float-pie');
            const list = document.getElementById('acq-float-list');
            if (!btn || !pie || !list) return;

            const top = overallPie();
            btn.classList.toggle('show', Boolean(top));
            if (top) {
                pie.className = `acq-pie ${stageClass(top)}`.trim();
                pie.style.setProperty('--acq-pct', `${stagePercent(top)}%`);
            }
            renderItemsInto(list);

            // Nothing left in flight - collapse the dropdown too, not just
            // the button, so it isn't left open and empty.
            if (!items.length) {
                const dropdown = document.getElementById('acq-float-dropdown');
                if (dropdown) dropdown.classList.remove('show');
            }
        }
    }

    function detectChangesAndToast(nextItems) {
        nextItems.forEach((entry) => {
            const prev = lastKnownStage.get(entry.jobId);
            if (prev === entry.uiStage) return;
            lastKnownStage.set(entry.jobId, entry.uiStage);
            if (prev === undefined) return; // first time seeing it - no toast on initial load

            if (entry.uiStage === 'done') {
                showAcqToast(`${entry.title} is ready to watch.`, 'success');
            } else if (entry.uiStage === 'error') {
                showAcqToast(`${entry.title} hit an error - retrying with a wider search.`, 'error');
            } else if (entry.uiStage === 'manual') {
                showAcqToast(`${entry.title} couldn't be found automatically - sent for manual acquisition.`, 'error');
            } else {
                showAcqToast(`${entry.title}: ${STAGE_LABELS[entry.uiStage] || entry.uiStage}`, 'info');
            }
        });

        // Drop tracking for anything no longer reported (dismissed/expired)
        // so a re-added job with the same id later starts fresh.
        const nextIds = new Set(nextItems.map((entry) => entry.jobId));
        Array.from(lastKnownStage.keys()).forEach((jobId) => {
            if (!nextIds.has(jobId)) lastKnownStage.delete(jobId);
        });
    }

    async function poll() {
        try {
            const res = await fetch('/api/acquisition-status/mine', { credentials: 'same-origin' });
            if (res.status === 401) return; // not signed in - nothing to show, not an error
            const data = await res.json().catch(() => ({}));
            if (!data.success || !Array.isArray(data.items)) return;

            detectChangesAndToast(data.items);
            items = data.items;
            renderAll();
        } catch (_err) {
            // Best-effort - a dropped poll just tries again next interval.
        }
    }

    function init() {
        injectStyles();

        if (document.getElementById('avatar-btn') && document.getElementById('avatar-menu')) {
            setupHomeMode();
        } else {
            setupStandaloneMode();
        }

        poll();
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
