const fs = require('fs');
const path = require('path');

const HOME_FEED_FILE = path.join(__dirname, '../../metadata/home_feed.json');
const RECENT_FEED_FILE = path.join(__dirname, '../../metadata/recent_feed.json');
const FALLBACK_LIBRARY_FILE = path.join(__dirname, '../../metadata/fallback_library.json');

function safeNumber(value) {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeGenres(media) {
    const raw = media.genre || media.enrichment?.genre || '';
    return String(raw)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function getScore(media) {
    return safeNumber(media.imdbScore || media.rating || media.enrichment?.imdbScore);
}

function normalizeCard(media) {
    const targetEndpoint = media.contentType === 'series' ? 'series.html' : 'player.html';
    return {
        id: media.id,
        title: media.title || '',
        year: media.year || '',
        genre: media.genre || media.enrichment?.genre || '',
        imdbScore: media.imdbScore || media.rating || media.enrichment?.imdbScore || '',
        contentType: media.contentType || 'movie',
        cover: media.cover || '',
        href: `${targetEndpoint}?id=${media.id}`,
        badge: media.contentType === 'series' ? 'TV Show' : '',
        addedAt: media.addedAt || media.updatedAt || null
    };
}

function buildRecentCollection(mediaList = []) {
    const recent = [...mediaList].sort((a, b) => {
        const aTime = new Date(a.addedAt || a.updatedAt || 0).getTime();
        const bTime = new Date(b.addedAt || b.updatedAt || 0).getTime();
        return bTime - aTime;
    });

    return {
        id: 'recently-added-row',
        title: 'Recently Added',
        subtitle: 'newest items first',
        cards: recent.slice(0, 18).map(normalizeCard)
    };
}

function buildCollections(mediaList = []) {
    const topRated = [...mediaList]
        .filter(media => getScore(media) !== null && getScore(media) >= 8)
        .sort((a, b) => (getScore(b) || 0) - (getScore(a) || 0));

    const shows = mediaList.filter(media => media.contentType === 'series');

    const genreMap = new Map();
    mediaList.forEach(media => {
        normalizeGenres(media).slice(0, 2).forEach(genre => {
            if (!genreMap.has(genre)) genreMap.set(genre, []);
            genreMap.get(genre).push(media);
        });
    });

    const collections = [
        {
            id: 'top-rated-row',
            title: 'Top Rated',
            subtitle: 'IMDb score 8.0 and up',
            cards: topRated.slice(0, 18).map(normalizeCard)
        }
    ];

    if (shows.length > 0) {
        collections.push({
            id: 'series-row',
            title: 'TV Shows',
            subtitle: 'series collection',
            cards: shows.slice(0, 18).map(normalizeCard)
        });
    }

    [...genreMap.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 3)
        .forEach(([genre, items]) => {
            collections.push({
                id: `genre-${genre.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                title: genre,
                subtitle: 'genre collection',
                cards: items.slice(0, 18).map(normalizeCard)
            });
        });

    return collections;
}

function buildHomeFeed(library = {}) {
    const mediaList = [...(library.movies || []), ...(library.shows || [])];
    return {
        generatedAt: new Date().toISOString(),
        totalItems: mediaList.length,
        collections: buildCollections(mediaList)
    };
}

function buildRecentFeed(library = {}) {
    const mediaList = [...(library.movies || []), ...(library.shows || [])];
    return {
        generatedAt: new Date().toISOString(),
        totalItems: mediaList.length,
        collection: buildRecentCollection(mediaList)
    };
}

function saveHomeFeed(feed) {
    fs.mkdirSync(path.dirname(HOME_FEED_FILE), { recursive: true });
    fs.writeFileSync(HOME_FEED_FILE, JSON.stringify(feed, null, 4), 'utf-8');
    return HOME_FEED_FILE;
}

function saveRecentFeed(feed) {
    fs.mkdirSync(path.dirname(RECENT_FEED_FILE), { recursive: true });
    fs.writeFileSync(RECENT_FEED_FILE, JSON.stringify(feed, null, 4), 'utf-8');
    return RECENT_FEED_FILE;
}

function loadHomeFeed() {
    if (!fs.existsSync(HOME_FEED_FILE)) return null;

    try {
        return JSON.parse(fs.readFileSync(HOME_FEED_FILE, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function loadRecentFeed() {
    if (!fs.existsSync(RECENT_FEED_FILE)) return null;

    try {
        return JSON.parse(fs.readFileSync(RECENT_FEED_FILE, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function upsertRecentCard(card) {
    const current = loadRecentFeed() || { generatedAt: new Date().toISOString(), totalItems: 0, collection: { id: 'recently-added-row', title: 'Recently Added', subtitle: 'newest items first', cards: [] } };
    const incomingId = String(card.id || '');
    const cards = [card, ...(current.collection?.cards || []).filter(existing => String(existing.id || '') !== incomingId)]
        .sort((a, b) => new Date(b.addedAt || 0).getTime() - new Date(a.addedAt || 0).getTime())
        .slice(0, 18);

    const next = {
        generatedAt: new Date().toISOString(),
        totalItems: Math.max(current.totalItems || 0, cards.length),
        collection: {
            id: 'recently-added-row',
            title: 'Recently Added',
            subtitle: 'newest items first',
            cards
        }
    };

    saveRecentFeed(next);
    return next;
}

function loadHomeFeedWithFallback() {
    const cached = loadHomeFeed();
    const cachedRecent = loadRecentFeed();

    if (cached || cachedRecent) {
        const collections = [];
        if (cachedRecent?.collection) collections.push(cachedRecent.collection);
        if (cached?.collections?.length) collections.push(...cached.collections.filter(c => c.id !== 'recently-added-row'));
        return {
            generatedAt: new Date().toISOString(),
            totalItems: Math.max(cached?.totalItems || 0, cachedRecent?.totalItems || 0),
            collections
        };
    }

    if (!fs.existsSync(FALLBACK_LIBRARY_FILE)) return null;

    try {
        const library = JSON.parse(fs.readFileSync(FALLBACK_LIBRARY_FILE, 'utf-8'));
        const staticFeed = buildHomeFeed(library);
        const recentFeed = buildRecentFeed(library);
        return {
            generatedAt: new Date().toISOString(),
            totalItems: Math.max(staticFeed.totalItems || 0, recentFeed.totalItems || 0),
            collections: [recentFeed.collection, ...staticFeed.collections]
        };
    } catch (_err) {
        return null;
    }
}

module.exports = {
    HOME_FEED_FILE,
    RECENT_FEED_FILE,
    buildHomeFeed,
    buildRecentFeed,
    loadHomeFeed,
    loadRecentFeed,
    loadHomeFeedWithFallback,
    normalizeCard,
    saveHomeFeed
    ,saveRecentFeed
    ,upsertRecentCard
};