const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Automatically read .env file from the project root directory
require('dotenv').config();

// CONFIGURATION
const MOVIES_DIR = fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies';
const SERIES_DIR = path.join(MOVIES_DIR, 'series');

console.log(`\n==================================================`);
console.log(`🚀 Target directory initialized at state path: ${MOVIES_DIR}`);
console.log(`==================================================\n`);

const API_URL = 'http://www.omdbapi.com/?apikey=84196d01&t=';

// --- OPEN_SUBTITLES CONFIGURATION LAYER FROM RUNTIME ENVIRONMENT ---
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY;

// Whitelist of valid extensions we want to keep inside directories
const KEEP_EXTENSIONS = ['.mp4', '.mkv', '.m4v', '.avi', '.mov', '.srt', '.vtt', '.json', '.jpg', '.jpeg', '.png', '.ts'];

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

/**
 * Executes a network call with an exponential backoff safety net for 5xx/429 errors.
 */
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

    if (fs.existsSync(targetSrtPath)) {
        return;
    }

    if (!OPENSUBTITLES_API_KEY) {
        return;
    }

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

// Regex to extract season and episode numbers from video filenames
function parseEpFromFilename(filename) {
    const match = filename.match(/s\s*(\d+)\s*e\s*(\d+)/i);
    if (match) {
        return {
            season: parseInt(match[1], 10),
            episode: parseInt(match[2], 10)
        };
    }
    return null;
}

function deleteFolderRecursive(directoryPath) {
    if (fs.existsSync(directoryPath)) {
        fs.readdirSync(directoryPath).forEach((file) => {
            const curPath = path.join(directoryPath, file);
            if (fs.lstatSync(curPath).isDirectory()) {
                deleteFolderRecursive(curPath);
            } else {
                fs.unlinkSync(curPath); 
            }
        });
        fs.rmdirSync(directoryPath); 
    }
}

// Helper to map files manually if OMDb API data is missing or incomplete for a season
function generateSkeletonSeason(seasonNum, structure, physicalFileMap) {
    Object.keys(physicalFileMap).forEach(key => {
        const [s, e] = key.split('-').map(Number);
        if (s === seasonNum) {
            structure.seasons[seasonNum].episodes.push({
                episodeNumber: e,
                title: `Episode ${e}`,
                released: 'Unknown',
                plot: 'No internet overview map file processed.',
                imdbRating: 'N/A',
                available: true,
                localRelativePath: physicalFileMap[key]
            });
        }
    });
    structure.seasons[seasonNum].episodes.sort((a,b) => a.episodeNumber - b.episodeNumber);
}

// =========================================================================
// MAIN ORCHESTRATION PIPELINE RUNNER
// =========================================================================
async function sanitizeLibrary() {
    console.log("🧹 Starting Resilient Multi-Tier Library Sanitizer...\n");
    
    if (!fs.existsSync(MOVIES_DIR)) {
        console.error(`❌ Error: Main directory [${MOVIES_DIR}] not found.`);
        return;
    }

    // =========================================================================
    // PASS 1: SANITIZE MOVIES (MAIN ROOT DIRECTORY)
    // =========================================================================
    const rootItems = fs.readdirSync(MOVIES_DIR);

    for (const folder of rootItems) {
        let currentFolderPath = path.join(MOVIES_DIR, folder);
        
        if (folder.startsWith('.') || !fs.lstatSync(currentFolderPath).isDirectory()) continue;
        if (['sample', 'series'].includes(folder.toLowerCase())) continue; 

        console.log(`\n🎬 [MOVIE PASS] Processing: "${folder}"`);
        await processMovieFolder(folder);
    }

    // =========================================================================
    // PASS 2: SANITIZE SERIES (TV RECURSIVE DISK LAYER ENGINE)
    // =========================================================================
    if (fs.existsSync(SERIES_DIR)) {
        const seriesItems = fs.readdirSync(SERIES_DIR);

        for (const showFolder of seriesItems) {
            let currentShowPath = path.join(SERIES_DIR, showFolder);
            
            if (showFolder.startsWith('.') || !fs.lstatSync(currentShowPath).isDirectory()) continue;
            if (showFolder.toLowerCase() === 'sample') continue;

            console.log(`\n📺 [SERIES PASS] Processing: "${showFolder}"`);
            await processTVShowFolder(showFolder);
        }
    }

    console.log("\n🏁 Sanitization processing execution cycles finalized successfully.");
}

/**
 * Worker A: Process Flat Movie Directories
 */
