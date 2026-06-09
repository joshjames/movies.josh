const fs = require('fs');
const path = require('path');
const axios = require('axios');

// CONFIGURATION
const MOVIES_DIR = path.resolve('/home/epic/movies');
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

    // 1. Strip trailing slashes if passed from directory strings manually
    title = title.replace(/\/+$/, '');

    // 2. CRITICAL: Strip any brackets and everything inside them (e.g., [Y.BZ], [], [1080p])
    title = title.replace(/\[.*?\]/g, '');

    // 3. Strip common web domain advertisements at the front
    title = title.replace(/^www\.[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');
    title = title.replace(/^[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');

    // 4. Erase common scene/torrent release junk words case-insensitively
    const junkPatterns = [
        /[._-]v\d+/i, /[._-]v[eE]r\d+/i,
        /720p|1080p|2160p|4k/i,
        /HDTS|CAM|TS|TC|HDRip|WEBRip|BluRay|BRRip/i,
        /x264|x265|h264|hevc|AVC|AAC|MP3|DDP5\.1/i,
        /-[a-zA-Z0-9]+$/
    ];
    junkPatterns.forEach(pattern => title = title.replace(pattern, ''));

    // 5. Extract title and year if present
    const yearMatch = title.match(/(.*?)[._-](\d{4})/);
    let year = '';
    if (yearMatch) {
        title = yearMatch[1];
        year = yearMatch[2];
    }

    // 6. Clean up punctuation, trailing dots, and double spacing
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
                // Vaporize Sample directories completely
                if (item.toLowerCase() === 'sample') {
                    console.log(`🗑️  Purging directory branch: /Sample`);
                    deleteFolderRecursive(itemPath);
                }
            } else {
                const ext = path.extname(item).toLowerCase();
                // Check if the file name itself flags it as a preview snippet sample
                if (item.toLowerCase().includes('sample') && ext !== '.srt') {
                    console.log(`🗑️  Deleting loose preview sample: ${item}`);
                    fs.unlinkSync(itemPath);
                }
                // Wipe advertisement links, torrent text logs, and scene notes (.txt, .nfo)
                else if (!KEEP_EXTENSIONS.includes(ext)) {
                    console.log(`🗑️  Purging junk asset file: ${item}`);
                    fs.unlinkSync(itemPath);
                }
            }
        });

        // -----------------------------------------------------------------
        // STEP 2: METADATA & COVER ART GENERATION
        // -----------------------------------------------------------------
        const { title: cleanTitle, year: parsedYear } = cleanReleaseName(folder);
        let finalFolderName = folder;

        try {
            const queryUrl = `${API_URL}${encodeURIComponent(cleanTitle)}${parsedYear ? `&y=${parsedYear}` : ''}`;
            const res = await axios.get(queryUrl);
            
            const metadataPath = path.join(currentFolderPath, 'metadata.json');
            const coverPath = path.join(currentFolderPath, 'cover.jpg');

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

                const sanitizedTitle = data.Title.replace(/[/\\?%*:|"<>\s]+/g, '.');
                finalFolderName = `${sanitizedTitle}.${data.Year}`;
            } else {
                console.log(`⚠️  OMDb lookup missed. Formatting local fallback descriptors.`);
                const formattedTitle = cleanTitle.replace(/\s+/g, '.').replace(/\b\w/g, c => c.toUpperCase());
                finalFolderName = parsedYear ? `${formattedTitle}.${parsedYear}` : formattedTitle;

                const fallbackPayload = {
                    title: cleanTitle.replace(/\b\w/g, c => c.toUpperCase()),
                    year: parsedYear || "Unknown",
                    plot: "Local video data mapping index.",
                    runtime: "N/A",
                    genre: "Media Asset",
                    rating: "N/A"
                };
                fs.writeFileSync(metadataPath, JSON.stringify(fallbackPayload, null, 4));
            }

            // -----------------------------------------------------------------
            // STEP 3: PHYSICAL FOLDER TIDY/RENAME
            // -----------------------------------------------------------------
            if (folder !== finalFolderName) {
                const destinationFolderPath = path.join(MOVIES_DIR, finalFolderName);
                
                if (!fs.existsSync(destinationFolderPath)) {
                    fs.renameSync(currentFolderPath, destinationFolderPath);
                    console.log(`🗂️  Folder Renamed: [${folder}] ➡️  [${finalFolderName}]`);
                } else {
                    console.log(`⚠️  Destination [${finalFolderName}] already exists on storage array. Skipping rename.`);
                }
            }

        } catch (err) {
            console.error(`❌ Sanitizer processing fault on [${folder}]:`, err.message);
        }
    }
    console.log("\n🏁 Sanitization complete! Your library storage space is perfectly scrubbed.");
}

sanitizeLibrary();