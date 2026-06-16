const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Automatically read .env file from the project root directory
require('dotenv').config();

// CONFIGURATION
const MOVIES_DIR = fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies';

console.log(`🎬 Target directory initialized at state path: ${MOVIES_DIR}`);
const API_URL = 'http://www.omdbapi.com/?apikey=84196d01&t=';

// --- OPEN_SUBTITLES CONFIGURATION LAYER FROM RUNTIME ENVIRONMENT ---
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY;
const OPENSUBTITLES_USERNAME = process.env.OPENSUBTITLES_USERNAME;
const OPENSUBTITLES_PASSWORD = process.env.OPENSUBTITLES_PASSWORD;

// Whitelist of valid extensions we want to keep inside a movie directory
const KEEP_EXTENSIONS = ['.mp4', '.mkv', '.m4v', '.avi', '.mov', '.srt', '.vtt', '.json', '.jpg', '.jpeg', '.png'];

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
        console.error(`⚠️  Cover download skipped: ${err.message}`);
    }git
}

// --- STREAMLINED DEV-MODE SUBTITLE RETRIEVAL ENGINE ---
//const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY;
// --- HARDENED DEV-MODE SUBTITLE RETRIEVAL ENGINE WITH RETRY LOGIC ---

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
        console.log(`   ℹ️ Subtitles already verified locally.`);
        return;
    }

    if (!OPENSUBTITLES_API_KEY) {
        console.log(`   ⚠️ Skipping subtitles: OPENSUBTITLES_API_KEY missing from environment.`);
        return;
    }

    // Base pacing delay between folders to respect the global API gateway threshold
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

        // Step 2: Fetch the secure download URL with safety wrappers
        const downloadRes = await axios.post(downloadRoute, { file_id: fileId }, {
            headers: {
                'Api-Key': OPENSUBTITLES_API_KEY,
                'User-Agent': 'Joshflix v1.0',
                'Content-Type': 'application/json'
            }
        });

        const srtDownloadUrl = downloadRes.data.link;

        // Step 3: Stream content to file storage
        const srtFileBuffer = await axios.get(srtDownloadUrl, { responseType: 'arraybuffer' });
        fs.writeFileSync(targetSrtPath, srtFileBuffer.data);

        console.log(`   🎯 Clean subtitle track successfully written to: English.srt`);

    } catch (err) {
        if (err.response) {
            console.error(`   ❌ Subtitle pipeline skipped folder [Status ${err.response.status}]: Server busy.`);
        } else {
            console.error(`   ❌ Subtitle pipeline skipped folder [Error]: ${err.message}`);
        }
        // Catching the error here safely allows the outer 'for' loop in sanitizeLibrary() 
        // to cleanly slide into the next movie asset instead of aborting the process execution entirely!
    }
}

