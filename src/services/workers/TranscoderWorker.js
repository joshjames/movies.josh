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
    // Added a maxrate cap of 2.5M and a matching buffer size to prevent bloated encodes
    const ffmpegCmd = `ffmpeg -threads 4 -i "${inputPath}" -vf "scale=-2:720:sws_flags=lanczos" -c:v libx264 -preset medium -crf 25 -maxrate 2500k -bufsize 5000k -c:a aac -ac 2 -b:a 128k -movflags +faststart -y "${outputPath}"`;
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 480p LOW-BANDWIDTH PROFILE
 */
function generate480pProfile(inputPath, outputPath) {
    logger.debug(`📱 Running 480p Low-Bandwidth Rendering Engine -> ${path.basename(outputPath)}`);
    // Added a maxrate cap of 1.2M
    const ffmpegCmd = `ffmpeg -threads 4 -i "${inputPath}" -vf "scale=-2:480:sws_flags=lanczos" -c:v libx264 -preset fast -crf 27 -maxrate 1200k -bufsize 2400k -c:a aac -ac 2 -b:a 96k -movflags +faststart -y "${outputPath}"`;
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
        if (!folderPath || !fs.existsSync(folderPath)) {
            return res.status(400).json({ success: false, error: "Missing or invalid folderPath." });
        }

        const list = fs.readdirSync(folderPath);
        const core1080p = list.find(file => file.endsWith('.web.mp4'));

        if (!core1080p) {
            return res.status(400).json({ success: false, error: "Cannot down-scale without a master 1080p file present." });
        }

        const sourcePath = path.join(folderPath, core1080p);
        const baseName = core1080p.replace('.web.mp4', '');
        
        const output720Path = path.join(folderPath, `${baseName}.720p.mp4`);
        const output480Path = path.join(folderPath, `${baseName}.480p.mp4`);

        const generated = {
            profile1080: core1080p,
            profile720: fs.existsSync(output720Path) ? path.basename(output720Path) : null,
            profile480: fs.existsSync(output480Path) ? path.basename(output480Path) : null
        };
        const errors = [];

        if (!generated.profile720) {
            try {
                generate720pProfile(sourcePath, output720Path);
                if (fs.existsSync(output720Path)) {
                    generated.profile720 = path.basename(output720Path);
                }
            } catch (err720) {
                const msg = `720p generation failed: ${err720.message}`;
                logger.error(msg);
                errors.push(msg);
            }
        }

        if (!generated.profile480) {
            try {
                generate480pProfile(sourcePath, output480Path);
                if (fs.existsSync(output480Path)) {
                    generated.profile480 = path.basename(output480Path);
                }
            } catch (err480) {
                const msg = `480p generation failed: ${err480.message}`;
                logger.error(msg);
                errors.push(msg);
            }
        }

        const metaFilePath = path.join(folderPath, 'metadata.json');
        let metadata = {};
        if (fs.existsSync(metaFilePath)) {
            try {
                metadata = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
            } catch (_err) {
                metadata = {};
            }
        }

        metadata.storage = metadata.storage || { location: 'local', files: {} };
        metadata.storage.files = metadata.storage.files || {};

        metadata.storage.files['1080p'] = {
            ...(metadata.storage.files['1080p'] || {}),
            status: metadata.storage.files['1080p']?.status || 'synced',
            localPath: generated.profile1080 || metadata.storage.files['1080p']?.localPath || null,
            remoteKey: metadata.storage.files['1080p']?.remoteKey || null
        };

        if (generated.profile720) {
            metadata.storage.files['720p'] = {
                ...(metadata.storage.files['720p'] || {}),
                status: 'pending',
                localPath: generated.profile720,
                remoteKey: null
            };
        }

        if (generated.profile480) {
            metadata.storage.files['480p'] = {
                ...(metadata.storage.files['480p'] || {}),
                status: 'pending',
                localPath: generated.profile480,
                remoteKey: null
            };
        }

        metadata.pipelineState = {
            ...(metadata.pipelineState || {}),
            currentStep: metadata.pipelineState?.currentStep || 'COMPLETED',
            lastUpdated: new Date().toISOString(),
            error: errors.length ? errors.join(' | ') : null
        };

        fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 4), 'utf-8');

        const hasAtLeastOneProfile = Boolean(generated.profile720 || generated.profile480);
        if (!hasAtLeastOneProfile) {
            return res.status(500).json({
                success: false,
                error: errors.join(' | ') || 'Failed to generate 720p/480p profiles.',
                generated
            });
        }

        return res.json({
            success: true,
            partial: errors.length > 0,
            errors,
            patchData: {
                "720p": generated.profile720 ? { status: "pending", localPath: generated.profile720, remoteKey: null } : null,
                "480p": generated.profile480 ? { status: "pending", localPath: generated.profile480, remoteKey: null } : null
            },
            generated
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.TRANSCODE_WORKER_PORT || 5003;
app.listen(PORT, () => console.log(`⚙️ Multi-Profile Transcoder Engine listening on port ${PORT}`));