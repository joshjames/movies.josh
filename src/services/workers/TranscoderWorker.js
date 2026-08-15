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
const BROWSER_SAFE_AUDIO_CODECS = new Set(['aac', 'mp3']);

function isVideoCandidate(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (!EXTENSIONS.includes(path.extname(lower))) return false;
    if (lower.endsWith('.web.mp4')) return false;
    // Must match the *generated profile* filename shape exactly
    // (`<stem>.720p.mp4` / `<stem>.480p.mp4` from generate720pProfile/
    // generate480pProfile below), not just contain "720p"/"480p" anywhere -
    // scene-release source filenames very commonly have their own resolution
    // tag (e.g. "Show.S01E01.720p.WEB-DL.x264.mkv"), and the previous
    // `.includes()` check silently excluded every one of those from ever
    // being picked up for transcoding at all.
    if (lower.endsWith('.720p.mp4')) return false;
    if (lower.endsWith('.480p.mp4')) return false;
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

function walkWebProfiles(rootFolder) {
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

            if (entry.isFile() && /\.web\.mp4$/i.test(entry.name)) {
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
        return { mapArgs: ['-map', '0:v:0'], dispositionArgs: [], chosenTrack: null, audioTracks: [] };
    }

    const preferred = tracks.find(track => track.isDefault && track.isEnglish)
        || tracks.find(track => track.isEnglish)
        || tracks.find(track => track.isDefault)
        || tracks[0];

    // All tracks get mapped/preserved (e.g. anime with a Japanese original
    // plus an English dub) - `chosenTrack` above was previously computed and
    // then silently discarded by every caller, so nothing ever actually
    // marked which track a player should default to. `-disposition:a:N` on
    // the *output* stream position (0, 1, 2... in map order, not the
    // original input stream index) is what fixes that: without it, players
    // fall back to whichever track happens to be first in the source file,
    // which for many anime/foreign releases is the original-language track,
    // not English.
    const mapArgs = ['-map', '0:v:0'];
    const dispositionArgs = [];
    tracks.forEach((track, outputAudioIndex) => {
        mapArgs.push('-map', `0:${track.streamIndex}`);
        dispositionArgs.push(`-disposition:a:${outputAudioIndex}`, track === preferred ? 'default' : '0');
    });

    return { mapArgs, dispositionArgs, chosenTrack: preferred, audioTracks: tracks };
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
    const { mapArgs, dispositionArgs } = buildAudioMapArgs(inputPath);
    // -c copy strips encoding load entirely; +faststart relocates moov atom for immediate web playback
    const ffmpegCmd = [
        'ffmpeg',
        '-threads', '4',
        '-i', `"${inputPath}"`,
        ...mapArgs,
        '-c:v', 'copy',
        '-c:a', 'copy',
        ...dispositionArgs,
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
    const { mapArgs, dispositionArgs } = buildAudioMapArgs(inputPath);
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
        ...dispositionArgs,
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
    const { mapArgs, dispositionArgs } = buildAudioMapArgs(inputPath);
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
        ...dispositionArgs,
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
    const { mapArgs, dispositionArgs } = buildAudioMapArgs(inputPath);
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
        ...dispositionArgs,
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
        const hasOnlyBrowserSafeAudio = audioCodecs.length > 0 && audioCodecs.every(codec => BROWSER_SAFE_AUDIO_CODECS.has(codec));
        // Even an AAC/MP3 track can be a 5.1/7.1 surround mix a browser won't
        // play correctly - that also needs the audio-fix pass, not just a copy.
        const hasOnlyStereoOrLess = audioStreams.length > 0 && audioStreams.every(stream => (Number(stream.channels) || 0) <= 2);
        const isVideoWebSafe = videoCodec === 'h264' || videoCodec === 'hevc';
        const isAudioWebSafe = hasOnlyBrowserSafeAudio && hasOnlyStereoOrLess;

        return {
            videoCodec,
            audioCodec,
            audioTracks: audioStreams.length,
            hasMultipleAudioTracks: audioStreams.length > 1,
            isVideoWebSafe,
            isAudioWebSafe,
            isWebNative: isVideoWebSafe && isAudioWebSafe
        };
    } catch (err) {
        logger.error(`ffprobe inspection crash on ${path.basename(filePath)}: ${err.message}`);
        return {
            videoCodec: 'unknown', audioCodec: 'unknown', audioTracks: 0, hasMultipleAudioTracks: false,
            isVideoWebSafe: false, isAudioWebSafe: false, isWebNative: false
        };
    }
}

// =========================================================================
// 🔊 AUDIO-ONLY FAST PASS (video copy, audio re-encode)
// For sources whose video is already browser-safe (h264/hevc) but whose
// audio isn't (wrong codec - AC3/EAC3/DTS/Opus etc - or more than 2
// channels): copies the video stream untouched (no CPU-heavy re-encode) and
// only re-encodes audio to AAC stereo. Same idea as the Episode Manager's
// existing "force audio fix" action, just running in the isolated
// transcoder-worker container/process instead of blocking the web server.
// =========================================================================
function remuxWithAudioFix(inputPath, outputPath) {
    logger.debug(`🔊 Running Audio-Only Fix Pass [Video Copy + AAC Downmix] -> ${path.basename(outputPath)}`);
    const { mapArgs, dispositionArgs } = buildAudioMapArgs(inputPath);
    const ffmpegCmd = [
        'ffmpeg',
        '-threads', '4',
        '-i', `"${inputPath}"`,
        ...mapArgs,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', '160k',
        ...dispositionArgs,
        '-movflags', '+faststart',
        '-y', `"${outputPath}"`
    ].join(' ');
    execSync(ffmpegCmd, { stdio: 'pipe' });
}

// =========================================================================
// 📝 EMBEDDED SUBTITLE EXTRACTION
// Ported from the Episode Manager's equivalent (media.routes.js) so the
// same "pull embedded subs out to sidecar files" behavior is available for
// any file this worker transcodes, not just TV episodes triggered manually
// through that admin panel.
// =========================================================================
function probeSubtitleStreams(filePath) {
    try {
        const command = `ffprobe -v error -show_entries stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired -of json "${filePath}"`;
        const output = JSON.parse(execSync(command).toString());
        return Array.isArray(output.streams) ? output.streams.filter(s => s.codec_type === 'subtitle') : [];
    } catch (err) {
        logger.error(`ffprobe subtitle scan crash on ${path.basename(filePath)}: ${err.message}`);
        return [];
    }
}

function inferSubtitleLanguage(stream = {}) {
    const lang = String(stream?.tags?.language || '').trim().toLowerCase();
    if (lang) return lang;
    const title = String(stream?.tags?.title || '').toLowerCase();
    if (title.includes('english')) return 'eng';
    return 'und';
}

function normalizeSubtitleLangToken(value = '') {
    const token = String(value || '').trim().toLowerCase();
    if (token === 'en' || token === 'eng' || token === 'english') return 'eng';
    if (!token) return 'und';
    return token.slice(0, 3);
}

function exportSubtitleStreamToPath(videoPath, streamIndex, outPathBase) {
    const outSrt = `${outPathBase}.srt`;
    try {
        execSync(`ffmpeg -y -i "${videoPath}" -map 0:${streamIndex} -c:s srt "${outSrt}"`, { stdio: 'pipe' });
        if (fs.existsSync(outSrt)) return { path: outSrt, format: 'srt' };
    } catch (_err) {
        // fall through to a webvtt attempt below
    }

    const outVtt = `${outPathBase}.vtt`;
    try {
        execSync(`ffmpeg -y -i "${videoPath}" -map 0:${streamIndex} -c:s webvtt "${outVtt}"`, { stdio: 'pipe' });
        if (fs.existsSync(outVtt)) return { path: outVtt, format: 'vtt' };
    } catch (_err) {
        // this subtitle stream just isn't extractable (e.g. bitmap-based PGS)
    }

    return null;
}

function hasExistingSubtitles(folderPath) {
    try {
        return fs.readdirSync(folderPath).some(f => /\.(srt|vtt)$/i.test(f));
    } catch (_err) {
        return false;
    }
}

// Extracts embedded subtitle tracks from a source video into standalone
// .srt/.vtt sidecar files, before the source potentially gets deleted by the
// transcode step below. Best-effort and non-fatal - a source with no
// subtitle streams, or one where extraction fails, just yields no output.
// The default track lands as "English.srt" next to the video (matching the
// existing sidecar-subtitle convention SubtitleWorker.js already looks for);
// any others go into a "subs" subfolder.
function extractEmbeddedSubtitles(videoPath) {
    const source = path.resolve(String(videoPath || ''));
    if (!fs.existsSync(source)) return { exported: [] };

    const subtitleStreams = probeSubtitleStreams(source);
    if (!subtitleStreams.length) return { exported: [] };

    const dir = path.dirname(source);
    const parsed = path.parse(source);
    const baseName = String(parsed.name || '').replace(/\.web$/i, '');
    const subsDir = path.join(dir, 'subs');

    const streams = subtitleStreams
        .map(stream => ({
            streamIndex: Number(stream?.index),
            lang: normalizeSubtitleLangToken(inferSubtitleLanguage(stream)),
            isDefault: Number(stream?.disposition?.default) === 1,
            isEnglish: ['eng', 'en'].includes(normalizeSubtitleLangToken(inferSubtitleLanguage(stream)))
        }))
        .filter(row => Number.isFinite(row.streamIndex));

    if (!streams.length) return { exported: [] };

    const defaultCandidate = streams.find(row => row.isDefault && row.isEnglish)
        || streams.find(row => row.isEnglish)
        || streams.find(row => row.isDefault)
        || streams[0];

    const exported = [];
    for (const row of streams) {
        const isDefaultSubtitle = row.streamIndex === defaultCandidate.streamIndex;
        const outBase = isDefaultSubtitle
            ? path.join(dir, 'English')
            : path.join((fs.mkdirSync(subsDir, { recursive: true }), subsDir), `${baseName}.sub.${row.streamIndex}.${row.lang}`);

        const extracted = exportSubtitleStreamToPath(source, row.streamIndex, outBase);
        if (!extracted) continue;

        exported.push({ streamIndex: row.streamIndex, lang: row.lang, isDefault: isDefaultSubtitle, path: extracted.path });
    }

    return { exported };
}

function processSingleVideoFile(inputPath, options = {}) {
    const forceReprocess = Boolean(options.forceReprocess);
    // Explicit override to force the audio-only pass regardless of automatic
    // detection - e.g. an admin retrying a title where the auto-detected mode
    // didn't produce a satisfactory result. Automatic per-file detection
    // (video-safe? audio-safe?) already picks the cheapest sufficient mode by
    // default, so this flag is an escape hatch, not something you need to set
    // for the common case.
    const forceAudioFixOnly = Boolean(options.audioFixOnly);
    const inputIsWebProfile = /\.web\.mp4$/i.test(String(inputPath || ''));

    if (forceReprocess && inputIsWebProfile) {
        if (forceAudioFixOnly) {
            const tempOutputPath = inputPath.replace(/\.web\.mp4$/i, '.web.audiofix.tmp.mp4');
            logger.debug(`🔊 [Force Audio Fix] Rebuilding existing web profile audio only: ${path.basename(inputPath)}`);
            remuxWithAudioFix(inputPath, tempOutputPath);
            fs.renameSync(tempOutputPath, inputPath);
            return {
                success: true,
                skipped: false,
                output1080Path: inputPath,
                inputPath,
                media: inspectMediaStreams(inputPath),
                forceReprocessed: true,
                mode: 'audio-fix'
            };
        }

        const tempOutputPath = inputPath.replace(/\.web\.mp4$/i, '.web.rebuild.tmp.mp4');
        logger.debug(`♻️ [Force Reprocess] Rebuilding existing web profile: ${path.basename(inputPath)}`);
        generate1080pProfile(inputPath, tempOutputPath);
        fs.renameSync(tempOutputPath, inputPath);
        return {
            success: true,
            skipped: false,
            output1080Path: inputPath,
            inputPath,
            media: inspectMediaStreams(inputPath),
            forceReprocessed: true,
            mode: 'full-reencode'
        };
    }

    const parsedPath = path.parse(inputPath);
    const output1080Path = path.join(parsedPath.dir, `${parsedPath.name}.web.mp4`);

    if (fs.existsSync(output1080Path) && !forceReprocess) {
        logger.debug(`🎯 [Web Target Confirmed] ${path.basename(inputPath)} already has optimized asset: ${path.basename(output1080Path)}. Skipping.`);
        return {
            success: true,
            skipped: true,
            output1080Path,
            inputPath
        };
    }

    if (forceReprocess && fs.existsSync(output1080Path) && inputPath !== output1080Path) {
        fs.unlinkSync(output1080Path);
    }

    // Best-effort embedded-subtitle extraction before the source potentially
    // gets deleted below. Skipped if the folder already has any .srt/.vtt -
    // never overwrite a subtitle that might have come from a better external
    // source (YIFY/Subliminal via the SUBTITLES worker stage).
    let subtitleExtraction = null;
    if (!hasExistingSubtitles(parsedPath.dir)) {
        try {
            subtitleExtraction = extractEmbeddedSubtitles(inputPath);
        } catch (subErr) {
            logger.error(`⚠️ Subtitle extraction failed for ${path.basename(inputPath)}: ${subErr.message}`);
        }
    }

    const media = inspectMediaStreams(inputPath);
    let mode;
    if (media.isWebNative) {
        mode = 'remux';
    } else if (media.isVideoWebSafe && (forceAudioFixOnly || !media.isAudioWebSafe)) {
        mode = 'audio-fix';
    } else {
        mode = 'full-reencode';
    }

    try {
        if (mode === 'remux') {
            logger.debug(`🚀 [Fast Pass Match] Streams match requirements. Wrapping container for ${path.basename(inputPath)}`);
            if (inputPath !== output1080Path) {
                remuxToWebContainer(inputPath, output1080Path);
            }
        } else if (mode === 'audio-fix') {
            logger.debug(`🔊 [Audio Fix Pass] Video already web-safe, re-encoding audio only for ${path.basename(inputPath)}`);
            remuxWithAudioFix(inputPath, output1080Path);
        } else {
            generate1080pProfile(inputPath, output1080Path);
        }
    } catch (transcodeErr) {
        if (mode === 'full-reencode') throw transcodeErr;
        logger.error(`⚠️ ${mode} pass failed, falling back to full hardware decode loop: ${transcodeErr.message}`);
        generate1080pProfile(inputPath, output1080Path);
        mode = 'full-reencode';
    }

    if (fs.existsSync(output1080Path) && inputPath !== output1080Path) {
        fs.unlinkSync(inputPath);
    }

    return {
        success: true,
        skipped: false,
        output1080Path,
        inputPath,
        media,
        mode,
        subtitleExtraction
    };
}

// =========================================================================
// 📥 PRIMARY INGESTION WORKER ROUTE
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, folderName, contentType } = req.body;
    const isSeries = contentType === 'series';
    const forceReprocess = req.body?.forceReprocess === true || String(req.body?.forceReprocess || '').toLowerCase() === 'true';
    // Force the video-copy/audio-reencode-only pass regardless of what
    // automatic detection would pick - see processSingleVideoFile's comment.
    const audioFixOnly = req.body?.audioFixOnly === true || String(req.body?.audioFixOnly || '').toLowerCase() === 'true';

    if (!folderPath) {
        return res.status(400).json({ success: false, error: "Missing required folderPath context." });
    }

    try {
        if (!fs.existsSync(folderPath)) {
            return res.json({ success: false, error: `Directory target does not exist on disk: ${folderPath}` });
        }

        let sourceVideos = walkVideoSources(folderPath);
        if (!sourceVideos.length && forceReprocess) {
            sourceVideos = walkWebProfiles(folderPath);
            if (sourceVideos.length) {
                logger.debug(`♻️ [Force Reprocess] No original source files found; reprocessing existing web profiles in place.`);
            }
        }

        if (!sourceVideos.length) {
            // Distinguish "genuinely nothing to work with" from "already fully
            // transcoded, and the raw originals were since cleaned up" - the latter
            // is the normal steady state for an old/complete series, not a failure.
            const existingProfileCount = walkWebProfiles(folderPath).length;
            if (existingProfileCount > 0) {
                return res.json({
                    success: true,
                    message: "No raw source files remain; all profiles already transcoded.",
                    processedCount: 0,
                    skippedCount: existingProfileCount
                });
            }
            return res.json({ success: false, error: "No viable processing source video found." });
        }

        const results = [];
        for (const inputPath of sourceVideos) {
            try {
                results.push(processSingleVideoFile(inputPath, { forceReprocess, audioFixOnly }));
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
            forceReprocess,
            results,
            // A series folder can contain many episodes across many seasons, each
            // with its own upload state - there's no single "1080p status" for
            // the whole thing the way there is for a movie folder. Per-episode
            // storage tracking lives in series.json and is written by
            // CloudSyncWorker, not here.
            patchData: isSeries ? {} : {
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