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

function isVideoCandidate(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (!EXTENSIONS.includes(path.extname(lower))) return false;
    if (lower.endsWith('.web.mp4')) return false;
    if (lower.includes('.720p.')) return false;
    if (lower.includes('.480p.')) return false;
    return true;
}

function walkVideoSources(rootFolder) {
    const discovered = [];

    function visit(currentPath) {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const absolutePath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                visit(absolutePath);
                continue;
            }

            if (entry.isFile() && isVideoCandidate(entry.name)) {
                discovered.push(absolutePath);
            }
        }
    }

    visit(rootFolder);
    return discovered.sort((a, b) => a.localeCompare(b));
}

function probeMediaStreams(filePath) {
    try {
        const command = `ffprobe -v error -show_entries stream=index,codec_type,codec_name,channels,channel_layout:stream_tags=language,title:stream_disposition=default,forced -of json "${filePath}"`;
        const output = JSON.parse(execSync(command).toString());
        return Array.isArray(output.streams) ? output.streams : [];
    } catch (err) {
        logger.error(`ffprobe stream scan crash on ${path.basename(filePath)}: ${err.message}`);
        return [];
    }
}

function pickAudioStreamCandidates(filePath) {
    const streams = probeMediaStreams(filePath).filter(stream => stream.codec_type === 'audio');
    return streams.map((stream, index) => {
        const lang = String(stream?.tags?.language || '').toLowerCase();
        const title = String(stream?.tags?.title || '').trim();
        const codec = String(stream?.codec_name || '').toLowerCase();
        const defaultFlag = Number(stream?.disposition?.default) === 1;

        return {
            index,
            streamIndex: Number(stream?.index),
            lang,
            title,
            codec,
            channels: Number(stream?.channels) || 0,
            channelLayout: String(stream?.channel_layout || '').trim(),
            isDefault: defaultFlag,
            isEnglish: lang === 'en' || lang === 'eng' || /\beng(lish)?\b/i.test(title)
        };
    });
}

function buildAudioMapArgs(filePath) {
    const tracks = pickAudioStreamCandidates(filePath);
    if (!tracks.length) {
        return { mapArgs: ['-map', '0:v:0'], chosenTrack: null, audioTracks: [] };
    }

    const preferred = tracks.find(track => track.isDefault && track.isEnglish)
        || tracks.find(track => track.isEnglish)
        || tracks.find(track => track.isDefault)
        || tracks[0];

    const mapArgs = ['-map', '0:v:0'];
    tracks.forEach(track => {
        mapArgs.push('-map', `0:${track.streamIndex}`);
    });

    return { mapArgs, chosenTrack: preferred, audioTracks: tracks };
}

// =========================================================================
// 🎥 INDEPENDENT PROFILE RENDERING ENGINES (SWAPPABLE & SCHEDULABLE)
// =========================================================================

/**
 * REMUX CORES (FAST STREAM PASS-THROUGH)
 * Bypasses encoding penalties entirely when streams already match target codecs.
 */
