const fs = require('fs');
const path = require('path');

const INDEX_FILE = path.join(__dirname, '../../metadata/tv-show-index.json');

function loadIndex() {
    if (!fs.existsSync(INDEX_FILE)) {
        return { updatedAt: null, totalItems: 0, items: [] };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
        return {
            updatedAt: parsed.updatedAt || null,
            totalItems: parsed.totalItems || (Array.isArray(parsed.items) ? parsed.items.length : 0),
            items: Array.isArray(parsed.items) ? parsed.items : []
        };
    } catch (_err) {
        return { updatedAt: null, totalItems: 0, items: [] };
    }
}

function normalizeTerm(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildSearchText(item) {
    return normalizeTerm([
        item.title,
        item.originalTitle,
        item.genres,
        item.startYear,
        item.endYear,
        item.imdbId
    ].filter(Boolean).join(' '));
}

function searchIndex(query, limit = 40) {
    const index = loadIndex();
    const cleanQuery = normalizeTerm(query);
    const cappedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 40, 100));

    if (!cleanQuery) {
        return index.items.slice(0, cappedLimit);
    }

    const queryTerms = cleanQuery.split(' ').filter(Boolean);
    return index.items
        .map(item => {
            const haystack = item.searchText || buildSearchText(item);
            const titleNorm = normalizeTerm(item.title || item.originalTitle || '');

            let score = 0;
            for (const term of queryTerms) {
                if (titleNorm === term) score += 8;
                else if (titleNorm.startsWith(term)) score += 5;
                else if (titleNorm.includes(term)) score += 3;
                else if (haystack.includes(term)) score += 1;
                else return null;
            }

            return {
                item,
                score
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if ((b.item.numVotes || 0) !== (a.item.numVotes || 0)) return (b.item.numVotes || 0) - (a.item.numVotes || 0);
            if ((b.item.averageRating || 0) !== (a.item.averageRating || 0)) return (b.item.averageRating || 0) - (a.item.averageRating || 0);
            return String(a.item.title || '').localeCompare(String(b.item.title || ''));
        })
        .slice(0, cappedLimit)
        .map(row => row.item);
}

function getSeriesByImdbId(imdbId) {
    const index = loadIndex();
    const cleanImdbId = String(imdbId || '').replace(/^tt/i, '').trim();
    return index.items.find(item => String(item.imdbId || '').replace(/^tt/i, '') === cleanImdbId) || null;
}

module.exports = {
    INDEX_FILE,
    loadIndex,
    searchIndex,
    getSeriesByImdbId,
    buildSearchText,
    normalizeTerm
};