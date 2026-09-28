// src/services/MediaFileWalker.js
// Shared file-discovery logic for the content pipeline. Extracted from
// three previously-independent, slightly-differently-scoped implementations
// (TranscoderWorker.js's walkVideoSources - fully recursive; CloudSyncWorker.js's
// walkSeriesEpisodeFiles - one-level-deep season folders; MetadataWorker.js's
// own inline physicalFileMap walk) - a latent drift risk on its own, and
// blocking for the per-episode fan-out work (PipelineWorker.js needs to
// enumerate the same file list a stage worker would, before deciding
// whether to dispatch one job or fan out into per-file children).
'use strict';

const fs = require('fs');
const path = require('path');

const RESOLUTION_PROFILES = ['1080p', '720p', '480p'];
const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.wmv'];

// Same suffix convention used everywhere in the pipeline for a
// browser-ready profile: ".web.mp4" for 1080p, ".720p.mp4"/".480p.mp4" for
// the rest.
function profileSuffix(profile) {
    return profile === '1080p' ? '.web.mp4' : `.${profile}.mp4`;
}

// Same episode-matching regex used everywhere series.json gets built from
// disk, so file discovery can never disagree with what series.json thinks
// exists.
function parseEpisodeFromFilename(fileName) {
    const match = String(fileName || '').match(/s\s*(\d+)\s*e\s*(\d+)/i);
    if (!match) return null;
    return { season: parseInt(match[1], 10), episode: parseInt(match[2], 10) };
}

function isVideoCandidate(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (!VIDEO_EXTENSIONS.includes(path.extname(lower))) return false;
    if (lower.endsWith('.web.mp4')) return false;
    // Must match the *generated profile* filename shape exactly
    // (`<stem>.720p.mp4` / `<stem>.480p.mp4`), not just contain "720p"/
    // "480p" anywhere - scene-release source filenames very commonly have
    // their own resolution tag (e.g. "Show.S01E01.720p.WEB-DL.x264.mkv").
    if (lower.endsWith('.720p.mp4')) return false;
    if (lower.endsWith('.480p.mp4')) return false;
    return true;
}

// Fully recursive walk for raw (not-yet-transcoded) source video files.
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

// Fully recursive walk for already-transcoded 1080p (".web.mp4") outputs.
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

// Walk a series root's season subfolders and, for each episode found on
// disk, record the local file path for whichever resolution profiles
// already exist. One level deep only (season folders directly under the
// series root).
function walkSeriesEpisodeFiles(seriesRootPath) {
    const episodes = new Map(); // key: "season-episode" -> { season, episode, files: { profile: absolutePath } }

    let entries;
    try {
        entries = fs.readdirSync(seriesRootPath, { withFileTypes: true });
    } catch (_err) {
        return episodes;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const seasonDir = path.join(seriesRootPath, entry.name);

        let files;
        try {
            files = fs.readdirSync(seasonDir);
        } catch (_err) {
            continue;
        }

        for (const file of files) {
            const parsed = parseEpisodeFromFilename(file);
            if (!parsed) continue;

            const key = `${parsed.season}-${parsed.episode}`;
            if (!episodes.has(key)) {
                episodes.set(key, { season: parsed.season, episode: parsed.episode, files: {} });
            }
            const record = episodes.get(key);

            for (const profile of RESOLUTION_PROFILES) {
                if (record.files[profile]) continue; // already matched one for this profile
                if (file.toLowerCase().endsWith(profileSuffix(profile))) {
                    record.files[profile] = path.join(seasonDir, file);
                }
            }
        }
    }

    return episodes;
}

module.exports = {
    RESOLUTION_PROFILES,
    VIDEO_EXTENSIONS,
    profileSuffix,
    parseEpisodeFromFilename,
    isVideoCandidate,
    walkVideoSources,
    walkWebProfiles,
    walkSeriesEpisodeFiles
};
