const fs = require('fs');
const path = require('path');

function parseSeasonEpisode(fileName = '', fallbackSeason = null) {
    const sxe = String(fileName).match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
    if (sxe) {
        return {
            season: parseInt(sxe[1], 10),
            episode: parseInt(sxe[2], 10)
        };
    }

    const xStyle = String(fileName).match(/\b(\d{1,2})x(\d{1,3})\b/i);
    if (xStyle) {
        return {
            season: parseInt(xStyle[1], 10),
            episode: parseInt(xStyle[2], 10)
        };
    }

    if (fallbackSeason) {
        const epFromName = String(fileName).match(/\b(?:ep|episode)[\s._-]?(\d{1,3})\b/i);
        if (epFromName) {
            return {
                season: fallbackSeason,
                episode: parseInt(epFromName[1], 10)
            };
        }
    }

    return null;
}

function normalizeSeasonFromFolder(folderName = '') {
    const match = String(folderName).match(/season[\s._-]?(\d{1,3})/i);
    if (match) return parseInt(match[1], 10);
    return null;
}

function readExistingSeriesManifest(showPath) {
    const seriesFile = path.join(showPath, 'series.json');
    if (!fs.existsSync(seriesFile)) return { totalSeasons: '0', seasons: {} };

    try {
        const parsed = JSON.parse(fs.readFileSync(seriesFile, 'utf-8'));
        if (!parsed || typeof parsed !== 'object') return { totalSeasons: '0', seasons: {} };
        return {
            totalSeasons: String(parsed.totalSeasons || '0'),
            seasons: parsed.seasons || {}
        };
    } catch (_err) {
        return { totalSeasons: '0', seasons: {} };
    }
}

function scanEpisodesFromDisk(showPath, showFolderName) {
    const episodes = [];
    if (!fs.existsSync(showPath)) return episodes;

    const entries = fs.readdirSync(showPath, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const seasonFolderName = entry.name;
        const seasonFolderPath = path.join(showPath, seasonFolderName);
        const fallbackSeason = normalizeSeasonFromFolder(seasonFolderName);

        const files = fs.readdirSync(seasonFolderPath);
        for (const file of files) {
            if (!/\.(mp4|mkv|m4v)$/i.test(file)) continue;
            const parsed = parseSeasonEpisode(file, fallbackSeason);
            if (!parsed) continue;

            episodes.push({
                season: parsed.season,
                episode: parsed.episode,
                localRelativePath: `series/${showFolderName}/${seasonFolderName}/${file}`
            });
        }
    }

    return episodes;
}

function rebuildSeriesManifest(showPath, options = {}) {
    const showFolderName = options.showFolderName || path.basename(showPath);
    const existing = readExistingSeriesManifest(showPath);
    const foundEpisodes = scanEpisodesFromDisk(showPath, showFolderName);

    const mergedBySeason = new Map();

    Object.keys(existing.seasons || {}).forEach(seasonKey => {
        const seasonNum = parseInt(seasonKey, 10);
        if (!Number.isFinite(seasonNum)) return;
        const eps = Array.isArray(existing.seasons[seasonKey]?.episodes)
            ? existing.seasons[seasonKey].episodes
            : [];

        const seasonMap = new Map();
        eps.forEach(ep => {
            const epNum = parseInt(ep.episodeNumber, 10);
            if (!Number.isFinite(epNum)) return;
            seasonMap.set(epNum, {
                episodeNumber: epNum,
                title: ep.title || `Episode ${epNum}`,
                released: ep.released || 'Unknown',
                plot: ep.plot || '',
                imdbRating: ep.imdbRating || 'N/A',
                available: Boolean(ep.available),
                localRelativePath: ep.localRelativePath || null,
                remoteRelativePath: ep.remoteRelativePath || null
            });
        });

        mergedBySeason.set(seasonNum, seasonMap);
    });

    foundEpisodes.forEach(found => {
        if (!mergedBySeason.has(found.season)) {
            mergedBySeason.set(found.season, new Map());
        }

        const seasonMap = mergedBySeason.get(found.season);
        const prev = seasonMap.get(found.episode) || {
            episodeNumber: found.episode,
            title: `Episode ${found.episode}`,
            released: 'Unknown',
            plot: '',
            imdbRating: 'N/A',
            remoteRelativePath: null
        };

        seasonMap.set(found.episode, {
            ...prev,
            available: true,
            localRelativePath: found.localRelativePath
        });
    });

    // Correct availability for episodes not currently found on disk.
    mergedBySeason.forEach((seasonMap, seasonNum) => {
        seasonMap.forEach((ep, epNum) => {
            const exists = foundEpisodes.some(found => found.season === seasonNum && found.episode === epNum);
            if (!exists) {
                seasonMap.set(epNum, {
                    ...ep,
                    available: false,
                    localRelativePath: null
                });
            }
        });
    });

    const seasonNumbers = Array.from(mergedBySeason.keys()).sort((a, b) => a - b);
    const output = {
        totalSeasons: String(Math.max(parseInt(existing.totalSeasons || '0', 10) || 0, seasonNumbers[seasonNumbers.length - 1] || 0)),
        seasons: {}
    };

    seasonNumbers.forEach(seasonNum => {
        const episodes = Array.from(mergedBySeason.get(seasonNum).values())
            .sort((a, b) => a.episodeNumber - b.episodeNumber)
            .map(ep => ({
                episodeNumber: ep.episodeNumber,
                title: ep.title,
                released: ep.released,
                plot: ep.plot,
                imdbRating: ep.imdbRating,
                available: Boolean(ep.available),
                localRelativePath: ep.localRelativePath || null,
                remoteRelativePath: ep.remoteRelativePath || null
            }));

        output.seasons[String(seasonNum)] = {
            seasonNumber: String(seasonNum),
            episodes
        };
    });

    if (options.write !== false) {
        fs.writeFileSync(path.join(showPath, 'series.json'), JSON.stringify(output, null, 4), 'utf-8');
    }

    return output;
}

module.exports = {
    rebuildSeriesManifest
};
