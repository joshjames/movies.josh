// src/services/workers/SubtitleWorker.js
// Multi-Provider Subtitle Extraction Engine featuring YIFY HTML Parsing & Subliminal Fallbacks.

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const logger = require('../logger');

const app = express();
app.use(express.json());

// Standard desktop configuration spoofing parameters to cleanly navigate Cloudflare filters
const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
};

function cleanFallbackTitle(rawName = '') {
    return String(rawName)
        .replace(/\[.*?\]/g, ' ')
        .replace(/\((.*?)\)/g, ' $1 ')
        .replace(/[._-]/g, ' ')
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveSubliminalConfigPath() {
    const preferred = String(process.env.SUBLIMINAL_CONFIG_PATH || '').trim();
    const candidates = [
        preferred,
        '/root/.config/subliminal/subliminal.toml',
        '/home/epic/.config/subliminal/subliminal.toml'
    ].filter(Boolean);

    return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function sanitizeCliToken(value, fallback = '') {
    const cleaned = String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
    return cleaned || fallback;
}

function classifySubtitleFile(fileName = '') {
    const raw = String(fileName || '').toLowerCase();
    const isForced = /\bforced\b|\.forced\.|\bforc\b/.test(raw);
    const isHearingImpaired = /\b(sdh|hi|cc|closed.?captions?|hearing.?impaired|deaf)\b/.test(raw);
    const isEnglish = /\b(en|eng|english)\b/.test(raw);
    const isDefault = /\bdefault\b/.test(raw);

    let language = 'und';
    if (isEnglish) language = 'eng';
    else if (/\b(spa|es|spanish)\b/.test(raw)) language = 'spa';
    else if (/\b(hin|hi|hindi)\b/.test(raw)) language = 'hin';

    return {
        language,
        isForced,
        isHearingImpaired,
        isEnglish,
        isDefault
    };
}

function scoreSubtitleRecord(record) {
    let score = 0;
    const label = String(record.label || record.relativePath || '').toLowerCase();
    const language = String(record.language || '').toLowerCase();

    if (language === 'eng' || language === 'en') score += 80;
    if (record.isDefaultCandidate) score += 40;
    if (/\bdefault\b/.test(label)) score += 20;
    if (/\b(forced|sdh|hi|deaf|commentary)\b/.test(label)) score -= 35;
    if (record.isForced) score -= 25;
    if (record.isHearingImpaired) score -= 15;
    if (record.isEmbedded) score += 10;

    return score;
}

function pickDefaultSubtitleRecord(records = []) {
    if (!Array.isArray(records) || records.length === 0) return null;
    return [...records].sort((a, b) => scoreSubtitleRecord(b) - scoreSubtitleRecord(a))[0] || null;
}

function readLocalSubtitleContext(folderPath) {
    try {
        const metadataPath = path.join(folderPath, 'metadata.json');
        if (!fs.existsSync(metadataPath)) return null;

        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        return {
            imdbId: metadata.imdbId || null,
            title: metadata.title || metadata.name || null,
            year: metadata.year || null,
            contentType: metadata.contentType || null
        };
    } catch (err) {
        logger.debug(`⚠️ [SUBTITLES] Could not read local metadata fallback: ${err.message}`, 'warn');
        return null;
    }
}

async function resolveImdbFallback({ imdbId, folderName, folderPath, contentType }) {
    if (imdbId) return String(imdbId).startsWith('tt') ? imdbId : `tt${imdbId}`;

    const localContext = readLocalSubtitleContext(folderPath);
    if (localContext?.imdbId) {
        logger.debug(`🧩 [SUBTITLES] IMDb resolved from local metadata.json: ${localContext.imdbId}`);
        return String(localContext.imdbId).startsWith('tt') ? localContext.imdbId : `tt${localContext.imdbId}`;
    }

    const titleHint = cleanFallbackTitle(folderName || localContext?.title || path.basename(folderPath || ''));
    if (!titleHint) return null;

    const inferredType = contentType || localContext?.contentType || (String(folderPath || '').includes('/series') ? 'series' : 'movie');
    const yearMatch = String(folderName || localContext?.title || '').match(/\b((?:19|20)\d{2})\b/);
    const year = yearMatch?.[1] || localContext?.year || '';

    let query = `http://www.omdbapi.com/?apikey=${process.env.OMDB_API_KEY || '84196d01'}&type=${inferredType}&t=${encodeURIComponent(titleHint)}`;
    if (year) query += `&y=${encodeURIComponent(year)}`;

    try {
        const omdbRes = await axios.get(query, { timeout: 6000 });
        if (omdbRes.data?.Response === 'True' && omdbRes.data?.imdbID) {
            logger.debug(`🧩 [SUBTITLES] IMDb resolved by title fallback: ${omdbRes.data.imdbID} (${titleHint})`);
            return omdbRes.data.imdbID;
        }
    } catch (err) {
        logger.debug(`⚠️ [SUBTITLES] OMDb fallback lookup failed for "${titleHint}": ${err.message}`, 'warn');
    }

    return null;
}

/**
 * Strategy 1: Programmatic YIFY HTML Scratch-Pad Parser
 */
async function fetchYifySubtitles(imdbId, folderPath) {
    const targetImdb = imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`;
    const tempZipPath = path.join(folderPath, `temp_subs_${targetImdb}.zip`);
    
    try {
        const movieUrl = `https://yifysubtitles.ch/movie-imdb/${targetImdb}`;
        
        logger.debug(`📡 Querying YIFY database for IMDB: ${targetImdb}`);
        const response = await axios.get(movieUrl, { headers: REQUEST_HEADERS, timeout: 15000 });
        const html = response.data;

        // Extract lines containing English subtitle detail paths
        const subtitlePageMatches = html.match(/\/subtitles\/[a-zA-Z0-9-]+-english-yify-\d+/g);
        if (!subtitlePageMatches || subtitlePageMatches.length === 0) {
            throw new Error("No explicit English subtitle track links found in HTML manifest.");
        }

        // Isolate the highest quality or first matched variant path reference
        const chosenSubPagePath = subtitlePageMatches[0];
        const detailPageUrl = `https://yifysubtitles.ch${chosenSubPagePath}`;
        
        logger.debug(`🔍 Navigating to sub-page tracking link: ${detailPageUrl}`);
        const detailResponse = await axios.get(detailPageUrl, { headers: REQUEST_HEADERS, timeout: 15000 });
        const detailHtml = detailResponse.data;

        // Isolate the exact .zip file stream locator endpoint
        const zipDownloadMatch = detailHtml.match(/\/subtitle\/[a-zA-Z0-9-]+-english-yify-\d+\.zip/);
        if (!zipDownloadMatch) {
            throw new Error("Failed extracting binary zip stream path from details segment.");
        }

        const downloadUrl = `https://yifysubtitles.ch${zipDownloadMatch[0]}`;

        logger.debug(`📥 Streaming subtitle binary file: ${downloadUrl}`);
        
        // Anti-403 Configuration: Spoof headers and include Referer target
        const binaryStream = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'arraybuffer',
            headers: {
                ...REQUEST_HEADERS,
                'Referer': detailPageUrl // Crucial header to prove context to Cloudflare
            },
            timeout: 20000
        });

        // Write buffer out to block space cleanly
        fs.writeFileSync(tempZipPath, Buffer.from(binaryStream.data));

        // 🛠️ FIX: Use adm-zip with the correct native method map (.getEntries())
        const zip = new AdmZip(tempZipPath);
        const zipEntries = zip.getEntries();
        
        let srtExtracted = false;
        const standardizedName = 'English.srt';

        zipEntries.forEach((entry) => {
            if (entry.entryName.toLowerCase().endsWith('.srt') && !srtExtracted) {
                // Extract to the target folder natively
                zip.extractEntryTo(entry, folderPath, false, true);
                
                const rawExtractedPath = path.join(folderPath, entry.entryName);
                const finalSrtPath = path.join(folderPath, standardizedName);
                
                if (fs.existsSync(rawExtractedPath)) {
                    fs.renameSync(rawExtractedPath, finalSrtPath);
                    srtExtracted = true;
                }
            }
        });

        // Clean up temporary tracking artifacts instantly
        if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);

        if (srtExtracted) {
            logger.debug(`✨ YIFY Pipeline successfully downloaded and mapped: English.srt`);
            return [{ language: 'eng', relativePath: 'English.srt', source: 'yify' }];
        } else {
            throw new Error("No usable SRT files found inside the downloaded archive container.");
        }

    } catch (err) {
        // Safe clean up fallback check if zip processing bombed out midway
        if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
        logger.debug(`⚠️ YIFY subtitle ingestion skipped: ${err.message}. Routing to fallbacks...`, 'warn');
        return null;
    }
}