function cleanReleaseName(folderName) {
    let title = folderName;

    // 1. Strip trailing slashes
    title = title.replace(/\/+$/, '');

    // 2. Strip brackets and everything inside them: [Y.BZ], [1080p]
    title = title.replace(/\[.*?\]/g, '');

    // FIX: Strip literal parentheses but KEEP the text inside if it's NOT a year
    title = title.replace(/\((.*?)\)/g, '$1');

    // 3. Strip common web domain advertisements
    title = title.replace(/^www\.[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');
    title = title.replace(/^[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');

    // 4. Erase scene junk words
    const junkPatterns = [
        /[._-]v\d+/i, /[._-]v[eE]r\d+/i,
        /720p|1080p|2160p|4k/i,
        /HDTS|CAM|TS|TC|HDRip|WEBRip|BluRay|BRRip/i,
        /x264|x265|h264|hevc|AVC|AAC|MP3|DDP5\.1/i,
        /-[a-zA-Z0-9]+$/
    ];
    junkPatterns.forEach(pattern => title = title.replace(pattern, ''));

    // 5. Extract title and year (Handles both "Title.2026" and "Title 2026")
    const yearMatch = title.match(/(.*?)[._-\s](\d{4})/);
    let year = '';
    if (yearMatch) {
        title = yearMatch[1];
        year = yearMatch[2];
    }

    // 6. Clean up punctuation, convert dots/underscores to spaces, and remove double spaces
    title = title.replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
    
    return { title, year };
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

async function sanitizeLibrary() {
    console.log("🧹 Starting Complete Library Media Sanitizer & Data Scraper...\n");
    
    if (!fs.existsSync(MOVIES_DIR)) {
        console.error(`❌ Error: Main directory [${MOVIES_DIR}] not found.`);
        return;
    }

    const folders = fs.readdirSync(MOVIES_DIR);

    for (const folder of folders) {
        let currentFolderPath = path.join(MOVIES_DIR, folder);
        if (folder.startsWith('.') || !fs.lstatSync(currentFolderPath).isDirectory()) continue;
        if (folder.toLowerCase() === 'sample') continue;

        console.log(`\n==================================================`);
        console.log(`📁 Processing: "${folder}"`);
        console.log(`==================================================`);

        // -----------------------------------------------------------------
        // STEP 1: PURGE SAMPLES AND JUNK FILES
        // -----------------------------------------------------------------
        const innerContents = fs.readdirSync(currentFolderPath);
        
        innerContents.forEach(item => {
            const itemPath = path.join(currentFolderPath, item);
            const itemStat = fs.lstatSync(itemPath);

            if (itemStat.isDirectory()) {
                if (item.toLowerCase() === 'sample') {
                    console.log(`🗑️  Purging directory branch: /Sample`);
                    deleteFolderRecursive(itemPath);
                }
            } else {
                const ext = path.extname(item).toLowerCase();
                if (item.toLowerCase().includes('sample') && ext !== '.srt') {
                    console.log(`🗑️  Deleting loose preview sample: ${item}`);
                    fs.unlinkSync(itemPath);
                }
                else if (!KEEP_EXTENSIONS.includes(ext)) {
                    console.log(`🗑️  Purging junk asset file: ${item}`);
                    fs.unlinkSync(itemPath);
                }
            }
        });

        // -----------------------------------------------------------------
        // STEP 2: IMMEDIATE LOCAL CLEAN & RENAME (PREPARE DISK STATE)
        // -----------------------------------------------------------------
        const { title: cleanTitle, year: parsedYear } = cleanReleaseName(folder);
        
        const dotNotationTitle = cleanTitle.replace(/\s+/g, '.');
        const localStandardFolderName = parsedYear ? `${dotNotationTitle}.${parsedYear}` : dotNotationTitle;
        let activeFolderPath = currentFolderPath;

        if (folder !== localStandardFolderName) {
            const targetFolderPath = path.join(MOVIES_DIR, localStandardFolderName);
            
            if (!fs.existsSync(targetFolderPath)) {
                fs.renameSync(currentFolderPath, targetFolderPath);
                console.log(`🗂️  Folder Renamed Locally: [${folder}] ➡️  [${localStandardFolderName}]`);
                activeFolderPath = targetFolderPath; 
            } else {
                console.log(`⚠️  Destination [${localStandardFolderName}] already exists. Shifting target pointer.`);
                activeFolderPath = targetFolderPath;
            }
        }

        // -----------------------------------------------------------------
        // STEP 3: METADATA, COVER ART, & SUBTITLE GENERATION
        // -----------------------------------------------------------------
        const metadataPath = path.join(activeFolderPath, 'metadata.json');
        const coverPath = path.join(activeFolderPath, 'cover.jpg');

        // Check if metadata already exists to avoid redundant lookups
        let metadataAlreadyExists = fs.existsSync(metadataPath);

        try {
            const apiSearchQuery = cleanTitle.trim();
            const queryUrl = `${API_URL}${encodeURIComponent(apiSearchQuery)}${parsedYear ? `&y=${parsedYear}` : ''}`;
            
            let officialTitle = cleanTitle;
            let officialYear = parsedYear || "Unknown";

            if (!metadataAlreadyExists) {
                console.log(`🔍 Dispatching OMDb lookup query: "${apiSearchQuery}" (${parsedYear || 'N/A'})`);
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
                        rating: data.imdbRating
                    };

                    fs.writeFileSync(metadataPath, JSON.stringify(metaPayload, null, 4));
                    console.log(`📝 Metadata generated: ${data.Title} (${data.Year})`);

                    if (!fs.existsSync(coverPath) && data.Poster && data.Poster !== "N/A") {
                        console.log(`📥 Downloading cover image...`);
                        await downloadCover(data.Poster, coverPath);
                    }

                    // Handle OMDb capitalization sync and folder refinement
                    const apiStandardizedTitle = data.Title.replace(/[/\\?%*:|"<>\s]+/g, '.');
                    const apiFolderName = `${apiStandardizedTitle}.${data.Year}`;
                    const apiFolderPath = path.join(MOVIES_DIR, apiFolderName);

                    if (localStandardFolderName !== apiFolderName && !fs.existsSync(apiFolderPath)) {
                        fs.renameSync(activeFolderPath, apiFolderPath);
                        console.log(`🗂️  Refining folder alignment to OMDb Casing: [${localStandardFolderName}] ➡️  [${apiFolderName}]`);
                        activeFolderPath = apiFolderPath;
                    }
                    
                } else {
                    console.log(`⚠️  OMDb lookup missed. Formatting local fallback descriptors.`);
                    const titleCapitalized = cleanTitle.replace(/\b\w/g, c => c.toUpperCase());
                    
                    const fallbackPayload = {
                        title: titleCapitalized,
                        year: parsedYear || "Unknown",
                        plot: "Local video data mapping index.",
                        runtime: "N/A",
                        genre: "Media Asset",
                        rating: "N/A"
                    };
                    fs.writeFileSync(metadataPath, JSON.stringify(fallbackPayload, null, 4));
                }
            } else {
                // If metadata exists, extract the verified names to keep subtitle queries pristine
                console.log(`✨ Metadata index file already verified for target folder.`);
                try {
                    const existingMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                    officialTitle = existingMeta.title || officialTitle;
                    officialYear = existingMeta.year || officialYear;
                } catch(e) {}
            }

            // --- RUN SUBTITLE PROCESSING PIPELINE ---
            // Triggers seamlessly inside Step 3 for clean folder structure management
            await autoFetchSubtitlesPureJS(activeFolderPath, officialTitle, officialYear);

        } catch (err) {
            console.error(`❌ Sanitizer processing fault on folder execution:`, err.message);
        }
    }
    console.log("\n🏁 Sanitization complete! Your library storage space is perfectly scrubbed.");
}

sanitizeLibrary();