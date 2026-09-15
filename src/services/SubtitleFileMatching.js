// Single source of truth for "does this subtitle file belong to this video
// file" - shared between media.routes.js (deciding what to serve the player)
// and TranscoderWorker.js (deciding whether a video already has a subtitle,
// before extracting one from its embedded streams). These used to be two
// separately-hand-maintained copies of similar logic that drifted out of
// sync twice; consolidated here so there's only one place to get it right.
'use strict';

const path = require('path');

function normalizeSubtitleToken(value = '') {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Extracts a normalized "S01E01"-style key from a filename, or null if none
// is found. This is the most reliable way to relate a TV subtitle to its
// episode's video file - release-tag tokens ("web", "1080p", "English",
// a fansub group name, ...) commonly differ between the two even when both
// are correctly named for the same episode, but the season/episode number
// itself is the one thing that should always agree.
function extractSeasonEpisodeKey(name = '') {
    const match = String(name || '').match(/s(\d{1,2})e(\d{1,3})/i);
    if (!match) return null;
    return `s${parseInt(match[1], 10)}e${parseInt(match[2], 10)}`;
}

// videoBaseName: the video's filename with its extension stripped (e.g.
// `path.parse(videoPath).name` - note this deliberately still includes a
// trailing ".web" if the video is named "Show.S01E01.web.mp4", since that's
// how every existing caller already computes it).
// subtitleFileName: the candidate subtitle's filename, WITH extension
// (e.g. "Show.S01E01.English.srt").
// allowGenericEnglishFallback: whether a bare "English.srt"/"English.vtt"
// (no relation check at all) should count as a match - only safe when the
// video is known to be the only one in its folder (a movie), never for a TV
// episode whose season folder is shared by many episodes' videos.
function isSubtitleRelatedToVideo(subtitleFileName, videoBaseName, { allowGenericEnglishFallback = false } = {}) {
    const file = String(subtitleFileName || '');
    const base = String(videoBaseName || '');
    if (!file || !base) return false;

    if (allowGenericEnglishFallback && (file === 'English.srt' || file === 'English.vtt')) {
        return true;
    }

    const fileBase = path.parse(file).name;
    if (file.startsWith(`${base}.`) || base.startsWith(`${fileBase}.`)) {
        return true;
    }

    const fileToken = normalizeSubtitleToken(file);
    const baseToken = normalizeSubtitleToken(base);
    if (fileToken.includes(baseToken) || baseToken.includes(fileToken)) {
        return true;
    }

    // Catches names that share a common prefix and then diverge with
    // different, unrelated trailing tokens - e.g. video "Show.S01E01.web"
    // vs subtitle "Show.S01E01.English.srt": neither fully contains the
    // other, but both identify the same episode.
    const videoEpisodeKey = extractSeasonEpisodeKey(base);
    const fileEpisodeKey = extractSeasonEpisodeKey(file);
    if (videoEpisodeKey && fileEpisodeKey && videoEpisodeKey === fileEpisodeKey) {
        return true;
    }

    return false;
}

module.exports = {
    normalizeSubtitleToken,
    extractSeasonEpisodeKey,
    isSubtitleRelatedToVideo
};
