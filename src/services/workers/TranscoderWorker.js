// src/services/workers/TranscoderWorker.js
// Atomic Transcoding Engine with Multi-Resolution Generation Hooks for Nightly Schedulers.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../logger');

const app = express();
app.use(express.json());

const EXTENSIONS = ['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv'];

// =========================================================================
// 🎥 INDEPENDENT PROFILE RENDERING ENGINES (SWAPPABLE & SCHEDULABLE)
// =========================================================================

/**
 * GENERATE 1080p CORE WEB PROFILE
 * Reuses your exact high-quality stream specifications.
 */
function generate1080pProfile(inputPath, outputPath) {
    logger.debug(`🎬 Running 1080p Core Optimization Line -> ${path.basename(outputPath)}`);
    const ffmpegCmd = `ffmpeg -threads 6 -i "${inputPath}" -c:v libx264 -preset medium -crf 22 -c:a aac -ac 2 -b:a 192k -movflags +faststart -y "${outputPath}"`;
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 720p MID-BANDWIDTH PROFILE
 * Scales vertical frame boundaries down to 720 lines, drops CRF slightly to save storage space.
 */
function generate720pProfile(inputPath, outputPath) {
    logger.debug(`⏳ Running 720p Mid-Bandwidth Rendering Engine -> ${path.basename(outputPath)}`);
    // -vf scale=-2:720 enforces aspect-ratio scaling while matching even pixel boundaries required by h264
    const ffmpegCmd = `ffmpeg -threads 4 -i "${inputPath}" -vf "scale=-2:720" -c:v libx264 -preset medium -crf 23 -c:a aac -ac 2 -b:a 128k -movflags +faststart -y "${outputPath}"`;
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 480p LOW-BANDWIDTH PROFILE
 * Optimized for mobile cellular delivery, low processor usage.
 */
function generate480pProfile(inputPath, outputPath) {
    logger.debug(`📱 Running 480p Low-Bandwidth Rendering Engine -> ${path.basename(outputPath)}`);
    const ffmpegCmd = `ffmpeg -threads 4 -i "${inputPath}" -vf "scale=-2:480" -c:v libx264 -preset fast -crf 24 -c:a aac -ac 2 -b:a 96k -movflags +faststart -y "${outputPath}"`;
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

function inspectMediaStreams(filePath) {
    try {
        const command = `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of json "${filePath}"`;
        const audioCommand = `ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of json "${filePath}"`;
        
        const videoOutput = JSON.parse(execSync(command).toString());
        const audioOutput = JSON.parse(execSync(audioCommand).toString());
        
        return {
            videoCodec: videoOutput.streams?.[0]?.codec_name || '',
            audioCodec: audioOutput.streams?.[0]?.codec_name || '',
            isWebNative: (videoOutput.streams?.[0]?.codec_name === 'h264' || videoOutput.streams?.[0]?.codec_name === 'hevc') && audioOutput.streams?.[0]?.codec_name === 'aac'
        };
    } catch (err) {
        return { videoCodec: 'unknown', audioCodec: 'unknown', isWebNative: false };
    }
}

// =========================================================================
// 📥 PRIMARY INGESTION WORKER ROUTE
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName } = req.body;

    if (!folderPath) {
        return res.status(400).json({ success: false, error: "Missing required folderPath context." });
    }

    try {
        const list = fs.readdirSync(folderPath);
        const existingWebFile = list.find(file => file.endsWith('.web.mp4'));

        // If a 1080p web track already exists, exit fast so Orchestrator advances it
        if (existingWebFile) {
            return res.json({
                success: true,
                message: "1080p target profile verified instantly.",
                patchData: {
                    storage: {
                        location: "local",
                        files: {
                            "1080p": { status: "pending", localPath: existingWebFile, remoteKey: null },
                            "720p": { status: "waiting", localPath: null, remoteKey: null },
                            "480p": { status: "waiting", localPath: null, remoteKey: null }
                        }
                    }
                }
            });
        }

        const sourceVideo = list.find(file => {
            const ext = path.extname(file).toLowerCase();
            return EXTENSIONS.includes(ext) && !file.endsWith('.web.mp4') && !file.includes('.720p') && !file.includes('.480p');
        });

        if (!sourceVideo) {
            return res.json({ success: false, error: "No processing source video found." });
        }

        const inputPath = path.join(folderPath, sourceVideo);
        const parsedPath = path.parse(inputPath);
        const output1080Path = path.join(parsedPath.dir, `${parsedPath.name}.web.mp4`);

        const media = inspectMediaStreams(inputPath);

        if (media.isWebNative) {
            logger.debug(`🚀 [Fast Pass] Bypassing transcode loop for ${sourceVideo}`);
            if (!fs.existsSync(output1080Path)) {
                fs.renameSync(inputPath, output1080Path);
            }
        } else {
            // Trigger actual heavy encoding using the isolated function block
            generate1080pProfile(inputPath, output1080Path);
            
            if (fs.existsSync(inputPath) && inputPath !== output1080Path) {
                fs.unlinkSync(inputPath);
            }
        }

        // Return state map indicating 1080p is ready for sync, while 720p/480p are "waiting"
        return res.json({
            success: true,
            message: "Primary 1080p streaming track mapped successfully.",
            patchData: {
                storage: {
                    location: "local",
                    files: {
                        "1080p": { status: "pending", localPath: path.basename(output1080Path), remoteKey: null },
                        "720p":  { status: "waiting", localPath: null, remoteKey: null },
                        "480p":  { status: "waiting", localPath: null, remoteKey: null }
                    }
                }
            }
        });

    } catch (err) {
        logger.error(`❌ Transcoder Worker operation failure: ${err.message}`, 'error');
        return res.json({ success: false, error: err.message });
    }
});

// =========================================================================
// 🌙 NIGHTLY EXTENSION HOOKS (TRIGGERS FROM CRON CHANNELS)
// =========================================================================
app.post('/process-low-res', async (req, res) => {
    const { folderPath } = req.body;
    
    try {
        const list = fs.readdirSync(folderPath);
        const core1080p = list.find(file => file.endsWith('.web.mp4'));

        if (!core1080p) {
            return res.status(400).json({ success: false, error: "Cannot down-scale without a master 1080p file present." });
        }

        const sourcePath = path.join(folderPath, core1080p);
        const baseName = core1080p.replace('.web.mp4', '');
        
        const output720Path = path.join(folderPath, `${baseName}.720p.mp4`);
        const output480Path = path.join(folderPath, `${baseName}.480p.mp4`);

        // Execute background processes sequentially using your profile maps
        if (!fs.existsSync(output720Path)) generate720pProfile(sourcePath, output720Path);
        if (!fs.existsSync(output480Path)) generate480pProfile(sourcePath, output480Path);

        return res.json({
            success: true,
            patchData: {
                "720p": { status: "pending", localPath: path.basename(output720Path), remoteKey: null },
                "480p": { status: "pending", localPath: path.basename(output480Path), remoteKey: null }
            }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.TRANSCODE_WORKER_PORT || 5003;
app.listen(PORT, () => console.log(`⚙️ Multi-Profile Transcoder Engine listening on port ${PORT}`));