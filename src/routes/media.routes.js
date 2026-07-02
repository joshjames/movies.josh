// src/routes/media.routes.js
// Media catalog discovery, paginated queries, subtitle streams, and B2 presigned asset routers.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const axios = require('axios');
const { getLibrary } = require('../services/db');
const { loadHomeFeedWithFallback } = require('../services/HomeFeedService');
const { rebuildSeriesManifest } = require('../services/SeriesIndexService');
const { loadIndex, searchIndex, getSeriesByImdbId } = require('../services/TvSeriesIndexService');

const MediaService = require('../services/MediaService');
const MOVIES_DIR = process.env.MOVIES_DIR
    || (fs.existsSync('/app/storage/movies') ? '/app/storage/movies'
        : (fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies'));
// 🚨 NEW FIX: Isolated pathway pointing to the new separate SSD mount for TV shows
const SERIES_DIR = process.env.SERIES_DIR
    || (fs.existsSync('/app/storage/series') ? '/app/storage/series' : '/data/blockchain/media/Series');

const MOVIE_PATH_CANDIDATES = [
    MOVIES_DIR,
    '/home/epic/movies',
    '/app/storage/movies',
    '/app/movies'
].filter((v, i, arr) => v && arr.indexOf(v) === i);

const TV_COVER_DIR = path.join(__dirname, '../../metadata/tv-covers');

function formatImdbId(imdbId) {
    const raw = String(imdbId || '').trim();
    if (!raw) return '';
    return raw.startsWith('tt') ? raw : `tt${raw}`;
}

function withCover(item) {
    const formattedId = formatImdbId(item.imdbId || '');
    return {
        ...item,
        imdbId: formattedId,
        cover: formattedId ? `/api/tv-shows/${encodeURIComponent(formattedId)}/cover` : ''
    };
}

function resolveMovieFolderPath(movieId) {
    const candidates = MOVIE_PATH_CANDIDATES.map(base => path.join(base, movieId));
    return candidates.find(candidate => fs.existsSync(candidate)) || path.join(MOVIES_DIR, movieId);
}

function normalizeEpisodeSearchToken(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
}

function readShowMetadataTitle(showPath, fallbackTitle) {
    const metaPath = path.join(showPath, 'metadata.json');
    if (!fs.existsSync(metaPath)) return fallbackTitle;
    try {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        return metadata.title || fallbackTitle;
    } catch (_err) {
        return fallbackTitle;
    }
}

// =========================================================================
// ENDPOINTS
// =========================================================================

// GET: /api/library (Serves the entire dashboard instantly out of memory)
router.get('/library', async (req, res) => {
    try {
        const library = await getLibrary();
        return res.json({ success: true, library });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/home-feed (Serves the pre-generated home page collections cache)
router.get('/home-feed', (req, res) => {
    const homeFeed = loadHomeFeedWithFallback();
    if (!homeFeed) {
        return res.status(503).json({
            success: false,
            error: 'Home feed cache missing. Ask admin to regenerate the home feed.'
        });
    }

    return res.json({ success: true, feed: homeFeed });
});

router.get('/tv-shows/search', async (req, res) => {
    try {
        const query = String(req.query.q || req.query.query || '').trim();
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 40, 100));
        const localOnly = ['1', 'true', 'yes', 'local'].includes(String(req.query.localOnly || req.query.source || '').toLowerCase());
        const index = loadIndex();
        let items = searchIndex(query, limit).map(withCover);
        let source = 'local-index';

        // Container deployments may not have the generated local index file.
        // For non-empty queries, fall back to OMDb search so TV browse still works.
        if (!localOnly && items.length === 0 && query) {
            const apiKey = process.env.OMDB_API_KEY || '84196d01';
            const omdbRes = await axios.get(
                `http://www.omdbapi.com/?apikey=${apiKey}&s=${encodeURIComponent(query)}&type=series`,
                { timeout: 8000 }
            );

            const fallback = Array.isArray(omdbRes.data?.Search) ? omdbRes.data.Search : [];
            items = fallback
                .slice(0, limit)
                .map(row => {
                    const yearRaw = String(row.Year || '');
                    const [startYear, endYear] = yearRaw.split('-');
                    return withCover({
                        imdbId: row.imdbID,
                        title: row.Title,
                        originalTitle: row.Title,
                        startYear: startYear || '',
                        endYear: endYear || '',
                        genres: '',
                        averageRating: 0,
                        numVotes: 0,
                        episodeCount: 0,
                        isAdult: false
                    });
                });

            if (items.length > 0) {
                source = 'omdb-fallback';
            }
        }

        return res.json({
            success: true,
            source,
            updatedAt: index.updatedAt,
            totalItems: index.totalItems,
            count: items.length,
            items,
            missingBasics: index.totalItems === 0 && items.length === 0
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/tv-shows/:imdbId', (req, res) => {
    try {
        const item = getSeriesByImdbId(req.params.imdbId);
        if (!item) {
            return res.status(404).json({ success: false, error: 'Series not found in local index.' });
        }
        return res.json({ success: true, item: withCover(item) });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/tv-shows/:imdbId/cover', async (req, res) => {
    try {
        const imdbId = formatImdbId(req.params.imdbId);
        if (!imdbId) {
            return res.status(400).send('Invalid IMDb ID');
        }

        const coverPath = path.join(TV_COVER_DIR, `${imdbId}.jpg`);
        if (fs.existsSync(coverPath)) {
            return res.sendFile(coverPath);
        }

        fs.mkdirSync(TV_COVER_DIR, { recursive: true });

        const apiKey = process.env.OMDB_API_KEY || '84196d01';
        const omdbRes = await axios.get(`http://www.omdbapi.com/?apikey=${apiKey}&i=${encodeURIComponent(imdbId)}`, {
            timeout: 8000
        });
        const posterUrl = omdbRes.data?.Poster;

        if (!posterUrl || posterUrl === 'N/A') {
            return res.status(404).send('No cover found');
        }

        const imageRes = await axios.get(posterUrl, {
            responseType: 'arraybuffer',
            timeout: 12000
        });
        await fsPromises.writeFile(coverPath, Buffer.from(imageRes.data));
        return res.sendFile(coverPath);
    } catch (_err) {
        return res.status(404).send('No cover found');
    }
});

// GET: /api/movies (High-Performance Paginated Catalog Discovery utilizing Redis lookups)
// =========================================================================
// 🎬 UNIFIED MEDIA CATALOG ROUTE (Surfaces Both Movies & TV Shows)
// =========================================================================
router.get('/movies', async (req, res) => {
    try {
        // Safe extraction from your actual hot-cache database layout
        const library = await getLibrary();
        const cachedMovies = library.movies || [];
        const cachedShows = library.shows || [];

        // Normalize data flags: ensure TV Shows have their flag set for index.html mapping
        const normalizedShows = cachedShows.map(show => ({
            ...show,
            contentType: 'series',
            // Map keys if your front end is looking for media.id vs show path matching
            cover: show.cover || show.poster || `/movie-assets/series/${encodeURIComponent(show.id.replace('series/', ''))}/cover.jpg`
        }));

        // Combine both internal asset segments into a flat layout matching index.html execution blocks
        const combinedCatalog = [...cachedMovies, ...normalizedShows].map(item => {
            const versionKey = encodeURIComponent(item.updatedAt || library.lastScan || Date.now());
            const separator = (item.cover || '').includes('?') ? '&' : '?';
            return {
                ...item,
                cover: item.cover ? `${item.cover}${separator}v=${versionKey}` : item.cover
            };
        });

        // Perform clean alphabetic ordering so collections don't randomly flip positions
        combinedCatalog.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 24; 
        
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;

        const paginatedCatalog = combinedCatalog.slice(startIndex, endIndex);

        res.json({
            totalMovies: combinedCatalog.length, // Matches frontend object unpacking key expectation
            totalPages: Math.ceil(combinedCatalog.length / limit),
            currentPage: page,
            movies: paginatedCatalog
        });
    } catch (err) {
        console.error("❌ Unified library catalog processing breakdown:", err);
        res.status(500).json({ success: false, error: "Failed to assemble structured movie matrix blocks." });
    }
});



// GET: /api/movies/:id (Individual Stream Quality Switcher Profile Router)
router.get('/movies/:id', async (req, res) => {
    const movieId = req.params.id;
    const movieFolder = resolveMovieFolderPath(movieId);
    const infoFilePath = path.join(movieFolder, 'movie_info.json');
    const metaFilePath = path.join(movieFolder, 'metadata.json'); 

    let streamPayload = {
        id: movieId,
        title: movieId.replace(/\./g, ' '), 
        file1080p: null,
        file720p: null,
        file480p: null
    };

    // Unpack local details if configured inside the storage path
    try {
        const rawData = await fsPromises.readFile(infoFilePath, 'utf8');
        const meta = JSON.parse(rawData);
        streamPayload.title = meta.title || streamPayload.title;
    } catch (e) {
        // Silent block bypass for clean fallback names
    }

    const rankLocalProfiles = (fileName) => {
        const lower = String(fileName || '').toLowerCase();
        if (!lower.endsWith('.mp4') && !lower.endsWith('.mkv') && !lower.endsWith('.m4v')) return 0;
        if (lower.endsWith('.web.mp4')) return 100;
        if (lower.includes('1080p')) return 90;
        if (lower.includes('720p')) return 70;
        if (lower.includes('480p')) return 50;
        return 80;
    };

    const pickBestLocalFiles = (files = []) => {
        const videos = files.filter(f => /\.(mp4|mkv|m4v)$/i.test(f));
        const web1080 = videos.find(f => f.endsWith('.web.mp4')) || null;
        const tagged1080 = videos.find(f => /1080p/i.test(f)) || null;
        const tagged720 = videos.find(f => /720p/i.test(f)) || null;
        const tagged480 = videos.find(f => /480p/i.test(f)) || null;

        const bestGeneral = [...videos].sort((a, b) => rankLocalProfiles(b) - rankLocalProfiles(a))[0] || null;

        return {
            local1080: web1080 || tagged1080 || bestGeneral,
            local720: tagged720 || null,
            local480: tagged480 || null
        };
    };

    // 🚨 CLOUD TRACKING CHECK: Check if the file lives in object storage before running local fs checks
    try {
        if (fs.existsSync(metaFilePath)) {
            const rawMeta = await fsPromises.readFile(metaFilePath, 'utf-8');
            const metaData = JSON.parse(rawMeta);
            
            if (metaData?.storage?.location === 'remote') {
                const files = await fsPromises.readdir(movieFolder).catch(() => []);
                const { local1080, local720, local480 } = pickBestLocalFiles(files);

                streamPayload.title = metaData.title || streamPayload.title;
                streamPayload.file1080p = await MediaService.getPlaybackUrl(
                    metaData,
                    '1080p',
                    local1080 ? `/movie-assets/${movieId}/${local1080}` : null
                );
                streamPayload.file720p = await MediaService.getPlaybackUrl(
                    metaData,
                    '720p',
                    local720 ? `/movie-assets/${movieId}/${local720}` : null
                );
                streamPayload.file480p = await MediaService.getPlaybackUrl(
                    metaData,
                    '480p',
                    local480 ? `/movie-assets/${movieId}/${local480}` : null
                );

                if (streamPayload.file1080p || streamPayload.file720p || streamPayload.file480p) {
                    return res.json(streamPayload);
                }
            }
        }
    } catch (err) {
        // Fail over quietly to evaluate standard disk lookups
    }

    // Standard Local File Checking Core
    try {
        await fsPromises.access(movieFolder);
    } catch {
        return res.status(404).json({ status: 'error', message: 'Movie cluster destination missing.' });
    }

    const expectedOutputs = {
        '1080p': `${movieId}.web.mp4`,      
        '720p': `${movieId}.720p.mp4`,      
        '480p': `${movieId}.480p.mp4`       
    };

    const allFiles = await fsPromises.readdir(movieFolder).catch(() => []);
    const pickedLocal = pickBestLocalFiles(allFiles);

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['1080p']));
        streamPayload.file1080p = `/movie-assets/${movieId}/${expectedOutputs['1080p']}`;
    } catch {
        try {
            const files = await fsPromises.readdir(movieFolder);
            const sourceMp4 = files.find(f => f.endsWith('.mp4') && !f.includes('720p') && !f.includes('480p'));
            if (sourceMp4) streamPayload.file1080p = `/movie-assets/${movieId}/${sourceMp4}`;
        } catch {}
    }

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['720p']));
        streamPayload.file720p = `/movie-assets/${movieId}/${expectedOutputs['720p']}`;
    } catch {
        if (pickedLocal.local720) {
            streamPayload.file720p = `/movie-assets/${movieId}/${pickedLocal.local720}`;
        }
    }

    try {
        await fsPromises.access(path.join(movieFolder, expectedOutputs['480p']));
        streamPayload.file480p = `/movie-assets/${movieId}/${expectedOutputs['480p']}`;
    } catch {
        if (pickedLocal.local480) {
            streamPayload.file480p = `/movie-assets/${movieId}/${pickedLocal.local480}`;
        }
    }

    if (!streamPayload.file1080p) {
        if (pickedLocal.local1080) {
            streamPayload.file1080p = `/movie-assets/${movieId}/${pickedLocal.local1080}`;
        } else {
            streamPayload.file1080p = `/movie-assets/${movieId}`;
        }
    }

    res.json(streamPayload);
});

// GET: /api/series/:showFolder (Unified Series Hierarchy Aggregator)
router.get('/series/:showFolder', async (req, res) => {
    try {
        const showFolder = decodeURIComponent(req.params.showFolder);
        // 🚨 FIX: Updated to find directories inside the new separate SERIES_DIR path
        const showPath = path.join(SERIES_DIR, showFolder);

        const metaFile = path.join(showPath, 'metadata.json');
        const seriesFile = path.join(showPath, 'series.json');

        try {
            await fsPromises.access(metaFile);
        } catch {
            return res.status(404).json({ error: "Serialized map targets are currently missing for this show cluster destination." });
        }

        const rawMeta = await fsPromises.readFile(metaFile, 'utf-8');
        const metaData = JSON.parse(rawMeta);
        let seriesData = null;

        try {
            seriesData = rebuildSeriesManifest(showPath, {
                showFolderName: showFolder,
                write: true
            });
        } catch (_err) {
            const rawSeries = await fsPromises.readFile(seriesFile, 'utf-8');
            seriesData = JSON.parse(rawSeries);
        }

        res.json({
            id: `series/${showFolder}`,
            title: metaData.title,
            year: metaData.year,
            plot: metaData.plot,
            genre: metaData.genre,
            poster: `/movie-assets/series/${encodeURIComponent(showFolder)}/cover.jpg`,
            seasons: seriesData.seasons,
            totalSeasons: seriesData.totalSeasons
        });
    } catch (err) {
        console.error("❌ Unified Series router failure:", err);
        res.status(500).json({ error: "Failed assembling compiled local series data arrays." });
    }
});

// GET: /api/series/episodes/search?q=air force wong&showFolder=Rick.and.Morty
router.get('/series/episodes/search', async (req, res) => {
    try {
        const query = String(req.query.q || '').trim();
        const showFolderFilter = String(req.query.showFolder || '').trim();
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 500));

        if (!query) {
            return res.status(400).json({ success: false, error: 'Missing search query.' });
        }

        const normalizedQuery = normalizeEpisodeSearchToken(query);
        const showFolders = [];

        if (showFolderFilter) {
            const showPath = path.join(SERIES_DIR, showFolderFilter);
            if (!fs.existsSync(showPath) || !fs.lstatSync(showPath).isDirectory()) {
                return res.status(404).json({ success: false, error: 'Show folder not found.' });
            }
            showFolders.push(showFolderFilter);
        } else if (fs.existsSync(SERIES_DIR)) {
            fs.readdirSync(SERIES_DIR, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
                .forEach(entry => showFolders.push(entry.name));
        }

        const results = [];
        for (const showFolder of showFolders) {
            const showPath = path.join(SERIES_DIR, showFolder);
            let seriesData;

            try {
                seriesData = rebuildSeriesManifest(showPath, {
                    showFolderName: showFolder,
                    write: false
                });
            } catch (_err) {
                continue;
            }

            const showTitle = readShowMetadataTitle(showPath, showFolder.replace(/[._-]/g, ' '));
            const seasons = seriesData.seasons || {};

            Object.keys(seasons).forEach(seasonKey => {
                const episodes = Array.isArray(seasons[seasonKey]?.episodes) ? seasons[seasonKey].episodes : [];
                episodes.forEach(ep => {
                    const episodeTitle = ep.title || '';
                    const localRelativePath = ep.localRelativePath || '';
                    const fileName = localRelativePath ? path.basename(localRelativePath) : '';

                    const haystack = normalizeEpisodeSearchToken([
                        episodeTitle,
                        fileName,
                        `season ${seasonKey}`,
                        `episode ${ep.episodeNumber}`
                    ].filter(Boolean).join(' '));

                    if (!haystack.includes(normalizedQuery)) return;

                    results.push({
                        showFolder,
                        showTitle,
                        seasonNumber: Number(seasonKey),
                        episodeNumber: Number(ep.episodeNumber),
                        episodeTitle: episodeTitle || `Episode ${ep.episodeNumber}`,
                        available: Boolean(ep.available),
                        localRelativePath: localRelativePath || null
                    });
                });
            });

            if (results.length >= limit) break;
        }

        results.sort((a, b) => {
            if (a.showTitle !== b.showTitle) return a.showTitle.localeCompare(b.showTitle);
            if (a.seasonNumber !== b.seasonNumber) return a.seasonNumber - b.seasonNumber;
            return a.episodeNumber - b.episodeNumber;
        });

        return res.json({
            success: true,
            query,
            count: Math.min(results.length, limit),
            items: results.slice(0, limit)
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// GET: /api/raw-file/:id (Lightweight Video Ranger Seek Pipeline)
router.get('/raw-file/:id', async (req, res) => {
    try {
        const movieId = decodeURIComponent(req.params.id);
        const folderPath = resolveMovieFolderPath(movieId);

        try {
            await fsPromises.access(folderPath);
        } catch {
            return res.status(404).send('Movie asset folder directory not found.');
        }

        const files = await fsPromises.readdir(folderPath);
        let videoFile = files.find(f => f.endsWith('.web.mp4')) || files.find(f => f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.m4v'));

        if (!videoFile) {
            return res.status(404).send('No playable video format container found.');
        }

        const fullVideoPath = path.join(folderPath, videoFile);
        const stat = await fsPromises.stat(fullVideoPath);
        const fileSize = stat.size;
        const range = req.headers.range;

        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type',
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4'
        };

        if (req.method === 'OPTIONS') {
            return res.writeHead(204, headers).end();
        }

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                ...headers,
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunksize,
            });
            fs.createReadStream(fullVideoPath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { ...headers, 'Content-Length': fileSize });
            fs.createReadStream(fullVideoPath).pipe(res);
        }
    } catch (err) {
        console.error("💣 Direct stream controller fault:", err);
        if (!res.headersSent) res.status(500).send('Internal static streaming pipeline error.');
    }
});

// GET: /api/subtitles/:id (Dynamic SRT-to-WebVTT Structural Sanitizer Engine)
router.get('/subtitles/:id', async (req, res) => {
    try {
        const movieId = decodeURIComponent(req.params.id);
        const folderPath = resolveMovieFolderPath(movieId);

        try {
            await fsPromises.access(folderPath);
        } catch {
            return res.status(404).send('Movie folder not found.');
        }

        const files = await fsPromises.readdir(folderPath);
        const srtFile = files.find(f => f.endsWith('.srt'));

        if (!srtFile) {
            return res.status(404).send('No subtitles found.');
        }

        const srtContent = await fsPromises.readFile(path.join(folderPath, srtFile), 'utf-8');

        let vttContent = "WEBVTT\n\n" + srtContent
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

        res.setHeader('Content-Type', 'text/vtt');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(200).send(vttContent);
    } catch (err) {
        console.error("💣 Subtitle engine failure:", err);
        res.status(500).send('Error processing subtitle asset.');
    }
});

module.exports = router;