const ProfileService = require('./ProfileService');
const { loadIndex, getSeriesByImdbId } = require('./TvSeriesIndexService');
const { normalizeCard } = require('./HomeFeedService');

function normalizeImdbId(value = '') {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^[0-9]{5,10}$/.test(cleaned)) return '';
    return `tt${cleaned}`;
}

function normalizeSeriesRef(input = {}) {
    const imdbId = normalizeImdbId(input.imdbId || input.imdbID || input.id || '');
    const folderName = String(input.showFolder || input.folderName || input.folder || '').trim();
    const title = String(input.title || input.originalTitle || '').trim();
    const mediaId = String(input.mediaId || input.libraryId || '').trim();

    return {
        imdbId,
        mediaId,
        folderName,
        title,
        autoGet: input.autoGet !== false,
        addedAt: input.addedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastNotifiedEpisode: input.lastNotifiedEpisode || null
    };
}

async function readSubscriptions(userKey) {
    const cleanUser = String(userKey || '').trim().toLowerCase();
    if (!cleanUser) return { items: [] };

    const data = await ProfileService.readData(cleanUser, 'subscriptions', { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];

    return {
        userKey: cleanUser,
        items: items
            .filter((item) => item && typeof item === 'object')
            .map((item) => normalizeSeriesRef(item))
            .filter((item) => item.imdbId || item.mediaId || item.title)
            .sort((a, b) => new Date(b.updatedAt || b.addedAt || 0) - new Date(a.updatedAt || a.addedAt || 0))
    };
}

async function writeSubscriptions(userKey, items = []) {
    const cleanUser = String(userKey || '').trim().toLowerCase();
    const payload = {
        items: items
            .filter((item) => item && typeof item === 'object')
            .map((item) => normalizeSeriesRef(item))
            .filter((item) => item.imdbId || item.mediaId || item.title)
    };

    await ProfileService.writeData(cleanUser, 'subscriptions', payload);
    return payload;
}

async function addSubscription(userKey, input = {}) {
    const cleanUser = String(userKey || '').trim().toLowerCase();
    if (!cleanUser) {
        return { success: false, error: 'Missing user key.' };
    }

    const next = normalizeSeriesRef(input);
    if (!next.imdbId && !next.mediaId && !next.title) {
        return { success: false, error: 'Missing series reference.' };
    }

    const current = await readSubscriptions(cleanUser);
    const dedupeKey = next.imdbId || next.mediaId || next.title.toLowerCase();
    const list = current.items.filter((item) => {
        const itemKey = item.imdbId || item.mediaId || String(item.title || '').toLowerCase();
        return itemKey !== dedupeKey;
    });

    const registryItem = next.imdbId ? getSeriesByImdbId(next.imdbId) : null;
    const stored = {
        ...next,
        mediaId: next.mediaId || registryItem?.id || null,
        title: next.title || registryItem?.title || registryItem?.originalTitle || next.folderName || next.imdbId,
        folderName: next.folderName || registryItem?.folderName || null,
        cover: input.cover || registryItem?.cover || '',
        href: input.href || (registryItem?.id ? `/series.html?id=${encodeURIComponent(registryItem.id)}` : ''),
        contentType: 'series'
    };

    list.unshift(stored);
    await writeSubscriptions(cleanUser, list);
    return { success: true, item: stored, count: list.length };
}

async function removeSubscription(userKey, ref = {}) {
    const cleanUser = String(userKey || '').trim().toLowerCase();
    if (!cleanUser) {
        return { success: false, error: 'Missing user key.' };
    }

    const current = await readSubscriptions(cleanUser);
    const imdbId = normalizeImdbId(ref.imdbId || ref.id || '');
    const mediaId = String(ref.mediaId || ref.folderName || '').trim();
    const title = String(ref.title || '').trim().toLowerCase();

    const next = current.items.filter((item) => {
        if (imdbId && item.imdbId === imdbId) return false;
        if (mediaId && String(item.mediaId || '') === mediaId) return false;
        if (title && String(item.title || '').trim().toLowerCase() === title) return false;
        return true;
    });

    await writeSubscriptions(cleanUser, next);
    return { success: true, count: next.length };
}

function buildMyShowsCollection(library = {}, userKey = '', options = {}) {
    const cleanUser = String(userKey || '').trim().toLowerCase();
    const maxCards = Math.max(1, Math.min(parseInt(options.limit, 10) || 18, 60));
    if (!cleanUser) {
        return null;
    }

    const libraryShows = Array.isArray(library.shows) ? library.shows : [];
    const registry = loadIndex();
    const subscriptions = Array.isArray(options.subscriptions) ? options.subscriptions : [];
    const subKeys = new Set(subscriptions
        .map((item) => normalizeImdbId(item.imdbId || item.id || ''))
        .filter(Boolean));

    if (subKeys.size === 0) {
        return {
            id: 'my-shows-row',
            title: 'My Shows',
            subtitle: 'subscribe to tv shows from the show page',
            cards: []
        };
    }

    const cards = [];
    const seen = new Set();

    for (const show of libraryShows) {
        const imdbId = normalizeImdbId(show.imdbId || show.imdb_id || '');
        if (!imdbId || !subKeys.has(imdbId)) continue;
        if (seen.has(show.id)) continue;
        seen.add(show.id);
        cards.push(normalizeCard(show));
    }

    for (const item of registry.items || []) {
        const imdbId = normalizeImdbId(item.imdbId || '');
        if (!imdbId || !subKeys.has(imdbId)) continue;
        const libraryMatch = libraryShows.find((show) => normalizeImdbId(show.imdbId || show.imdb_id || '') === imdbId);
        if (libraryMatch) continue;

        const synthetic = {
            id: item.id || `series/${encodeURIComponent(item.folderName || item.title || imdbId)}`,
            title: item.title || item.originalTitle || item.folderName || imdbId,
            year: item.year || '',
            genre: item.genres || '',
            contentType: 'series',
            imdbId,
            cover: item.cover || `/movie-assets/series/${encodeURIComponent(item.folderName || item.title || imdbId)}/cover.jpg`,
            addedAt: item.addedAt || item.updatedAt || new Date().toISOString()
        };
        if (seen.has(synthetic.id)) continue;
        seen.add(synthetic.id);
        cards.push(normalizeCard(synthetic));
    }

    cards.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

    return {
        id: 'my-shows-row',
        title: 'My Shows',
        subtitle: cards.length > 0
            ? `${cards.length} subscribed show${cards.length === 1 ? '' : 's'}`
            : 'subscribe to tv shows from the show page',
        cards: cards.slice(0, maxCards)
    };
}

module.exports = {
    readSubscriptions,
    writeSubscriptions,
    addSubscription,
    removeSubscription,
    buildMyShowsCollection,
    normalizeSeriesRef
};