const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Automatically read .env file from the project root directory
require('dotenv').config();

// =========================================================================
// CONFIGURATION & PATH ROUTING
// =========================================================================
const MOVIES_DIR = fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies';
const SERIES_DIR = path.join(MOVIES_DIR, 'series');
const MANIFEST_PATH = path.join(MOVIES_DIR, '.joshflix-manifest.json'); // FIXED: Defined tracking target globally

console.log(`\n==================================================`);
console.log(`🚀 Target directory initialized at state path: ${MOVIES_DIR}`);
console.log(`==================================================\n`);

const API_URL = 'http://www.omdbapi.com/?apikey=84196d01&t=';
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY;

// Whitelist of valid extensions we want to keep inside directories
const KEEP_EXTENSIONS = ['.mp4', '.mkv', '.m4v', '.avi', '.mov', '.srt', '.vtt', '.json', '.jpg', '.jpeg', '.png', '.ts'];

// =========================================================================
// STATE MANAGEMENT & MANIFEST ENGINE
// =========================================================================
function loadManifest() {
    if (fs.existsSync(MANIFEST_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
        } catch (e) {
            console.log("⚠️ Manifest tracking file corrupted. Initializing fresh index state.");
        }
    }
    return { lastRun: null, folders: {} };
}

function saveManifest(manifest) {
    manifest.lastRun = new Date().toISOString();
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 4));
}

