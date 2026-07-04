(function () {
    const STYLE_ID = 'watch-history-panel-style';

    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            .wh-backdrop {
                position: fixed;
                inset: 0;
                background: rgba(2, 6, 23, 0.72);
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.18s ease;
                z-index: 1200;
            }
            .wh-backdrop.show {
                opacity: 1;
                pointer-events: auto;
            }
            .wh-panel {
                position: fixed;
                top: 0;
                right: 0;
                width: min(940px, 94vw);
                height: 100vh;
                background: #0b1220;
                border-left: 1px solid #334155;
                box-shadow: -16px 0 36px rgba(0, 0, 0, 0.38);
                transform: translateX(103%);
                transition: transform 0.22s ease;
                z-index: 1210;
                display: flex;
                flex-direction: column;
            }
            .wh-panel.show {
                transform: translateX(0);
            }
            @media(max-width: 720px) {
                .wh-panel {
                    width: 100%;
                    height: 78vh;
                    top: auto;
                    bottom: 0;
                    border-left: 0;
                    border-top: 1px solid #334155;
                    border-top-left-radius: 12px;
                    border-top-right-radius: 12px;
                    transform: translateY(102%);
                }
                .wh-panel.show {
                    transform: translateY(0);
                }
            }
            .wh-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 10px;
                padding: 14px 16px;
                border-bottom: 1px solid #1e293b;
            }
            .wh-title {
                font-size: 0.98rem;
                font-weight: 700;
                color: #f8fafc;
            }
            .wh-subtitle {
                font-size: 0.76rem;
                color: #94a3b8;
                margin-top: 2px;
            }
            .wh-close {
                border: 0;
                border-radius: 8px;
                background: #1e293b;
                color: #e2e8f0;
                padding: 8px 10px;
                cursor: pointer;
                font-weight: 700;
                font-size: 0.8rem;
            }
            .wh-body {
                padding: 12px 16px 16px 16px;
                overflow: auto;
                flex: 1;
                min-height: 0;
            }
            .wh-state {
                font-size: 0.85rem;
                color: #94a3b8;
                border: 1px dashed #334155;
                border-radius: 8px;
                padding: 16px;
                text-align: center;
                background: #020617;
            }
            .wh-state.error {
                color: #fca5a5;
                border-color: #7f1d1d;
                background: rgba(127, 29, 29, 0.2);
            }
            .wh-table-wrap {
                border: 1px solid #334155;
                border-radius: 8px;
                overflow: auto;
                background: #020617;
            }
            .wh-table {
                width: 100%;
                min-width: 720px;
                border-collapse: collapse;
            }
            .wh-table th,
            .wh-table td {
                text-align: left;
                padding: 10px 12px;
                border-bottom: 1px solid #1e293b;
                font-size: 0.8rem;
            }
            .wh-table th {
                position: sticky;
                top: 0;
                background: #0b1220;
                color: #93c5fd;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                font-size: 0.74rem;
                z-index: 1;
            }
            .wh-title-cell {
                color: #f8fafc;
                font-weight: 700;
            }
            .wh-muted {
                color: #94a3b8;
                font-size: 0.74rem;
                margin-top: 2px;
            }
        `;

        document.head.appendChild(style);
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDate(value) {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString();
    }

    function formatPosition(seconds) {
        const total = Number(seconds || 0);
        if (!Number.isFinite(total) || total <= 0) return '0:00';
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = Math.floor(total % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    class WatchHistoryPanel {
        constructor() {
            ensureStyles();
            this.createUi();
        }

        createUi() {
            this.backdrop = document.createElement('div');
            this.backdrop.className = 'wh-backdrop';

            this.panel = document.createElement('aside');
            this.panel.className = 'wh-panel';
            this.panel.innerHTML = `
                <div class="wh-header">
                    <div>
                        <div class="wh-title" id="wh-title">Watch History</div>
                        <div class="wh-subtitle" id="wh-subtitle">Latest playback activity</div>
                    </div>
                    <button type="button" class="wh-close" id="wh-close-btn">Close</button>
                </div>
                <div class="wh-body" id="wh-body">
                    <div class="wh-state">Loading watch history...</div>
                </div>
            `;

            document.body.appendChild(this.backdrop);
            document.body.appendChild(this.panel);

            this.titleEl = this.panel.querySelector('#wh-title');
            this.subtitleEl = this.panel.querySelector('#wh-subtitle');
            this.bodyEl = this.panel.querySelector('#wh-body');
            this.panel.querySelector('#wh-close-btn').addEventListener('click', () => this.close());
            this.backdrop.addEventListener('click', () => this.close());
            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') this.close();
            });
        }

        close() {
            this.panel.classList.remove('show');
            this.backdrop.classList.remove('show');
        }

        showLoading() {
            this.bodyEl.innerHTML = '<div class="wh-state">Loading watch history...</div>';
        }

        showError(message) {
            this.bodyEl.innerHTML = `<div class="wh-state error">${escapeHtml(message || 'Could not load watch history.')}</div>`;
        }

        showEmpty() {
            this.bodyEl.innerHTML = '<div class="wh-state">No watch history yet. Start watching and this table will populate automatically.</div>';
        }

        renderRows(rows) {
            this.bodyEl.innerHTML = `
                <div class="wh-table-wrap">
                    <table class="wh-table">
                        <thead>
                            <tr>
                                <th>Title</th>
                                <th>Last Watched</th>
                                <th>Last Position</th>
                                <th>Media Key</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.map((row) => `
                                <tr>
                                    <td>
                                        <div class="wh-title-cell">${escapeHtml(row.title || 'Unknown Title')}</div>
                                    </td>
                                    <td>${escapeHtml(formatDate(row.updatedAtIso || row.updatedAt))}</td>
                                    <td>${escapeHtml(formatPosition(row.position))}</td>
                                    <td>
                                        <div>${escapeHtml(row.mediaId || '-')}</div>
                                        <div class="wh-muted">Updated: ${escapeHtml(String(row.updatedAt || '-'))}</div>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }

        async open(options = {}) {
            const endpoint = String(options.endpoint || '').trim();
            const title = String(options.title || 'Watch History').trim();
            const subtitle = String(options.subtitle || 'Latest playback activity').trim();

            if (!endpoint) {
                this.showError('Missing watch history endpoint.');
                return;
            }

            this.titleEl.textContent = title;
            this.subtitleEl.textContent = subtitle;
            this.showLoading();
            this.panel.classList.add('show');
            this.backdrop.classList.add('show');

            try {
                const res = await fetch(endpoint, { credentials: 'include' });
                const data = await res.json();
                if (!res.ok || !data.success) {
                    this.showError(data.error || 'Could not load watch history.');
                    return;
                }

                const rows = Array.isArray(data.history) ? data.history : [];
                if (rows.length === 0) {
                    this.showEmpty();
                    return;
                }

                this.renderRows(rows);
            } catch (err) {
                this.showError(err.message || 'Could not load watch history.');
            }
        }
    }

    window.WatchHistoryPanel = WatchHistoryPanel;
})();
