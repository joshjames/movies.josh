const fs = require('fs');
const path = require('path');

const HOME_FEED_FILE = path.join(__dirname, '../../metadata/home_feed.json');
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
        badge: media.contentType === 'series' ? 'TV Show' : ''
    };
}

function buildCollections(mediaList = []) {
    const recent = [...mediaList].sort((a, b) => {
        const aTime = new Date(a.updatedAt || 0).getTime();
        const bTime = new Date(b.updatedAt || 0).getTime();
        return bTime - aTime;
    });

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
            id: 'recently-added-row',
            title: 'Recently Added',
            subtitle: 'newest items first',
            cards: recent.slice(0, 18).map(normalizeCard)
        },
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

function saveHomeFeed(feed) {
    fs.mkdirSync(path.dirname(HOME_FEED_FILE), { recursive: true });
    fs.writeFileSync(HOME_FEED_FILE, JSON.stringify(feed, null, 4), 'utf-8');
    return HOME_FEED_FILE;
}

function loadHomeFeed() {
    if (!fs.existsSync(HOME_FEED_FILE)) return null;

    try {
        return JSON.parse(fs.readFileSync(HOME_FEED_FILE, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function loadHomeFeedWithFallback() {
    const cached = loadHomeFeed();
    if (cached) return cached;

    if (!fs.existsSync(FALLBACK_LIBRARY_FILE)) return null;

    try {
        const library = JSON.parse(fs.readFileSync(FALLBACK_LIBRARY_FILE, 'utf-8'));
        return buildHomeFeed(library);
    } catch (_err) {
        return null;
    }
}

module.exports = {
    HOME_FEED_FILE,
    buildHomeFeed,
    loadHomeFeed,
    loadHomeFeedWithFallback,
    saveHomeFeed
};