// =========================================================================
// CORE UTILITY METHODS
// =========================================================================
async function downloadCover(url, destPath) {
    try {
        const response = await axios({ method: 'GET', url, responseType: 'stream' });
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (err) {
        console.error(`   ⚠️ Cover download skipped: ${err.message}`);
    }
}

async function fetchWithRetry(url, options, retries = 3, delay = 1500) {
    try {
        return await axios.get(url, options);
    } catch (err) {
        const is5xx = err.response && err.response.status >= 500;
        const is429 = err.response && err.response.status === 429;
        
        if ((is5xx || is429) && retries > 0) {
            console.log(`   ⚠️ API pressure encountered (${err.response.status}). Retrying in ${delay}ms... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retries - 1, delay * 2);
        }
        throw err;
    }
}

async function autoFetchSubtitlesPureJS(targetDirectory, officialTitle, officialYear) {
    const targetSrtPath = path.join(targetDirectory, 'English.srt');
    if (fs.existsSync(targetSrtPath)) return;
    if (!OPENSUBTITLES_API_KEY) return;

    await new Promise(resolve => setTimeout(resolve, 1200));

    try {
        console.log(`   🔍 Querying catalog for: "${officialTitle}" (${officialYear})...`);
        const searchUrl = `https://api.opensubtitles.com/api/v1/subtitles?query=${encodeURIComponent(officialTitle)}&year=${officialYear}&languages=en`;
        
        const response = await fetchWithRetry(searchUrl, {
            headers: {
                'Api-Key': OPENSUBTITLES_API_KEY,
                'User-Agent': 'Joshflix v1.0',
                'Accept': 'application/json'
            }
        });

        const subData = response.data.data;
        if (!subData || subData.length === 0) {
            console.log(`   ⚠️ No subtitle records matched on OpenSubtitles index.`);
            return;
        }

        const fileId = subData[0].attributes.files[0].file_id;
        const downloadRoute = 'https://api.opensubtitles.com/api/v1/download';

        const downloadRes = await axios.post(downloadRoute, { file_id: fileId }, {
            headers: {
                'Api-Key': OPENSUBTITLES_API_KEY,
                'User-Agent': 'Joshflix v1.0',
                'Content-Type': 'application/json'
            }
        });

        const srtDownloadUrl = downloadRes.data.link;
        const srtFileBuffer = await axios.get(srtDownloadUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(targetSrtPath, srtFileBuffer.data);
        console.log(`   🎯 Clean subtitle track successfully written to: English.srt`);
    } catch (err) {
        console.error(`   ❌ Subtitle pipeline skipped folder: ${err.message}`);
    }
}

function cleanReleaseName(folderName) {
    let title = folderName.replace(/\/+$/, '').replace(/\[.*?\]/g, '').replace(/\((.*?)\)/g, '$1');
    title = title.replace(/^www\.[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');
    title = title.replace(/^[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');

    const junkPatterns = [
        /[._-]v\d+/i, /[._-]v[eE]r\d+/i,
        /720p|1080p|2160p|4k/i,
        /HDTS|CAM|TS|TC|HDRip|WEBRip|BluRay|BRRip/i,
        /x264|x265|h264|hevc|AVC|AAC|MP3|DDP5\.1/i,
        /-[a-zA-Z0-9]+$/
    ];
    junkPatterns.forEach(pattern => title = title.replace(pattern, ''));

    const yearMatch = title.match(/(.*?)[._-\s](\d{4})/);
    let year = '';
    if (yearMatch) {
        title = yearMatch[1];
        year = yearMatch[2];
    }
    title = title.replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
    return { title, year };
}

function parseEpFromFilename(filename) {
    const match = filename.match(/s\s*(\d+)\s*e\s*(\d+)/i);
    if (match) {
        return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
    }
    return null;
}

function deleteFolderRecursive(directoryPath) {
    if (fs.existsSync(directoryPath)) {
        fs.readdirSync(directoryPath).forEach((file) => {
            const curPath = path.join(directoryPath, file);
            if (fs.lstatSync(curPath).isDirectory()) deleteFolderRecursive(curPath);
            else fs.unlinkSync(curPath);
        });
        fs.rmdirSync(directoryPath);
    }
}

// =========================================================================
// HIGH-LEVEL DELTA TUNED ORCHESTRATION PIPELINE
// =========================================================================
async function sanitizeLibrary() {
    console.log("🧹 Starting High-Performance Delta Sanitizer...\n");
    
    if (!fs.existsSync(MOVIES_DIR)) {
        console.error(`❌ Error: Main directory [${MOVIES_DIR}] not found.`);
        return;
    }

    const stateManifest = loadManifest();
    const currentRunFolders = {}; 
    
    let processedCount = 0;
    let skippedCount = 0;

    // --- PASS 1: MOVIES ---
    const rootItems = fs.readdirSync(MOVIES_DIR);
    for (const folder of rootItems) {
        let currentFolderPath = path.join(MOVIES_DIR, folder);
        if (folder.startsWith('.') || !fs.lstatSync(currentFolderPath).isDirectory()) continue;
        if (['sample', 'series'].includes(folder.toLowerCase())) continue; 

        const stats = fs.statSync(currentFolderPath);
        const folderKey = `movie:${folder}`;
        currentRunFolders[folderKey] = stats.mtimeMs;

        if (stateManifest.folders[folderKey] === stats.mtimeMs && fs.existsSync(path.join(currentFolderPath, 'metadata.json'))) {
            skippedCount++;
            continue; 
        }

        console.log(`\n🎬 [MOVIE DELTA DETECTED] Processing: "${folder}"`);
        await processMovieFolder(folder);
        processedCount++;
    }

    // --- PASS 2: SERIES ---
    if (fs.existsSync(SERIES_DIR)) {
        const seriesItems = fs.readdirSync(SERIES_DIR);
        for (const showFolder of seriesItems) {
            let currentShowPath = path.join(SERIES_DIR, showFolder);
            if (showFolder.startsWith('.') || !fs.lstatSync(currentShowPath).isDirectory()) continue;
            if (showFolder.toLowerCase() === 'sample') continue;

            const stats = fs.statSync(currentShowPath);
            const folderKey = `series:${showFolder}`;
            currentRunFolders[folderKey] = stats.mtimeMs;

            if (stateManifest.folders[folderKey] === stats.mtimeMs && fs.existsSync(path.join(currentShowPath, 'series.json'))) {
                skippedCount++;
                continue;
            }

            console.log(`\n📺 [SERIES DELTA DETECTED] Processing: "${showFolder}"`);
            await processTVShowFolder(showFolder);
            processedCount++;
        }
    }

    stateManifest.folders = currentRunFolders;
    saveManifest(stateManifest);

    console.log(`\n==================================================`);
    console.log(`🏁 SANITIZER PROCESSING CYCLE FINALIZED`);
    console.log(`⚡ Skipped (No local modifications): ${skippedCount}`);
    console.log(`🔧 Processed (Forced Sync Maps):     ${processedCount}`);
    console.log(`==================================================\n`);
}

/**
 * Worker A: Process Flat Movie Directories
 */
async function processMovieFolder(folderName) {
    let currentFolderPath = path.join(MOVIES_DIR, folderName);

    const innerContents = fs.readdirSync(currentFolderPath);
    innerContents.forEach(item => {
        const itemPath = path.join(currentFolderPath, item);
        const itemStat = fs.lstatSync(itemPath);
        if (itemStat.isDirectory()) {
            if (item.toLowerCase() === 'sample') deleteFolderRecursive(itemPath);
        } else {
            const ext = path.extname(item).toLowerCase();
            if (item.toLowerCase().includes('sample') && ext !== '.srt') fs.unlinkSync(itemPath);
            else if (!KEEP_EXTENSIONS.includes(ext)) fs.unlinkSync(itemPath);
        }
    });

    const { title: cleanTitle, year: parsedYear } = cleanReleaseName(folderName);
    const dotNotationTitle = cleanTitle.replace(/\s+/g, '.');
    const localStandardFolderName = parsedYear ? `${dotNotationTitle}.${parsedYear}` : dotNotationTitle;
    let activeFolderPath = currentFolderPath;

    if (folderName !== localStandardFolderName) {
        const targetFolderPath = path.join(MOVIES_DIR, localStandardFolderName);
        if (!fs.existsSync(targetFolderPath)) {
            fs.renameSync(currentFolderPath, targetFolderPath);
            console.log(`   🗂️  Folder Aligned: [${folderName}] ➡️ [${localStandardFolderName}]`);
            activeFolderPath = targetFolderPath; 
        } else {
            activeFolderPath = targetFolderPath;
        }
    }

    const metadataPath = path.join(activeFolderPath, 'metadata.json');
    const coverPath = path.join(activeFolderPath, 'cover.jpg');

    try {
        let officialTitle = cleanTitle;
        let officialYear = parsedYear || "Unknown";

        if (!fs.existsSync(metadataPath)) {
            const queryUrl = `${API_URL}${encodeURIComponent(cleanTitle.trim())}${parsedYear ? `&y=${parsedYear}` : ''}`;
            const res = await axios.get(queryUrl);

            if (res.data && res.data.Response === "True") {
                const data = res.data;
                officialTitle = data.Title;
                officialYear = data.Year;
                
                const metaPayload = {
                    title: data.Title,
                    year: data.Year,
                    plot: data.Plot,
                    runtime: data.Runtime,
                    genre: data.Genre,
                    rating: data.imdbRating,
                    contentType: 'movie'
                };
                fs.writeFileSync(metadataPath, JSON.stringify(metaPayload, null, 4));
                console.log(`   📝 Metadata Written: ${data.Title}`);

                if (!fs.existsSync(coverPath) && data.Poster && data.Poster !== "N/A") {
                    await downloadCover(data.Poster, coverPath);
                }
            } else {
                console.log(`   ⚠️ OMDb Miss. Creating manual skeleton fallback frames.`);
                const fallback = { title: cleanTitle, year: officialYear, plot: "Local track description context.", runtime: "N/A", genre: "Media Track", rating: "N/A", contentType: 'movie' };
                fs.writeFileSync(metadataPath, JSON.stringify(fallback, null, 4));
            }
        } else {
            try {
                let m = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                if (!m.contentType) { m.contentType = 'movie'; fs.writeFileSync(metadataPath, JSON.stringify(m, null, 4)); }
                officialTitle = m.title || officialTitle; officialYear = m.year || officialYear;
            } catch(e) {}
        }

        await autoFetchSubtitlesPureJS(activeFolderPath, officialTitle, officialYear);
    } catch (err) {
        console.error(`   ❌ Movie metadata tracking error:`, err.message);
    }
}

/**
 * Worker B: Process Deep Nested TV Show Structures
 */
async function processTVShowFolder(folderName) {
    let currentShowPath = path.join(SERIES_DIR, folderName);
    const { title: cleanTitle } = cleanReleaseName(folderName);
    const dotNotationTitle = cleanTitle.replace(/\s+/g, '.');
    
    let activeShowPath = currentShowPath;
    if (folderName !== dotNotationTitle) {
        const targetShowPath = path.join(SERIES_DIR, dotNotationTitle);
        if (!fs.existsSync(targetShowPath)) {
            fs.renameSync(currentShowPath, targetShowPath);
            console.log(`   🗂️  Show Root Aligned: [${folderName}] ➡️ [${dotNotationTitle}]`);
            activeShowPath = targetShowPath;
        } else {
            activeShowPath = targetShowPath;
        }
    }

    const metadataPath = path.join(activeShowPath, 'metadata.json');
    const coverPath = path.join(activeShowPath, 'cover.jpg');

    let mainMeta = { title: cleanTitle, year: '', plot: '', genre: '', contentType: 'series', imdbId: '' };
    let totalSeasons = 1;

    try {
        if (fs.existsSync(metadataPath)) {
            const existingMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            mainMeta = { ...mainMeta, ...existingMeta };
        }

        let queryUrl = `${API_URL}${encodeURIComponent(mainMeta.title)}&type=series`;
        if (mainMeta.imdbId) {
            queryUrl = `http://www.omdbapi.com/?apikey=84196d01&i=${mainMeta.imdbId}`;
        }

        const showRes = await axios.get(queryUrl);
        if (showRes.data && showRes.data.Response === "True") {
            mainMeta.title = showRes.data.Title;
            mainMeta.year = showRes.data.Year;
            mainMeta.plot = showRes.data.Plot;
            mainMeta.genre = showRes.data.Genre;
            mainMeta.contentType = 'series';
            totalSeasons = parseInt(showRes.data.totalSeasons, 10) || 1;

            fs.writeFileSync(metadataPath, JSON.stringify(mainMeta, null, 4));
            console.log(`   📝 High Level TV Metadata Synchronized: ${mainMeta.title}`);
        }
    } catch(err) {
        console.error("High level query sequence failure: ", err.message);
    }

    // --- RECONCILE AND HARVEST DISK FILES (HYBRID ROOT AND DEEP SUBFOLDER CAPABLE) ---
    const diskItems = fs.readdirSync(activeShowPath);
    let physicalFileMap = {}; 

    diskItems.forEach(item => {
        const itemPath = path.join(activeShowPath, item);
        const isDir = fs.lstatSync(itemPath).isDirectory();

        if (isDir) {
            // Process standard subfolder configurations (e.g., Season.1/)
            const files = fs.readdirSync(itemPath);
            files.forEach(file => {
                if (!KEEP_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
                    fs.unlinkSync(path.join(itemPath, file));
                    return;
                }
                const parseResults = parseEpFromFilename(file);
                if (parseResults) {
                    const lookupKey = `${parseResults.season}-${parseResults.episode}`;
                    physicalFileMap[lookupKey] = `series/${dotNotationTitle}/${item}/${file}`;
                }
            });
        } else {
            // FIXED: Structural support for flat root show files (e.g., Pluribus.S01/Pluribus.S01E01.mp4)
            if (!KEEP_EXTENSIONS.includes(path.extname(item).toLowerCase())) return;
            const parseResults = parseEpFromFilename(item);
            if (parseResults) {
                const lookupKey = `${parseResults.season}-${parseResults.episode}`;
                
                // Keep it cleanly matched even if assets sit at the top directory level
                physicalFileMap[lookupKey] = `series/${dotNotationTitle}/${item}`;
            }
        }
    });

    let maxPhysicalSeason = 1;
    Object.keys(physicalFileMap).forEach(key => {
        const [s] = key.split('-').map(Number);
        if (s > maxPhysicalSeason) maxPhysicalSeason = s;
    });

    const finalSeasonBounds = Math.max(totalSeasons, maxPhysicalSeason);
    let fullSeriesStructure = { totalSeasons: finalSeasonBounds.toString(), seasons: {} };

    for (let s = 1; s <= finalSeasonBounds; s++) {
        fullSeriesStructure.seasons[s] = { seasonNumber: s.toString(), episodes: [] };
        const apiMatchedNumbers = new Set();

        try {
            console.log(`   📡 Fetching metadata manifest for Season ${s}...`);
            const seasonRes = await axios.get(`${API_URL}${encodeURIComponent(mainMeta.title)}&Season=${s}`);
            
            if (seasonRes.data && seasonRes.data.Response === "True" && seasonRes.data.Episodes) {
                for (const ep of seasonRes.data.Episodes) {
                    const epNum = parseInt(ep.Episode, 10);
                    if (isNaN(epNum)) continue;
                    
                    apiMatchedNumbers.add(epNum);
                    const lookupKey = `${s}-${epNum}`;
                    const isAvailable = !!physicalFileMap[lookupKey];

                    fullSeriesStructure.seasons[s].episodes.push({
                        episodeNumber: epNum,
                        title: ep.Title || `Episode ${epNum}`,
                        released: ep.Released || 'Unknown',
                        plot: `Official Season ${s} episodic content description framework.`,
                        imdbRating: ep.imdbRating || 'N/A',
                        available: isAvailable,
                        localRelativePath: isAvailable ? physicalFileMap[lookupKey] : null
                    });
                }
            }
        } catch (err) {
            console.log(`   ⚠️ Network bottleneck or unlisted index for Season ${s}. Relying entirely on disk inventory.`);
        }

        Object.keys(physicalFileMap).forEach(key => {
            const [discSeason, discEpisode] = key.split('-').map(Number);
            if (discSeason === s && !apiMatchedNumbers.has(discEpisode)) {
                console.log(`   🔧 Injecting local physical track asset: [S${s}E${discEpisode}]`);
                fullSeriesStructure.seasons[s].episodes.push({
                    episodeNumber: discEpisode,
                    title: `Episode ${discEpisode} (Local Source)`,
                    released: 'Unknown',
                    plot: 'Local disk file asset tracking fallback.',
                    imdbRating: 'N/A',
                    available: true,
                    localRelativePath: physicalFileMap[key]
                });
            }
        });

        fullSeriesStructure.seasons[s].episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
    }

    fs.writeFileSync(path.join(activeShowPath, 'series.json'), JSON.stringify(fullSeriesStructure, null, 4));
    console.log(`   💾 Complete structural configuration profile updated: series.json`);
}

sanitizeLibrary();