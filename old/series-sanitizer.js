const fs = require('fs');
const path = require('path');
const axios = require('axios');

const OMDB_API_KEY = '84196d01'; // <-- Insert your OMDb API key here
const SERIES_DIR = path.join(__dirname, 'movies', 'series');

if (!fs.existsSync(SERIES_DIR)) {
    console.error("❌ Series root directory does not exist yet.");
    process.exit(1);
}

// Helper to sanitize title strings for clean OMDb searching
function cleanSearchTitle(folderName) {
    return folderName.replace(/[-_.]/g, ' ').trim();
}

// Regex to extract season and episode numbers from video filenames (e.g., S01E05, s1e5, s01.e05)
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

async function sanitizeAllSeries() {
    console.log("🎬 Starting Series Serialization & Sanitizer Engine...");
    const shows = fs.readdirSync(SERIES_DIR);

    for (const showFolder of shows) {
        const showPath = path.join(SERIES_DIR, showFolder);
        if (showFolder.startsWith('.') || !fs.lstatSync(showPath).isDirectory()) continue;

        console.log(`\n🔍 Processing Show Folder: [${showFolder}]`);
        const searchTitle = cleanSearchTitle(showFolder);

        // 1. Fetch High Level Show Details
        let mainMeta = { title: searchTitle, year: '', plot: '', genre: '', contentType: 'series' };
        let totalSeasons = 1;

        try {
            const showRes = await axios.get(`http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(searchTitle)}&type=series`);
            if (showRes.data && showRes.data.Response === "True") {
                mainMeta.title = showRes.data.Title;
                mainMeta.year = showRes.data.Year;
                mainMeta.plot = showRes.data.Plot;
                mainMeta.genre = showRes.data.Genre;
                totalSeasons = parseInt(showRes.data.totalSeasons, 10) || 1;
                console.log(`✅ OMDb matched: ${mainMeta.title} (${totalSeasons} Seasons total)`);
            } else {
                console.log(`⚠️ OMDb couldn't match folder name. Using fallback structural titles.`);
            }
        } catch (err) {
            console.error(`❌ OMDb connection error for ${searchTitle}:`, err.message);
        }

        // Write out the high-level cache tracker immediately
        fs.writeFileSync(path.join(showPath, 'metadata.json'), JSON.stringify(mainMeta, null, 2));

        // 2. Scan Disk Arrays to Build a Local Media Manifest Look-up Table
        // This scans through ANY season folders inside the directory to map your video files
        const diskItems = fs.readdirSync(showPath);
        let physicalFileMap = {}; 

        diskItems.forEach(item => {
            const itemPath = path.join(showPath, item);
            if (!fs.lstatSync(itemPath).isDirectory()) return;

            const videoExtensions = ['.mp4', '.mkv', '.avi', '.m4v', '.ts'];
            const files = fs.readdirSync(itemPath);

            files.forEach(file => {
                if (!videoExtensions.includes(path.extname(file).toLowerCase())) return;
                
                const parseResults = parseEpFromFilename(file);
                if (parseResults) {
                    const lookupKey = `${parseResults.season}-${parseResults.episode}`;
                    // Store the relative path format your express static routing expects
                    physicalFileMap[lookupKey] = `series/${showFolder}/${item}/${file}`;
                }
            });
        });

        // 3. Query Every Single Season/Episode Sequence from OMDb API
        let fullSeriesStructure = {
            totalSeasons: totalSeasons.toString(),
            seasons: {}
        };

        for (let s = 1; s <= totalSeasons; s++) {
            console.log(`   📡 Fetching metadata manifest for Season ${s}...`);
            fullSeriesStructure.seasons[s] = {
                seasonNumber: s.toString(),
                episodes: []
            };

            try {
                const seasonRes = await axios.get(`http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&t=${encodeURIComponent(searchTitle)}&Season=${s}`);
                
                if (seasonRes.data && seasonRes.data.Response === "True" && seasonRes.data.Episodes) {
                    for (const ep of seasonRes.data.Episodes) {
                        const epNum = parseInt(ep.Episode, 10);
                        const lookupKey = `${s}-${epNum}`;
                        const isAvailable = !!physicalFileMap[lookupKey];

                        // Build individual target record profile entries
                        fullSeriesStructure.seasons[s].episodes.push({
                            episodeNumber: epNum,
                            title: ep.Title || `Episode ${epNum}`,
                            released: ep.Released || 'Unknown',
                            plot: 'Fetch individual plot details via extended loop if desired or leave crisp summary snapshots.',
                            imdbRating: ep.imdbRating || 'N/A',
                            available: isAvailable,
                            localRelativePath: isAvailable ? physicalFileMap[lookupKey] : null
                        });
                    }
                } else {
                    // Fallback structural loop generation if OMDb has no record for this specific season layout yet
                    console.log(`   ⚠️ No official online records for Season ${s}. Generating standard skeleton matrix.`);
                    generateSkeletonSeason(s, fullSeriesStructure, physicalFileMap);
                }
            } catch (err) {
                console.error(`   ❌ Error grabbing Season ${s} data profiles:`, err.message);
                generateSkeletonSeason(s, fullSeriesStructure, physicalFileMap);
            }
        }

        // Save down the unified complete schema document track onto disk storage
        fs.writeFileSync(path.join(showPath, 'series.json'), JSON.stringify(fullSeriesStructure, null, 2));
        console.log(`💾 Successfully completed and wrote metadata/series.json configurations for: ${mainMeta.title}`);
    }
}

// Helper to map files manually if OMDb API data is missing or incomplete for a season
function generateSkeletonSeason(seasonNum, structure, physicalFileMap) {
    // Look through keys to see if we have local physical video matches on disk for this season
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
    // Ensure natural sort order
    structure.seasons[seasonNum].episodes.sort((a,b) => a.episodeNumber - b.episodeNumber);
}

sanitizeAllSeries();