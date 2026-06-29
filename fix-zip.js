// extract-subs-host.js
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// 🎯 HOST SYSTEM TARGET DIRECTORY
const TARGET_DIR = '/home/epic/movies';

async function processSubtitles() {
    console.log("🧹 Starting host-side subtitle extraction sweep...");

    if (!fs.existsSync(TARGET_DIR)) {
        console.error(`❌ Target host directory does not exist: ${TARGET_DIR}`);
        return;
    }

    const items = fs.readdirSync(TARGET_DIR);

    for (const item of items) {
        const folderPath = path.join(TARGET_DIR, item);
        const stat = fs.statSync(folderPath);

        if (!stat.isDirectory()) continue;

        // Scan inside each movie directory for the zip artifacts
        const files = fs.readdirSync(folderPath);
        const zipFile = files.find(f => f.startsWith('temp_subs_') && f.endsWith('.zip'));

        if (!zipFile) continue;

        const zipPath = path.join(folderPath, zipFile);
        console.log(`\n📦 Found compressed subtitle package in: ${item}`);

        try {
            const zip = new AdmZip(zipPath);
            const zipEntries = zip.getEntries();
            
            // Prioritize English tracking variants, fall back to the first available srt
            let targetEntry = zipEntries.find(entry => 
                entry.entryName.toLowerCase().includes('eng') || 
                entry.entryName.toLowerCase().includes('english')
            );
            
            if (!targetEntry) {
                targetEntry = zipEntries.find(entry => entry.entryName.endsWith('.srt'));
            }

            if (targetEntry) {
                const srtContent = targetEntry.getData().toString('utf8');
                
                // Sanitize the directory name to create a clean .srt filename match
                // e.g., "The.Running.Man.2025" -> "The.Running.Man.2025.srt"
                const cleanName = item
                    .replace(/\[.*?\]/g, '')                  // Strip release tags like [YTS]
                    .replace(/\(.*?\)/g, '')                  // Strip parenthesis
                    .replace(/[-_\s]+/g, '.')                 // Force uniform dot notation spacing
                    .replace(/\.+$/, '')                      // Trim tail dots
                    .trim();

                const destSrtName = `${cleanName}.srt`;
                const destSrtPath = path.join(folderPath, destSrtName);

                fs.writeFileSync(destSrtPath, srtContent, 'utf8');
                console.log(`   ✅ Extracted & mapped cleanly to: ${destSrtName}`);

                // Match typical host user ownership access configurations
                fs.chmodSync(destSrtPath, 0o666);
            } else {
                console.log(`   ⚠️ No valid .srt file variations discovered inside zip container.`);
            }

            // 🗑️ Housekeeping: Wipe out the zip file
            fs.unlinkSync(zipPath);
            console.log(`   🗑️ Purged temporary package file: ${zipFile}`);

        } catch (err) {
            console.error(`   ❌ Extraction break processing ${item}:`, err.message);
        }
    }
    console.log("\n✨ Subtitle extraction pass complete.");
}

processSubtitles();