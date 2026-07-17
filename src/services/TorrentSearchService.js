const TorrentService = require('./TorrentService');

class QbitSearchProvider {
    constructor() {
        this.name = 'qbittorrent';
    }

    async getPlugins() {
        return TorrentService.getSearchPlugins();
    }

    async startSearch(input = {}) {
        return TorrentService.startSearch(input);
    }

    async getStatus(id = null) {
        return TorrentService.getSearchStatus(id);
    }

    async getResults(id, paging = {}) {
        return TorrentService.getSearchResults(id, paging);
    }

    async deleteSearch(id = 'all') {
        return TorrentService.deleteSearch(id);
    }
}

class TorrentSearchService {
    constructor() {
        this.providers = {
            qbittorrent: new QbitSearchProvider()
        };
    }

    getActiveProviderName() {
        const requested = String(process.env.TORRENT_SEARCH_PROVIDER || 'qbittorrent').trim().toLowerCase();
        return this.providers[requested] ? requested : 'qbittorrent';
    }

    getActiveProvider() {
        return this.providers[this.getActiveProviderName()];
    }

    listProviders() {
        return Object.keys(this.providers);
    }

    async getPlugins() {
        return this.getActiveProvider().getPlugins();
    }

    async startSearch(input = {}) {
        return this.getActiveProvider().startSearch(input);
    }

    async getStatus(id = null) {
        return this.getActiveProvider().getStatus(id);
    }

    async getResults(id, paging = {}) {
        return this.getActiveProvider().getResults(id, paging);
    }

    async deleteSearch(id = 'all') {
        return this.getActiveProvider().deleteSearch(id);
    }
}

module.exports = new TorrentSearchService();