/**
 * Strategy 2: CLI Subliminal Backup Engine
 */
function fetchSubliminalFallback(imdbId, folderPath, options = {}) {
    return new Promise((resolve) => {
        logger.debug(`⏳ Starting Subliminal verification routines on folder target...`);
        const language = sanitizeCliToken(process.env.SUBTITLE_LANG || process.env.SUBLIMINAL_LANG || 'en', 'en');
        const safeImdb = sanitizeCliToken(imdbId, '');
        const configPath = resolveSubliminalConfigPath();
        const configArg = configPath ? ` --config "${configPath}"` : '';
        const imdbArg = safeImdb ? ` -i ${safeImdb}` : '';
        const singleMode = options.singleMode !== false;
        const singleArg = singleMode ? ' -s' : '';
        const cmd = `subliminal${configArg} download -l ${language}${imdbArg}${singleArg} "${folderPath}"`;

        if (configPath) {
            logger.debug(`🧩 [SUBTITLES] Using Subliminal config: ${configPath}`);
        } else {
            logger.warn('⚠️ [SUBTITLES] Subliminal config file not found. Running with default providers.', 'warn');
        }

        exec(cmd, (err) => {
            if (err) {
                logger.debug(`⚠️ Subliminal worker execution finished empty. Moving down pipeline.`, 'warn');
                return resolve([]);
            }

            resolve(collectSubtitleRecords(folderPath, 'subliminal'));
        });
    });
}

