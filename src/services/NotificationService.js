const ProfileService = require('./ProfileService');

const DEFAULT_PER_CATEGORY_LIMIT = 30;
const MAX_TOTAL_NOTIFICATIONS = 120;

const CATEGORY_TTLS_MS = {
    system: Number(process.env.NOTIFY_SYSTEM_TTL_HOURS || 24 * 14) * 60 * 60 * 1000,
    library: Number(process.env.NOTIFY_LIBRARY_TTL_HOURS || 24 * 5) * 60 * 60 * 1000,
    user: Number(process.env.NOTIFY_USER_TTL_HOURS || 24 * 30) * 60 * 60 * 1000
};

function normalizeUserKey(value = '') {
    return String(value || '').toLowerCase().trim();
}

function normalizeCategory(value = '') {
    const raw = String(value || '').toLowerCase().trim();
    if (raw === 'library' || raw === 'user' || raw === 'system') return raw;
    return 'system';
}

function nowMs() {
    return Date.now();
}

function buildNotification(input = {}) {
    const category = normalizeCategory(input.category);
    const createdAtMs = Number(input.createdAtMs) || nowMs();
    const ttlMs = Number(input.ttlMs) > 0 ? Number(input.ttlMs) : (CATEGORY_TTLS_MS[category] || CATEGORY_TTLS_MS.system);
    const expiresAtMs = createdAtMs + ttlMs;

    return {
        id: `n_${createdAtMs}_${Math.random().toString(36).slice(2, 10)}`,
        category,
        title: String(input.title || 'Notification').trim(),
        message: String(input.message || '').trim(),
        href: String(input.href || '').trim(),
        payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
        createdAtMs,
        createdAt: new Date(createdAtMs).toISOString(),
        ttlMs,
        expiresAtMs,
        expiresAt: new Date(expiresAtMs).toISOString()
    };
}

function isExpired(entry, referenceMs = nowMs()) {
    const expiresAt = Number(entry?.expiresAtMs || 0);
    return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= referenceMs;
}

function sortByNewest(a, b) {
    return Number(b?.createdAtMs || 0) - Number(a?.createdAtMs || 0);
}

function compactList(items = []) {
    const seen = new Set();
    const deduped = [];

    items.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const id = String(entry.id || '').trim();
        if (!id || seen.has(id)) return;
        seen.add(id);
        deduped.push(entry);
    });

    return deduped
        .filter((entry) => !isExpired(entry))
        .sort(sortByNewest)
        .slice(0, MAX_TOTAL_NOTIFICATIONS);
}

async function readStore(userKey) {
    const cleanUser = normalizeUserKey(userKey);
    const data = await ProfileService.readData(cleanUser, 'notifications', { items: [] });
    const items = compactList(Array.isArray(data?.items) ? data.items : []);
    return {
        userKey: cleanUser,
        items,
        dirty: items.length !== (Array.isArray(data?.items) ? data.items.length : 0)
    };
}

async function writeStore(userKey, items = []) {
    const cleanUser = normalizeUserKey(userKey);
    const compacted = compactList(items);
    await ProfileService.writeData(cleanUser, 'notifications', { items: compacted });
    return compacted;
}

function groupNotifications(items = [], options = {}) {
    const limitPerCategory = Math.max(1, Math.min(parseInt(options.limitPerCategory, 10) || DEFAULT_PER_CATEGORY_LIMIT, 100));

    const groups = {
        system: [],
        library: [],
        user: []
    };

    items.forEach((entry) => {
        const category = normalizeCategory(entry?.category);
        if (groups[category].length < limitPerCategory) {
            groups[category].push(entry);
        }
    });

    const summary = {
        system: groups.system.length,
        library: groups.library.length,
        user: groups.user.length,
        total: groups.system.length + groups.library.length + groups.user.length
    };

    return { groups, summary };
}

const NotificationService = {
    async list(userKey, options = {}) {
        const store = await readStore(userKey);
        if (store.dirty) {
            await writeStore(store.userKey, store.items);
        }

        const limit = Math.max(1, Math.min(parseInt(options.limit, 10) || 30, MAX_TOTAL_NOTIFICATIONS));
        const items = store.items.slice(0, limit);
        const grouped = groupNotifications(items, { limitPerCategory: options.limitPerCategory });

        return {
            userKey: store.userKey,
            items,
            ...grouped
        };
    },

    async push(userKey, input = {}) {
        const store = await readStore(userKey);
        const next = buildNotification(input);
        const merged = [next, ...store.items].sort(sortByNewest);
        const saved = await writeStore(store.userKey, merged);

        return {
            success: true,
            userKey: store.userKey,
            notification: next,
            count: saved.length
        };
    },

    async prune(userKey) {
        const store = await readStore(userKey);
        const before = store.items.length;
        const saved = await writeStore(store.userKey, store.items);
        return {
            success: true,
            userKey: store.userKey,
            removed: Math.max(0, before - saved.length),
            count: saved.length
        };
    },

    async clearCategory(userKey, category) {
        const cleanCategory = normalizeCategory(category);
        const store = await readStore(userKey);
        const next = store.items.filter((entry) => normalizeCategory(entry.category) !== cleanCategory);
        const saved = await writeStore(store.userKey, next);
        return {
            success: true,
            userKey: store.userKey,
            category: cleanCategory,
            count: saved.length
        };
    },

    normalizeCategory
};

module.exports = NotificationService;
