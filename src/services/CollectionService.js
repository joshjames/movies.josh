// src/services/CollectionService.js
// User-authored collections - the counterpart to PublicRowBuilderService's
// TMDb-driven rows, but local-library-only and tag-based instead of
// scheduled/external. A collection is just a saved filter definition
// (currently: a set of tags + any/all match mode); its item list is never
// cached to disk - it's evaluated live against getLibrary() on every read,
// since that's already fast and in-memory, and it means editing a title's
// tags takes effect immediately without needing a rebuild step.
//
// File convention: metadata/collections/<slug>.json holds just the
// definition ({id, title, tags, matchMode, createdAt}). materializeCollection
// produces the same row-item shape PublicRowBuilderService's rows use
// (mediaType/imdbId/title/year/poster/inLibrary/localId/localHref), so the
// frontend's existing row-item adapters (rowItemToGridItem, etc.) work on
// these unchanged.
'use strict';

const fs = require('fs');
const path = require('path');
const { getLibrary } = require('./db');

const DATA_ROOT_CANDIDATES = [
    String(process.env.APP_DATA_DIR || '').trim(),
    '/app/metadata',
    path.join(__dirname, '../../metadata'),
    path.join(__dirname, '../../movie-streamer-data')
].filter(Boolean);
const DATA_ROOT = DATA_ROOT_CANDIDATES[0];
const COLLECTIONS_DIR = path.join(DATA_ROOT, 'collections');

function ensureDir() {
    if (!fs.existsSync(COLLECTIONS_DIR)) {
        fs.mkdirSync(COLLECTIONS_DIR, { recursive: true });
    }
}

function slugify(title) {
    const clean = String(title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return clean || `collection-${Date.now()}`;
}

function normalizeTagMatch(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeTagArray(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(',');
    return [...new Set(source.map((t) => String(t).trim()).filter(Boolean))];
}

function listDefinitions() {
    ensureDir();
    return fs.readdirSync(COLLECTIONS_DIR)
        .filter((file) => file.endsWith('.json'))
        .map((file) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(COLLECTIONS_DIR, file), 'utf-8'));
            } catch (_err) {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
}

function getDefinition(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return null;
    return listDefinitions().find((def) => def.id === cleanId) || null;
}

function buildLibraryHref(item) {
    if (!item?.id) return null;
    return item.contentType === 'series'
        ? `/series.html?id=${encodeURIComponent(item.id)}`
        : `/player.html?id=${encodeURIComponent(item.id)}`;
}

function itemMatchesDefinition(item, def) {
    const defTags = Array.isArray(def.tags) ? def.tags.map(normalizeTagMatch) : [];
    if (!defTags.length) return false;
    const itemTags = Array.isArray(item.tags) ? item.tags.map(normalizeTagMatch) : [];
    if (!itemTags.length) return false;
    return def.matchMode === 'all'
        ? defTags.every((tag) => itemTags.includes(tag))
        : defTags.some((tag) => itemTags.includes(tag));
}

async function materializeCollection(def) {
    const library = await getLibrary();
    const allItems = [...(library.movies || []), ...(library.shows || [])];

    const items = allItems
        .filter((item) => itemMatchesDefinition(item, def))
        .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')))
        .map((item) => ({
            mediaType: item.contentType === 'series' ? 'tv' : 'movie',
            imdbId: item.imdbId || '',
            title: item.title || '',
            year: item.year || '',
            overview: item.plot || '',
            poster: item.cover || '',
            inLibrary: true,
            localId: item.id || null,
            localHref: buildLibraryHref(item)
        }));

    return {
        id: def.id,
        title: def.title,
        scope: 'collection',
        mediaType: 'mixed',
        badges: [],
        generatedAt: new Date().toISOString(),
        source: 'user-collection',
        filter: { tags: def.tags, matchMode: def.matchMode || 'any' },
        items
    };
}

async function listMaterializedCollections() {
    const defs = listDefinitions();
    const results = [];
    for (const def of defs) {
        try {
            results.push(await materializeCollection(def));
        } catch (_err) {
            // Skip a broken definition rather than failing the whole list.
        }
    }
    return results;
}

function saveDefinition({ title, tags, matchMode = 'any' } = {}) {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) throw new Error('Collection title is required.');

    const cleanTags = normalizeTagArray(tags);
    if (!cleanTags.length) throw new Error('At least one tag is required.');

    ensureDir();
    const id = slugify(cleanTitle);
    const def = {
        id,
        title: cleanTitle,
        tags: cleanTags,
        matchMode: matchMode === 'all' ? 'all' : 'any',
        createdAt: new Date().toISOString()
    };
    fs.writeFileSync(path.join(COLLECTIONS_DIR, `${id}.json`), JSON.stringify(def, null, 2), 'utf-8');
    return def;
}

function deleteDefinition(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return false;
    const filePath = path.join(COLLECTIONS_DIR, `${cleanId}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
}

module.exports = {
    COLLECTIONS_DIR,
    listDefinitions,
    getDefinition,
    listMaterializedCollections,
    materializeCollection,
    saveDefinition,
    deleteDefinition
};