function walkFiles(rootPath, matcher) {
    const queue = [rootPath];
    const files = [];

    while (queue.length) {
        const current = queue.shift();
        if (!fs.existsSync(current)) continue;

        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_err) {
            continue;
        }

        for (const entry of entries) {
            const next = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(next);
                continue;
            }
            if (!matcher || matcher(entry.name, next)) files.push(next);
        }
    }

    return files;
}

function collectSubtitleRecords(folderPath, source = 'local-cached') {
    const subtitleFiles = walkFiles(folderPath, file => /\.(srt|vtt)$/i.test(file));
    return subtitleFiles.map(filePath => {
        const file = path.basename(filePath);
        const normalized = file.toLowerCase();
        const classification = classifySubtitleFile(file);
        const embeddedMatch = String(file).match(/\.sub\.(\d+)\.([a-z]{2,3})\.(srt|vtt)$/i);
        const streamIndex = embeddedMatch ? parseInt(embeddedMatch[1], 10) : null;
        const language = embeddedMatch?.[2] || classification.language;

        return {
            language,
            relativePath: path.relative(folderPath, filePath),
            source,
            fileName: file,
            label: file,
            streamIndex,
            isEmbedded: Boolean(embeddedMatch),
            isForced: classification.isForced,
            isHearingImpaired: classification.isHearingImpaired,
            isDefaultCandidate: classification.isDefault || classification.isEnglish || language === 'eng'
        };
    });
}

function hasSubtitleTrack(folderPath) {
    return walkFiles(folderPath, file => /\.(srt|vtt)$/i.test(file)).length > 0;
}

function walkVideoFiles(rootPath) {
    const queue = [rootPath];
    const videos = [];
    const allowed = /\.(mkv|mp4|m4v|avi|mov|wmv)$/i;

    while (queue.length) {
        const current = queue.shift();
        if (!fs.existsSync(current)) continue;

        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_err) {
            continue;
        }

        for (const entry of entries) {
            const next = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(next);
                continue;
            }
            if (allowed.test(entry.name)) videos.push(next);
        }
    }

    return videos;
}

function hasSidecarSubtitle(videoPath) {
    const dir = path.dirname(videoPath);
    const base = path.parse(videoPath).name;
    const candidates = [
        `${base}.English.srt`,
        `${base}.en.srt`,
        `${base}.srt`,
        `${base}.English.vtt`,
        `${base}.en.vtt`,
        `${base}.vtt`,
        'English.srt',
        'English.vtt'
    ];

    return candidates.some(name => fs.existsSync(path.join(dir, name)));
}

