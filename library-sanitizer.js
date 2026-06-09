const fs = require('fs');
const path = require('path');
const axios = require('axios');

// CONFIGURATION
const MOVIES_DIR = fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies';

console.log(`🎬 Target directory initialized at state path: ${MOVIES_DIR}`);
const API_URL = 'http://www.omdbapi.com/?apikey=84196d01&t=';

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
    }
}

function cleanReleaseName(folderName) {
    let title = folderName;

    // 1. Strip trailing slashes
    title = title.replace(/\/+$/, '');

    // 2. Strip brackets and everything inside them: [Y.BZ], [1080p]
    title = title.replace(/\[.*?\]/g, '');

    // FIX: Strip literal parentheses but KEEP the text inside if it's NOT a year
    // This removes the wrapper entirely so the year extractor below can hit it cleanly
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

// Helper tool to vaporize an entire directory branch (like Sample folders) safely
function deleteFolderRecursive(directoryPath) {
    if (fs.existsSync(directoryPath)) {
        fs.readdirSync(directoryPath).forEach((file) => {
            const curPath = path.join(directoryPath, file);
            if (fs.lstatSync(curPath).isDirectory()) {
                deleteFolderRecursive(curPath);
            } else {
                fs.unlinkSync(curPath); // Delete file
            }
        });
        fs.rmdirSync(directoryPath); // Delete directory
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
        
        // Structure our clean local directory pattern: "Movie.Title.Year"
        const dotNotationTitle = cleanTitle.replace(/\s+/g, '.');
        const localStandardFolderName = parsedYear ? `${dotNotationTitle}.${parsedYear}` : dotNotationTitle;
        let activeFolderPath = currentFolderPath;

        if (folder !== localStandardFolderName) {
            const targetFolderPath = path.join(MOVIES_DIR, localStandardFolderName);
            
            if (!fs.existsSync(targetFolderPath)) {
                fs.renameSync(currentFolderPath, targetFolderPath);
                console.log(`🗂️  Folder Renamed Locally: [${folder}] ➡️  [${localStandardFolderName}]`);
                // CRITICAL POINTER UPDATE: Update our tracking variable to point to the new disk home!
                activeFolderPath = targetFolderPath; 
            } else {
                console.log(`⚠️  Destination [${localStandardFolderName}] already exists. Shifting target pointer.`);
                activeFolderPath = targetFolderPath;
            }
        }

        // -----------------------------------------------------------------
        // STEP 3: METADATA & COVER ART GENERATION (VIA CLEAN STRINGS)
        // -----------------------------------------------------------------
        const metadataPath = path.join(activeFolderPath, 'metadata.json');
        const coverPath = path.join(activeFolderPath, 'cover.jpg');

        // Skip scraping if metadata already exists from a prior pass
        if (fs.existsSync(metadataPath)) {
            console.log(`✨ Metadata index file already verified for target folder.`);
            continue;
        }

        try {
            // Use the pristine text representation without dots or brackets for OMDb API efficiency
            const apiSearchQuery = cleanTitle.trim();
            const queryUrl = `${API_URL}${encodeURIComponent(apiSearchQuery)}${parsedYear ? `&y=${parsedYear}` : ''}`;
            
            console.log(`🔍 Dispatching OMDb lookup query: "${apiSearchQuery}" (${parsedYear || 'N/A'})`);
            const res = await axios.get(queryUrl);

            if (res.data && res.data.Response === "True") {
                const data = res.data;
                
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

                // OPTIONAL PARITY RE-ALIGNMENT: 
                // If you want the folder name to match the official case-sensitive casing from OMDb API exactly
                const apiStandardizedTitle = data.Title.replace(/[/\\?%*:|"<>\s]+/g, '.');
                const apiFolderName = `${apiStandardizedTitle}.${data.Year}`;
                const apiFolderPath = path.join(MOVIES_DIR, apiFolderName);

                if (localStandardFolderName !== apiFolderName && !fs.existsSync(apiFolderPath)) {
                    fs.renameSync(activeFolderPath, apiFolderPath);
                    console.log(`🗂️  Refining folder alignment to OMDb Casing: [${localStandardFolderName}] ➡️  [${apiFolderName}]`);
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

        } catch (err) {
            console.error(`❌ Sanitizer processing fault on [${localStandardFolderName}]:`, err.message);
        }
    }
    console.log("\n🏁 Sanitization complete! Your library storage space is perfectly scrubbed.");
}

sanitizeLibrary();