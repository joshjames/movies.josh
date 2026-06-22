const fs = require('fs');
const path = require('path');

// AUTOMATIC PATH RESOLUTION:
// If running inside Docker, use /app/movies. If running on host machine, use /home/epic/movies



const { execSync } = require('child_process');

const MOVIES_DIR = fs.existsSync('/app/movies') ? '/app/movies' : '/home/epic/movies';

console.log(`🎬 Target directory initialized at state path: ${MOVIES_DIR}`);

const EXTENSIONS = ['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv'];

function getFilesRecursive(dir) {
    let results = [];
    const list = fs.readdirSync(dir);

    // CRITICAL CHECK: Look at the current directory level.
    const hasExistingWebTranscode = list.some(file => file.endsWith('.web.mp4'));
    if (hasExistingWebTranscode) {
        console.log(`✨ Skipping Directory: ...${dir.replace(MOVIES_DIR, '')} (Already contains a completed .web.mp4 file)`);
        return [];
    }

    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat && stat.isDirectory()) {
            if (file.toLowerCase() === 'sample') {
                return;
            }
            results = results.concat(getFilesRecursive(filePath));
        } else {
            const ext = path.extname(filePath).toLowerCase();
            if (EXTENSIONS.includes(ext) && !file.endsWith('.web.mp4')) {
                results.push(filePath);
            }
        }
    });
    return results;
}


function inspectMediaStreams(filePath) {
    try {
        // Query ffprobe to pull container details wrapped cleanly in a JSON profile
        const command = `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of json "${filePath}"`;
        const audioCommand = `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of json "${filePath}"`;
        
        const videoOutput = JSON.parse(execSync(command).toString());
        const audioOutput = JSON.parse(execSync(audioCommand).toString());
        
        const videoCodec = videoOutput.streams?.[0]?.codec_name || '';
        const audioCodec = audioOutput.streams?.[0]?.codec_name || '';
        
        return {
            videoCodec: videoCodec.toLowerCase(), // e.g., 'h264', 'hevc'
            audioCodec: audioCodec.toLowerCase(), // e.g., 'aac', 'mp3', 'ac3'
            isWebNative: (videoCodec === 'h264' || videoCodec === 'hevc') && audioCodec === 'aac'
        };
    } catch (err) {
        console.error(`⚠️  ffprobe analysis failed on asset footprint: ${err.message}`);
        return { videoCodec: 'unknown', audioCodec: 'unknown', isWebNative: false };
    }
}

function preTranscodeLibrary() {
    console.log(`🌀 Starting Smart Library Optimization Run at: ${MOVIES_DIR}`);

    if (!fs.existsSync(MOVIES_DIR)) {
        console.error(`❌ Directory error: [${MOVIES_DIR}] does not exist.`);
        return;
    }

    const allVideos = getFilesRecursive(MOVIES_DIR);
    let transcodeCount = 0;
    let fastPassCount = 0;

    for (const inputPath of allVideos) {
        // Skip preview snippets or samples
        if (path.basename(inputPath).toLowerCase().includes('sample')) continue;
        
        // Skip files that are already successfully optimized outputs from a prior run
        if (inputPath.toLowerCase().endsWith('.web.mp4')) continue;

        const parsedPath = path.parse(inputPath);
        const outputPath = path.join(parsedPath.dir, `${parsedPath.name}.web.mp4`);
        const lockPath = path.join(parsedPath.dir, '.processing');

        console.log(`\n🎬 Evaluating Target: ...${inputPath.replace(MOVIES_DIR, '')}`);

        // -----------------------------------------------------------------
        // STEP 1: SMART CODEC INSPECTION (THE FAST PASS)
        // -----------------------------------------------------------------
        const media = inspectMediaStreams(inputPath);
        console.log(`📊 Codecs: Video [${media.videoCodec}] | Audio [${media.audioCodec}]`);

        if (media.isWebNative) {
            console.log(`✨ Web-native format confirmed. Bypassing transcoding matrix...`);
            
            if (!fs.existsSync(outputPath)) {
                if (parsedPath.ext.toLowerCase() === '.mp4') {
                    // If it's already an mp4 container, just rename it directly inline
                    fs.renameSync(inputPath, outputPath);
                } else {
                    // If it's an MKV/M4V, rename it to change container type, then nuke the old file
                    fs.renameSync(inputPath, outputPath);
                    console.log(`🗑️  Cleaning up legacy source wrapper container.`);
                }
                console.log(`🗂️  File fast-linked directly: ${path.basename(outputPath)}`);
                fastPassCount++;
            } else {
                console.log(`⚠️  Target standard destination already exists. Skipping.`);
            }
            continue; // CRITICAL: Stop loop cycle here! Move instantly to the next movie.
        }

        // -----------------------------------------------------------------
        // STEP 2: FALLBACK TO HEAVY TRANSCODING (IF CODES DON'T MATCH)
        // -----------------------------------------------------------------
        console.log(`⏳ Heavy/Legacy container format discovered. Initializing FFmpeg...`);
        
        // Drop the zero-byte lock flag right before execution
        fs.writeFileSync(lockPath, ''); 

        const ffmpegCmd = `ffmpeg -threads 6 -i "${inputPath}" -c:v libx264 -preset medium -crf 22 -c:a aac -ac 2 -b:a 192k -movflags +faststart -y "${outputPath}"`;

        try {
            console.log(`🎬 FFmpeg transcode processing active (Capped at 6 threads)...`);
            execSync(ffmpegCmd, { stdio: 'inherit' });
            console.log(`✅ Completed: ${outputPath}`);
            
            // Delete the old source file since we generated a fresh transcoded clone next to it
            if (fs.existsSync(inputPath) && inputPath !== outputPath) {
                fs.unlinkSync(inputPath);
            }
            transcodeCount++;
        } catch (err) {
            console.error(`❌ Failed processing [${parsedPath.base}]:`, err.message);
        } finally {
            if (fs.existsSync(lockPath)) {
                fs.unlinkSync(lockPath);
            }
        }
    }

    console.log(`\n🏁 Done! Fast-passed: ${fastPassCount} movies | Transcoded: ${transcodeCount} movies.`);
}

preTranscodeLibrary();