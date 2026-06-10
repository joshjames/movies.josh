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

function preTranscodeLibrary() {
    console.log(`🌀 Starting Smart Library Optimization Run at: ${MOVIES_DIR}`);

    if (!fs.existsSync(MOVIES_DIR)) {
        console.error(`❌ Directory error: [${MOVIES_DIR}] does not exist.`);
        return;
    }

    const allVideos = getFilesRecursive(MOVIES_DIR);
    let transcodeCount = 0;

    for (const inputPath of allVideos) {
        if (path.basename(inputPath).toLowerCase().includes('sample')) {
            continue;
        }

        const parsedPath = path.parse(inputPath);
        const outputPath = path.join(parsedPath.dir, `${parsedPath.name}.web.mp4`);

        // FIX: Use parsedPath.dir since currentMovieFolder doesn't exist
        const lockPath = path.join(parsedPath.dir, '.processing');

        console.log(`\n🎬 New Target Found: ...${inputPath.replace(MOVIES_DIR, '')}`);
        console.log(`⏳ Encoding to web-native progressive format...`);

        // Drop the zero-byte lock flag right before execution
        fs.writeFileSync(lockPath, ''); 

        const ffmpegCmd = `ffmpeg -threads 6 -i "${inputPath}" -c:v libx264 -preset medium -crf 22 -c:a aac -ac 2 -b:a 192k -movflags +faststart -y "${outputPath}"`;

        try {
            console.log(`🎬 FFmpeg transcode processing active...`);
            execSync(ffmpegCmd, { stdio: 'inherit' });
            console.log(`✅ Completed: ${outputPath}`);
            transcodeCount++;
        } catch (err) {
            console.error(`❌ Failed processing [${parsedPath.base}]:`, err.message);
        } finally {
            // Clean up the indicator lock file regardless of success or crash
            if (fs.existsSync(lockPath)) {
                fs.unlinkSync(lockPath);
            }
        }
    } // <-- Added missing loop closing bracket

    console.log(`\n🏁 Done! Optimized ${transcodeCount} new media files.`);
}

preTranscodeLibrary();