const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MOVIES_DIR = path.resolve('/home/epic/movies'); 
const EXTENSIONS = ['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv'];

function getFilesRecursive(dir) {
    let results = [];
    const list = fs.readdirSync(dir);

    // CRITICAL CHECK: Look at the current directory level.
    // If there is already a finished .web.mp4 file here, skip this entire directory branch.
    const hasExistingWebTranscode = list.some(file => file.endsWith('.web.mp4'));
    if (hasExistingWebTranscode) {
        console.log(`✨ Skipping Directory: ...${dir.replace(MOVIES_DIR, '')} (Already contains a completed .web.mp4 file)`);
        return [];
    }

    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat && stat.isDirectory()) {
            // Skip sample directories entirely
            if (file.toLowerCase() === 'sample') {
                return;
            }
            results = results.concat(getFilesRecursive(filePath));
        } else {
            const ext = path.extname(filePath).toLowerCase();
            // Pull files matching video extensions, but strictly ignore any loose .web.mp4 variants
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
        // Skip if the filename contains "sample" just to be absolutely sure
        if (path.basename(inputPath).toLowerCase().includes('sample')) {
            continue;
        }

        const parsedPath = path.parse(inputPath);
        const outputPath = path.join(parsedPath.dir, `${parsedPath.name}.web.mp4`);

        console.log(`\n🎬 New Target Found: ...${inputPath.replace(MOVIES_DIR, '')}`);
        console.log(`⏳ Encoding to web-native progressive format...`);

        const ffmpegCmd = `ffmpeg -i "${inputPath}" -c:v libx264 -preset medium -crf 22 -c:a aac -ac 2 -b:a 192k -movflags +faststart -y "${outputPath}"`;

        try {
            execSync(ffmpegCmd, { stdio: 'inherit' });
            console.log(`✅ Completed: ${outputPath}`);
            transcodeCount++;
        } catch (err) {
            console.error(`❌ Failed processing [${parsedPath.base}]:`, err.message);
        }
    }
    console.log(`\n🏁 Done! Optimized ${transcodeCount} new media files.`);
}

preTranscodeLibrary();