const fs = require('fs');
const path = require('path');
const axios = require('axios');

const MOVIES_DIR = path.resolve('/home/epic/movies');
// Put your working API key here
const API_URL = 'http://www.omdbapi.com/?apikey=84196d01&t=';

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
        console.error(`⚠️ Cover download skipped: ${err.message}`);
    }
}

function cleanReleaseName(folderName) {
    let title = folderName;

    // 1. Strip common web domain advertisements at the front
    title = title.replace(/^www\.[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');
    title = title.replace(/^[a-zA-Z0-9-]+\.[a-block|org|net|com|cc|tv|me]+\s*-\s*/i, '');

    // 2. Erase common scene/torrent release junk words case-insensitively
    const junkPatterns = [
        /[._-]v\d+/i, /[._-]v[eE]r\d+/i,                // V2, V3, Ver2
        /720p|1080p|2160p|4k/i,                        // Resolutions
        /HDTS|CAM|TS|TC|HDRip|WEBRip|BluRay|BRRip/i,   // Sources
        /x264|x265|h264|hevc|AVC|AAC|MP3|DDP5\.1/i,    // Codecs
        /-[a-zA-Z0-9]+$/                               // Trailing release group tags (e.g. -DkS)
    ];

    junkPatterns.forEach(pattern => {
        title = title.replace(pattern, '');
    });

    // 3. Extract title and year if present
    const yearMatch = title.match(/(.*?)[._-](\d{4})/);
    let year = '';
    if (yearMatch) {
        title = yearMatch[1];
        year = yearMatch[2];
    }

    // 4. Clean up punctuation and spacing
    title = title.replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();

    return { title, year };
}

async function grabMetadata() {
    console.log("🎬 Starting Advanced Filename-Filtered Metadata Scan...");
    const folders = fs.readdirSync(MOVIES_DIR);

    for (const folder of folders) {
        const folderPath = path.join(MOVIES_DIR, folder);
        if (folder.startsWith('.') || !fs.lstatSync(folderPath).isDirectory()) continue;
        
        // Skip sample directories entirely
        if (folder.toLowerCase() === 'sample') continue;

        const metadataPath = path.join(folderPath, 'metadata.json');
        const coverPath = path.join(folderPath, 'cover.jpg');

        // Execute the string cleaning pipeline
        const { title: cleanTitle, year: parsedYear } = cleanReleaseName(folder);
        console.log(`\n🔍 Raw Folder:  "${folder}"`);
        console.log(`🎯 Searching OMDb: "${cleanTitle}" ${parsedYear ? `(${parsedYear})` : ''}`);

        try {
            // Include year in API query if we successfully pulled one to guarantee accuracy
            const queryUrl = `${API_URL}${encodeURIComponent(cleanTitle)}${parsedYear ? `&y=${parsedYear}` : ''}`;
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
                console.log(`📝 Locked: ${data.Title} (${data.Year})`);

                if (!fs.existsSync(coverPath) && data.Poster && data.Poster !== "N/A") {
                    await downloadCover(data.Poster, coverPath);
                    console.log(`🎨 cover.jpg saved.`);
                }
            } else {
                console.log(`⚠️ OMDb couldn't match search. Saving local fallback structural payload.`);
                const fallbackPayload = {
                    title: cleanTitle.replace(/\b\w/g, c => c.toUpperCase()),
                    year: parsedYear || "Unknown",
                    plot: "No summary description array details returned from network database logs.",
                    runtime: "N/A",
                    genre: "Media Asset",
                    rating: "N/A"
                };
                fs.writeFileSync(metadataPath, JSON.stringify(fallbackPayload, null, 4));
            }
        } catch (error) {
            console.error(`💥 Query failure context routing error: ${error.message}`);
        }
    }
    console.log("\n🏁 Filtered metadata parsing run finished completely.");
}

grabMetadata();