function remuxToWebContainer(inputPath, outputPath) {
    logger.debug(`⚡ Running Fast Container Remux Pass [Stream Copy] -> ${path.basename(outputPath)}`);
    const { mapArgs } = buildAudioMapArgs(inputPath);
    // -c copy strips encoding load entirely; +faststart relocates moov atom for immediate web playback
    const ffmpegCmd = [
        'ffmpeg',
        '-threads', '4',
        '-i', `"${inputPath}"`,
        ...mapArgs,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y', `"${outputPath}"`
    ].join(' ');
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 1080p CORE WEB PROFILE
 */
function generate1080pProfile(inputPath, outputPath) {
    logger.debug(`🎬 Running 1080p Core Optimization Line -> ${path.basename(outputPath)}`);
    const { mapArgs } = buildAudioMapArgs(inputPath);
    const ffmpegCmd = [
        'ffmpeg',
        '-threads', '6',
        '-i', `"${inputPath}"`,
        ...mapArgs,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '22',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2',
        '-movflags', '+faststart',
        '-y', `"${outputPath}"`
    ].join(' ');
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 720p MID-BANDWIDTH PROFILE
 */
function generate720pProfile(inputPath, outputPath) {
    logger.debug(`⏳ Running 720p Mid-Bandwidth Rendering Engine -> ${path.basename(outputPath)}`);
    // Added a maxrate cap of 2.5M and a matching buffer size to prevent bloated encodes
    const { mapArgs } = buildAudioMapArgs(inputPath);
    const ffmpegCmd = [
        'ffmpeg',
        '-threads', '4',
        '-i', `"${inputPath}"`,
        ...mapArgs,
        '-vf', '"scale=-2:720:sws_flags=lanczos"',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '25',
        '-maxrate', '2500k',
        '-bufsize', '5000k',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-movflags', '+faststart',
        '-y', `"${outputPath}"`
    ].join(' ');
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

/**
 * GENERATE 480p LOW-BANDWIDTH PROFILE
 */
function generate480pProfile(inputPath, outputPath) {
    logger.debug(`📱 Running 480p Low-Bandwidth Rendering Engine -> ${path.basename(outputPath)}`);
    // Added a maxrate cap of 1.2M
    const { mapArgs } = buildAudioMapArgs(inputPath);
    const ffmpegCmd = [
        'ffmpeg',
        '-threads', '4',
        '-i', `"${inputPath}"`,
        ...mapArgs,
        '-vf', '"scale=-2:480:sws_flags=lanczos"',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '27',
        '-maxrate', '1200k',
        '-bufsize', '2400k',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-ac', '2',
        '-movflags', '+faststart',
        '-y', `"${outputPath}"`
    ].join(' ');
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

function inspectMediaStreams(filePath) {
    try {
        const streams = probeMediaStreams(filePath);
        const videoStream = streams.find(stream => stream.codec_type === 'video') || null;
        const audioStreams = streams.filter(stream => stream.codec_type === 'audio');
        const audioCodecs = audioStreams.map(stream => String(stream.codec_name || '').toLowerCase());
        const videoCodec = String(videoStream?.codec_name || '').toLowerCase();
        const audioCodec = audioCodecs[0] || '';

        return {
            videoCodec,
            audioCodec,
            audioTracks: audioStreams.length,
            hasMultipleAudioTracks: audioStreams.length > 1,
            isWebNative: (videoCodec === 'h264' || videoCodec === 'hevc') && audioCodecs.every(codec => codec === 'aac' || codec === 'mp3' || codec === 'ac3' || codec === 'eac3')
        };
    } catch (err) {
        logger.error(`ffprobe inspection crash on ${path.basename(filePath)}: ${err.message}`);
        return { videoCodec: 'unknown', audioCodec: 'unknown', audioTracks: 0, hasMultipleAudioTracks: false, isWebNative: false };
    }
}

function processSingleVideoFile(inputPath) {
    const parsedPath = path.parse(inputPath);
    const output1080Path = path.join(parsedPath.dir, `${parsedPath.name}.web.mp4`);

    if (fs.existsSync(output1080Path)) {
        logger.debug(`🎯 [Web Target Confirmed] ${path.basename(inputPath)} already has optimized asset: ${path.basename(output1080Path)}. Skipping.`);
        return {
            success: true,
            skipped: true,
            output1080Path,
            inputPath
        };
    }

    const media = inspectMediaStreams(inputPath);

    if (media.isWebNative) {
        logger.debug(`🚀 [Fast Pass Match] Streams match requirements. Wrapping container for ${path.basename(inputPath)}`);

        try {
            if (inputPath !== output1080Path) {
                remuxToWebContainer(inputPath, output1080Path);
                if (fs.existsSync(output1080Path)) {
                    fs.unlinkSync(inputPath);
                }
            }
        } catch (remuxErr) {
            logger.error(`⚠️ Remux failed, falling back to full hardware decode loop: ${remuxErr.message}`);
            generate1080pProfile(inputPath, output1080Path);
            if (fs.existsSync(output1080Path)) fs.unlinkSync(inputPath);
        }
    } else {
        generate1080pProfile(inputPath, output1080Path);

        if (fs.existsSync(inputPath) && inputPath !== output1080Path) {
            fs.unlinkSync(inputPath);
        }
    }

    return {
        success: true,
        skipped: false,
        output1080Path,
        inputPath,
        media
    };
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

        const sourceVideos = walkVideoSources(folderPath);
        if (!sourceVideos.length) {
            return res.json({ success: false, error: "No viable processing source video found." });
        }

        const results = [];
        for (const inputPath of sourceVideos) {
            try {
                results.push(processSingleVideoFile(inputPath));
            } catch (videoErr) {
                logger.error(`❌ Transcoder Worker failed for ${path.basename(inputPath)}: ${videoErr.message}`);
                results.push({ success: false, inputPath, error: videoErr.message });
            }
        }

        const failures = results.filter(item => item.success === false);
        if (failures.length === results.length) {
            return res.json({ success: false, error: 'No video files could be processed.', results });
        }

        return res.json({
            success: true,
            message: `Processed ${results.filter(item => item.success !== false).length} video file(s).`,
            processedCount: results.filter(item => item.success !== false).length,
            skippedCount: results.filter(item => item.skipped).length,
            results,
            patchData: {
                storage: {
                    location: "local",
                    files: {
                        "1080p": { status: "synced", localPath: null, remoteKey: null },
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

        const webProfiles = walkVideoSources(folderPath)
            .map(file => file.endsWith('.web.mp4') ? file : null)
            .filter(Boolean);

        const rootFiles = [];
        function collectWebProfiles(currentPath) {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const absolutePath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    collectWebProfiles(absolutePath);
                    continue;
                }
                if (entry.isFile() && /\.web\.mp4$/i.test(entry.name)) {
                    rootFiles.push(absolutePath);
                }
            }
        }

        collectWebProfiles(folderPath);

        if (!rootFiles.length) {
            return res.status(400).json({ success: false, error: "Cannot down-scale without a master 1080p file present." });
        }

        const generated = [];
        const errors = [];

        for (const sourcePath of rootFiles) {
            const baseName = path.basename(sourcePath).replace(/\.web\.mp4$/i, '');
            const dirName = path.dirname(sourcePath);

            const output720Path = path.join(dirName, `${baseName}.720p.mp4`);
            const output480Path = path.join(dirName, `${baseName}.480p.mp4`);

            const entry = {
                profile1080: path.basename(sourcePath),
                profile720: fs.existsSync(output720Path) ? path.basename(output720Path) : null,
                profile480: fs.existsSync(output480Path) ? path.basename(output480Path) : null,
                sourcePath
            };

            if (!entry.profile720) {
                try {
                    generate720pProfile(sourcePath, output720Path);
                    if (fs.existsSync(output720Path)) {
                        entry.profile720 = path.basename(output720Path);
                    }
                } catch (err720) {
                    const msg = `720p generation failed for ${path.basename(sourcePath)}: ${err720.message}`;
                    logger.error(msg);
                    errors.push(msg);
                }
            }

            if (!entry.profile480) {
                try {
                    generate480pProfile(sourcePath, output480Path);
                    if (fs.existsSync(output480Path)) {
                        entry.profile480 = path.basename(output480Path);
                    }
                } catch (err480) {
                    const msg = `480p generation failed for ${path.basename(sourcePath)}: ${err480.message}`;
                    logger.error(msg);
                    errors.push(msg);
                }
            }

            generated.push(entry);
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
            localPath: generated[0]?.profile1080 || metadata.storage.files['1080p']?.localPath || null,
            remoteKey: metadata.storage.files['1080p']?.remoteKey || null
        };

        if (generated.some(item => item.profile720)) {
            metadata.storage.files['720p'] = {
                ...(metadata.storage.files['720p'] || {}),
                status: 'pending',
                localPath: generated.find(item => item.profile720)?.profile720 || null,
                remoteKey: null
            };
        }

        if (generated.some(item => item.profile480)) {
            metadata.storage.files['480p'] = {
                ...(metadata.storage.files['480p'] || {}),
                status: 'pending',
                localPath: generated.find(item => item.profile480)?.profile480 || null,
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

        const hasAtLeastOneProfile = generated.some(item => item.profile720 || item.profile480);
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
            generatedCount: generated.length,
            patchData: {
                "720p": generated.some(item => item.profile720) ? { status: "pending", localPath: generated.find(item => item.profile720)?.profile720 || null, remoteKey: null } : null,
                "480p": generated.some(item => item.profile480) ? { status: "pending", localPath: generated.find(item => item.profile480)?.profile480 || null, remoteKey: null } : null
            },
            generated
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.TRANSCODE_WORKER_PORT || 5003;
app.listen(PORT, () => console.log(`⚙️ Multi-Profile Transcoder Engine listening on port ${PORT}`));