function extractEmbeddedSubtitleForVideo(videoPath) {
    const probe = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'stream=index,codec_type:stream_tags=language,title',
        '-of', 'json',
        videoPath
    ], { encoding: 'utf8' });

    if (probe.status !== 0) return null;

    let payload;
    try {
        payload = JSON.parse(probe.stdout || '{}');
    } catch (_err) {
        return null;
    }

    const streams = Array.isArray(payload.streams)
        ? payload.streams.filter(s => s.codec_type === 'subtitle')
        : [];
    if (!streams.length) return null;

    const english = streams.find(s => {
        const lang = String(s.tags?.language || '').toLowerCase();
        return lang === 'en' || lang === 'eng';
    });
    const selected = english || streams[0];
    const streamIndex = selected?.index;
    if (!Number.isFinite(streamIndex)) return null;

    const dir = path.dirname(videoPath);
    const base = path.parse(videoPath).name;
    const srtPath = path.join(dir, `${base}.English.srt`);

    const extractSrt = spawnSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'srt',
        srtPath
    ], { encoding: 'utf8' });

    if (extractSrt.status === 0 && fs.existsSync(srtPath)) {
        return {
            language: 'eng',
            relativePath: path.relative(path.dirname(videoPath), srtPath),
            source: 'embedded-mkv',
            fileName: path.basename(srtPath),
            label: path.basename(srtPath),
            streamIndex,
            isEmbedded: true,
            isForced: /forced/i.test(String(selected?.tags?.title || '')),
            isHearingImpaired: false,
            isDefaultCandidate: true
        };
    }

    const vttPath = path.join(dir, `${base}.English.vtt`);
    const extractVtt = spawnSync('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'webvtt',
        vttPath
    ], { encoding: 'utf8' });

    if (extractVtt.status === 0 && fs.existsSync(vttPath)) {
        return {
            language: 'eng',
            relativePath: path.relative(path.dirname(videoPath), vttPath),
            source: 'embedded-mkv',
            fileName: path.basename(vttPath),
            label: path.basename(vttPath),
            streamIndex,
            isEmbedded: true,
            isForced: /forced/i.test(String(selected?.tags?.title || '')),
            isHearingImpaired: false,
            isDefaultCandidate: true
        };
    }

    return null;
}

function extractEmbeddedSubtitles(folderPath, contentType) {
    const candidates = contentType === 'series'
        ? walkVideoFiles(folderPath)
        : (walkVideoFiles(folderPath).slice(0, 1));
    const records = [];

    for (const video of candidates) {
        if (hasSidecarSubtitle(video)) continue;
        const extracted = extractEmbeddedSubtitleForVideo(video);
        if (extracted) {
            records.push({
                language: extracted.language,
                relativePath: path.relative(folderPath, path.join(path.dirname(video), extracted.relativePath)),
                source: extracted.source,
                fileName: extracted.fileName || path.basename(extracted.relativePath),
                label: extracted.label || path.basename(extracted.relativePath),
                streamIndex: extracted.streamIndex ?? null,
                isEmbedded: Boolean(extracted.isEmbedded),
                isForced: Boolean(extracted.isForced),
                isHearingImpaired: Boolean(extracted.isHearingImpaired),
                isDefaultCandidate: Boolean(extracted.isDefaultCandidate)
            });
        }
    }

    return records;
}