async function processMovieFolder(folderName) {
    let currentFolderPath = path.join(MOVIES_DIR, folderName);

    // 1. Purge Samples and junk extensions
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

    // 2. Realignment down to standard naming schemes
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

    // 3. Gather Metadata Blocks
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
                console.log(`   📝 Metadata Written: ${data.Title} (movie)`);

                if (!fs.existsSync(coverPath) && data.Poster && data.Poster !== "N/A") {
                    await downloadCover(data.Poster, coverPath);
                }
            } else {
                console.log(`   ⚠️ OMDb Miss. Creating manual skeleton fallback tracking frames.`);
                const fallback = { title: cleanTitle, year: officialYear, plot: "Local track description context.", runtime: "N/A", genre: "Media Track", rating: "N/A", contentType: 'movie' };
                fs.writeFileSync(metadataPath, JSON.stringify(fallback, null, 4));
            }
        } else {
            // Read self-healing property check
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
    
    // 1. Structural Folder Realignment (e.g. "Rick.and.Morty")
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

    // 2. Resolve High Level Series Profiles 
    let mainMeta = { title: cleanTitle, year: '', plot: '', genre: '', contentType: 'series' };
    let totalSeasons = 1;

    try {
        if (!fs.existsSync(metadataPath)) {
            const showRes = await axios.get(`${API_URL}${encodeURIComponent(cleanTitle)}&type=series`);
            if (showRes.data && showRes.data.Response === "True") {
                mainMeta.title = showRes.data.Title;
                mainMeta.year = showRes.data.Year;
                mainMeta.plot = showRes.data.Plot;
                mainMeta.genre = showRes.data.Genre;
                mainMeta.contentType = 'series';
                totalSeasons = parseInt(showRes.data.totalSeasons, 10) || 1;

                fs.writeFileSync(metadataPath, JSON.stringify(mainMeta, null, 4));
                console.log(`   📝 High Level TV Metadata Written: ${mainMeta.title}`);

                if (!fs.existsSync(coverPath) && showRes.data.Poster && showRes.data.Poster !== "N/A") {
                    await downloadCover(showRes.data.Poster, coverPath);
                }
            } else {
                console.log(`   ⚠️ OMDb High Level Miss for Series. Writing fallback profile framework wrapper.`);
                fs.writeFileSync(metadataPath, JSON.stringify(mainMeta, null, 4));
            }
        } else {
            const existingMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            mainMeta = { ...mainMeta, ...existingMeta };
            
            // Re-fetch total seasons bounds count context from API dynamically to verify completeness
            const countCheck = await axios.get(`${API_URL}${encodeURIComponent(mainMeta.title)}&type=series`);
            totalSeasons = parseInt(countCheck.data.totalSeasons, 10) || 1;
        }
    } catch (err) {
        console.error(`   ❌ Failed querying high level show parameters:`, err.message);
    }

    // 3. Recursively Scan Sub-directories to Map Existing Files
    const diskItems = fs.readdirSync(activeShowPath);
    let physicalFileMap = {}; 

    diskItems.forEach(item => {
        const itemPath = path.join(activeShowPath, item);
        if (!fs.lstatSync(itemPath).isDirectory()) return;

        const files = fs.readdirSync(itemPath);
        files.forEach(file => {
            if (!KEEP_EXTENSIONS.includes(path.extname(file).toLowerCase())) {
                fs.unlinkSync(path.join(itemPath, file)); // Enforce keeping directories completely clean of tracking junk
                return;
            }
            
            const parseResults = parseEpFromFilename(file);
            if (parseResults) {
                const lookupKey = `${parseResults.season}-${parseResults.episode}`;
                // Keep paths completely consistent with express route static resolutions
                physicalFileMap[lookupKey] = `series/${dotNotationTitle}/${item}/${file}`;
            }
        });
    });

    // 4. Construct Complete Nested Season/Episode Matrix Blueprint Manifest
    let fullSeriesStructure = { totalSeasons: totalSeasons.toString(), seasons: {} };

    for (let s = 1; s <= totalSeasons; s++) {
        fullSeriesStructure.seasons[s] = { seasonNumber: s.toString(), episodes: [] };

        try {
            const seasonRes = await axios.get(`${API_URL}${encodeURIComponent(mainMeta.title)}&Season=${s}`);
            
            if (seasonRes.data && seasonRes.data.Response === "True" && seasonRes.data.Episodes) {
                // Track which episode numbers the API successfully found
                const apiMatchedNumbers = new Set();

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

                // =========================================================================
                // CRITICAL FALLBACK LAYER: Reconcile missing local physical files
                // =========================================================================
                Object.keys(physicalFileMap).forEach(key => {
                    const [discSeason, discEpisode] = key.split('-').map(Number);
                    
                    // If we have it on disk for this season, but OMDb completely left it out of the API response
                    if (discSeason === s && !apiMatchedNumbers.has(discEpisode)) {
                        console.log(`   🔧 API Omission Detected: Injecting local fallback track entry [S${s}E${discEpisode}]`);
                        fullSeriesStructure.seasons[s].episodes.push({
                            episodeNumber: discEpisode,
                            title: `Episode ${discEpisode} (Unlisted Source)`,
                            released: 'Unknown',
                            plot: 'Local disk file asset tracking fallback.',
                            imdbRating: 'N/A',
                            available: true,
                            localRelativePath: physicalFileMap[key]
                        });
                    }
                });

                // Keep everything in clean numerical numerical sorting order
                fullSeriesStructure.seasons[s].episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);

            } else {
                console.log(`   ⚠️ No official online records for Season ${s}. Generating standard skeleton matrix.`);
                generateSkeletonSeason(s, fullSeriesStructure, physicalFileMap);
            }
        } catch (err) {
            console.log(`   ⚠️ Network bottleneck parsing Season ${s}. Reverting to local disk discovery.`);
            generateSkeletonSeason(s, fullSeriesStructure, physicalFileMap);
        }
    }

    // Write final unified layout track configuration directly onto disk arrays
    fs.writeFileSync(path.join(activeShowPath, 'series.json'), JSON.stringify(fullSeriesStructure, null, 4));
    console.log(`   💾 Unified deep matrix profile successfully saved down: series.json`);
}

sanitizeLibrary();