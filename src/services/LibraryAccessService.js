const GROUP_ALL_MEDIA = 'all-media';
const GROUP_GLOBAL = 'global';

function normalizeUserKey(value = '') {
    return String(value || '').toLowerCase().trim();
}

function userGroup(userKey = '') {
    const clean = normalizeUserKey(userKey);
    if (!clean || clean === 'guest') return '';
    return `user:${clean}`;
}

function normalizeGroups(input, options = {}) {
    const source = Array.isArray(input)
        ? input
        : (typeof input === 'string' ? input.split(',') : []);

    const list = source
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean);

    const withAll = options.ensureAllMedia === false ? list : [GROUP_ALL_MEDIA, ...list];
    const withFallbackGlobal = (options.addGlobalIfMissing && withAll.length === 1)
        ? [...withAll, GROUP_GLOBAL]
        : withAll;

    return Array.from(new Set(withFallbackGlobal)).sort();
}

function getGroupsFromMedia(media = {}) {
    const explicit = media.libraryGroups || media.metadata?.libraryGroups || media.storage?.libraryGroups || [];
    return normalizeGroups(explicit, { addGlobalIfMissing: true });
}

function hasGroup(media = {}, group = '') {
    const target = String(group || '').toLowerCase().trim();
    if (!target) return false;
    return getGroupsFromMedia(media).includes(target);
}

function canUserSeeMedia(media = {}, userKey = '') {
    const groups = getGroupsFromMedia(media);
    const perUserGroup = userGroup(userKey);
    if (groups.includes(GROUP_GLOBAL)) return true;
    if (perUserGroup && groups.includes(perUserGroup)) return true;
    return false;
}

function buildMyLibraryCollection(library = {}, userKey = '', options = {}) {
    const maxCards = Math.max(1, Math.min(parseInt(options.limit, 10) || 18, 60));
    const targetGroup = userGroup(userKey);

    if (!targetGroup) {
        return {
            id: 'my-library-row',
            title: 'My Library',
            subtitle: 'sign in to create your personal shelf',
            cards: []
        };
    }

    const mediaList = [
        ...(Array.isArray(library.movies) ? library.movies : []),
        ...(Array.isArray(library.shows) ? library.shows : [])
    ];

    const items = mediaList
        .filter((item) => hasGroup(item, targetGroup))
        .sort((a, b) => {
            const aTime = new Date(a.addedAt || a.updatedAt || 0).getTime();
            const bTime = new Date(b.addedAt || b.updatedAt || 0).getTime();
            return bTime - aTime;
        })
        .slice(0, maxCards);

    return {
        id: 'my-library-row',
        title: 'My Library',
        subtitle: `${items.length} saved item${items.length === 1 ? '' : 's'}`,
        cards: items
    };
}

function mergeLibraryGroups(existingGroups, incomingGroups, options = {}) {
    const merged = normalizeGroups([
        ...normalizeGroups(existingGroups, { ensureAllMedia: false }),
        ...normalizeGroups(incomingGroups, { ensureAllMedia: false })
    ], {
        ensureAllMedia: true,
        addGlobalIfMissing: Boolean(options.addGlobalIfMissing)
    });

    return merged;
}

module.exports = {
    GROUP_ALL_MEDIA,
    GROUP_GLOBAL,
    normalizeUserKey,
    userGroup,
    normalizeGroups,
    getGroupsFromMedia,
    hasGroup,
    canUserSeeMedia,
    buildMyLibraryCollection,
    mergeLibraryGroups
};