// =========================================================================
// 📥 PROCESS API ENDPOINT ROUTING
// =========================================================================
app.post('/process', async (req, res) => {
    const { folderPath, imdbId, folderName, contentType } = req.body;

    if (!folderPath) {
        logger.warn(`⚠️ [SUBTITLES] Missing folderPath. folderName=${folderName || 'unknown'} imdbId=${imdbId || 'missing'}`);
        return res.status(400).json({ success: false, error: "Missing required folderPath context parameter." });
    }

    try {
        const resolvedImdbId = await resolveImdbFallback({ imdbId, folderName, folderPath, contentType });

        // For TV shows, use Subliminal first (provider scoring + guessit matching), then fallback to embedded extraction.
        if (contentType === 'series') {
            const subliminalRecords = await fetchSubliminalFallback(resolvedImdbId, folderPath, { singleMode: false });
            if (subliminalRecords.length > 0) {
                logger.debug(`🧩 [SUBTITLES] Subliminal resolved ${subliminalRecords.length} subtitle file(s) for series.`);
                const defaultSubtitle = pickDefaultSubtitleRecord(subliminalRecords);
                return res.json({
                    success: true,
                    message: 'Series subtitles resolved via Subliminal providers.',
                    patchData: {
                        subtitles: subliminalRecords,
                        subtitleCatalog: subliminalRecords,
                        subtitleSelection: defaultSubtitle ? {
                            defaultRelativePath: defaultSubtitle.relativePath,
                            defaultLanguage: defaultSubtitle.language,
                            defaultLabel: defaultSubtitle.label || defaultSubtitle.fileName || defaultSubtitle.relativePath,
                            source: defaultSubtitle.source,
                            updatedAt: new Date().toISOString()
                        } : null
                        // No pipelineState override here anymore - series now falls through to
                        // the same SUBTITLES -> TRANSCODE -> CLOUDSYNC/COMPLETE progression
                        // movies use, instead of being force-completed right after subtitles.
                    }
                });
            }
        }

        const embeddedRecords = extractEmbeddedSubtitles(folderPath, contentType);
        if (embeddedRecords.length > 0) {
            logger.debug(`🧩 [SUBTITLES] Extracted ${embeddedRecords.length} embedded subtitle track(s) from container files.`);
            const defaultSubtitle = pickDefaultSubtitleRecord(embeddedRecords);
            return res.json({
                success: true,
                message: 'Embedded subtitle tracks extracted from local media containers.',
                patchData: {
                    subtitles: embeddedRecords,
                    subtitleCatalog: embeddedRecords,
                    subtitleSelection: defaultSubtitle ? {
                        defaultRelativePath: defaultSubtitle.relativePath,
                        defaultLanguage: defaultSubtitle.language,
                        defaultLabel: defaultSubtitle.label || defaultSubtitle.fileName || defaultSubtitle.relativePath,
                        source: defaultSubtitle.source,
                        updatedAt: new Date().toISOString()
                    } : null
                }
            });
        }

        // Fast pass: any existing sidecar subtitle file in folder tree.
        if (hasSubtitleTrack(folderPath)) {
            const records = collectSubtitleRecords(folderPath, 'local-cached');
            logger.debug(`⏭️ [SUBTITLES] Skipping [${folderName || path.basename(folderPath)}]. Subtitle track already present on disk.`);
            const defaultSubtitle = pickDefaultSubtitleRecord(records);
            return res.json({
                success: true,
                message: "Subtitle track verified instantly via local storage check.",
                patchData: {
                    subtitles: records,
                    subtitleCatalog: records,
                    subtitleSelection: defaultSubtitle ? {
                        defaultRelativePath: defaultSubtitle.relativePath,
                        defaultLanguage: defaultSubtitle.language,
                        defaultLabel: defaultSubtitle.label || defaultSubtitle.fileName || defaultSubtitle.relativePath,
                        source: defaultSubtitle.source,
                        updatedAt: new Date().toISOString()
                    } : null
                }
            });
        }

        // Step 1: Fire high-speed YIFY custom pipeline
        if (!resolvedImdbId) {
            logger.warn(`⚠️ [SUBTITLES] No IMDb ID could be resolved for ${folderName || path.basename(folderPath)}. Returning clean skip.`);
            return res.json({
                success: true,
                message: 'Subtitle lookup skipped because no IMDb ID could be resolved.',
                patchData: {
                    subtitles: []
                }
            });
        }

        logger.debug(`🧭 [SUBTITLES] Using IMDb ${resolvedImdbId} for subtitle lookup. folderName=${folderName || 'unknown'}`);

        let records = await fetchYifySubtitles(resolvedImdbId, folderPath);

        // Step 2: If YIFY comes up short or hits a wall, execute Subliminal
        if (!records || records.length === 0) {
            records = await fetchSubliminalFallback(resolvedImdbId, folderPath, { singleMode: true });
        }

        // Return unified response structures cleanly back to the Orchestrator loop
        const defaultSubtitle = pickDefaultSubtitleRecord(records);
        return res.json({
            success: true,
            message: records.length > 0 ? "Subtitle profiles resolved successfully." : "Subtitle sweeps completed with empty records.",
            patchData: {
                subtitles: records,
                subtitleCatalog: records,
                subtitleSelection: defaultSubtitle ? {
                    defaultRelativePath: defaultSubtitle.relativePath,
                    defaultLanguage: defaultSubtitle.language,
                    defaultLabel: defaultSubtitle.label || defaultSubtitle.fileName || defaultSubtitle.relativePath,
                    source: defaultSubtitle.source,
                    updatedAt: new Date().toISOString()
                } : null
            }
        });

    } catch (err) {
        logger.error(`❌ Subtitle Worker structural exception on ${folderName}: ${err.message}`, 'error');
        return res.json({ success: false, error: err.message });
    }
});

const PORT = process.env.SUBTITLE_WORKER_PORT || 5002;
app.listen(PORT, () => console.log(`💬 Atomic Subtitle Engine running on loopback port ${PORT}`));