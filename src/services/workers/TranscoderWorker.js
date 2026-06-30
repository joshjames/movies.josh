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
 * REMUX CORES (FAST STREAM PASS-THROUGH)
 * Bypasses encoding penalties entirely when streams already match target codecs.
 */
function remuxToWebContainer(inputPath, outputPath) {
    logger.debug(`⚡ Running Fast Container Remux Pass [Stream Copy] -> ${path.basename(outputPath)}`);
    // -c copy strips encoding load entirely; +faststart relocates moov atom for immediate web playback
    const ffmpegCmd = `ffmpeg -threads 4 -i "${inputPath}" -c:v copy -c:a copy -movflags +faststart -y "${outputPath}"`;
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 1080p CORE WEB PROFILE
 */
function generate1080pProfile(inputPath, outputPath) {
    logger.debug(`🎬 Running 1080p Core Optimization Line -> ${path.basename(outputPath)}`);
    const ffmpegCmd = `ffmpeg -threads 6 -i "${inputPath}" -c:v libx264 -preset medium -crf 22 -c:a aac -ac 2 -b:a 192k -movflags +faststart -y "${outputPath}"`;
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 720p MID-BANDWIDTH PROFILE
 */
function generate720pProfile(inputPath, outputPath) {
    logger.debug(`⏳ Running 720p Mid-Bandwidth Rendering Engine -> ${path.basename(outputPath)}`);
    const ffmpegCmd = `ffmpeg -threads 4 -i "${inputPath}" -vf "scale=-2:720" -c:v libx264 -preset medium -crf 23 -c:a aac -ac 2 -b:a 128k -movflags +faststart -y "${outputPath}"`;
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 480p LOW-BANDWIDTH PROFILE
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
        
        const videoCodec = videoOutput.streams?.[0]?.codec_name || '';
        const audioCodec = audioOutput.streams?.[0]?.codec_name || '';
        
        return {
            videoCodec,
            audioCodec,
            isWebNative: (videoCodec === 'h264' || videoCodec === 'hevc') && audioCodec === 'aac'
        };
    } catch (err) {
        logger.error(`ffprobe inspection crash on ${path.basename(filePath)}: ${err.message}`);
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
        if (!fs.existsSync(folderPath)) {
            return res.json({ success: false, error: `Directory target does not exist on disk: ${folderPath}` });
        }

        const list = fs.readdirSync(folderPath);
        const existingWebFile = list.find(file => file.endsWith('.web.mp4'));

        // 🛑 ABSOLUTE SHORT CIRCUIT: If the targeted file format is present, completely freeze further tasks.
        if (existingWebFile) {
            logger.debug(`🎯 [Web Target Confirmed] ${folderName} already has optimized asset: ${existingWebFile}. Skipping completely.`);
            return res.json({
                success: true,
                message: "Terminal 1080p web target profile verified instantly.",
                patchData: {
                    storage: {
                        location: "local",
                        files: {
                            "1080p": { status: "synced", localPath: existingWebFile, remoteKey: null },
                            "720p": { status: "waiting", localPath: null, remoteKey: null },
                            "480p": { status: "waiting", localPath: null, remoteKey: null }
                        }
                    }
                }
            });
        }

        // Clean query isolation for source video tracks
        let sourceVideo = list.find(file => {
            const ext = path.extname(file).toLowerCase();
            return EXTENSIONS.includes(ext) && !file.endsWith('.web.mp4') && !file.includes('.720p') && !file.includes('.480p');
        });

        if (!sourceVideo) {
            // Fallback for titles that only exist as 720p/480p source files.
            sourceVideo = list.find(file => {
                const ext = path.extname(file).toLowerCase();
                return EXTENSIONS.includes(ext) && !file.endsWith('.web.mp4');
            });
        }

        if (!sourceVideo) {
            return res.json({ success: false, error: "No viable processing source video found." });
        }

        const inputPath = path.join(folderPath, sourceVideo);
        const parsedPath = path.parse(inputPath);
        const output1080Path = path.join(parsedPath.dir, `${parsedPath.name}.web.mp4`);

        const media = inspectMediaStreams(inputPath);

        if (media.isWebNative) {
            logger.debug(`🚀 [Fast Pass Match] Streams match requirements. Wrapping container for ${sourceVideo}`);
            
            // Safe execution line check to prevent self-destruction
            if (inputPath !== output1080Path) {
                try {
                    remuxToWebContainer(inputPath, output1080Path);
                    if (fs.existsSync(output1080Path)) {
                        fs.unlinkSync(inputPath);
                    }
                } catch (remuxErr) {
                    logger.error(`⚠️ Remux failed, falling back to full hardware decode loop: ${remuxErr.message}`);
                    generate1080pProfile(inputPath, output1080Path);
                    if (fs.existsSync(output1080Path)) fs.unlinkSync(inputPath);
                }
            } else {
                // If it is somehow named exactly the same but lacks the target web naming standard
                const correctedPath = path.join(parsedPath.dir, `${parsedPath.name}.fixed.web.mp4`);
                remuxToWebContainer(inputPath, correctedPath);
            }
        } else {
            // Trigger actual heavy encoding using isolated function blocks
            generate1080pProfile(inputPath, output1080Path);
            
            if (fs.existsSync(inputPath) && inputPath !== output1080Path) {
                fs.unlinkSync(inputPath);
            }
        }

        return res.json({
            success: true,
            message: "Primary 1080p streaming track mapped successfully.",
            patchData: {
                storage: {
                    location: "local",
                    files: {
                        "1080p": { status: "synced", localPath: path.basename(output1080Path), remoteKey: null },
                        "720p":  { status: "waiting", localPath: null, remoteKey: null },
                        "480p":  { status: "waiting", localPath: null, remoteKey: null }
                    }
                }
            }
        });

    } catch (err) {
        logger.error(`❌ Transcoder Worker operation failure: ${err.message}`);
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