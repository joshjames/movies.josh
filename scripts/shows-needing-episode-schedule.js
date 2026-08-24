#!/usr/bin/env node

// Reports which subscribed ("My Shows") series likely have new episodes not
// yet in the local library, so an admin can manually set up a download for
// them via the torrent scheduler tool - there's no automatic "add a download
// schedule when a user subscribes" mechanism yet (see conversation notes,
// 2026-08-22: intentionally deferred until enough real cases are seen to
// design the automation properly).
//
// Method: read every user's subscriptions.json (SeriesSubscriptionService),
// dedupe by imdbId (multiple users can subscribe to the same show - the
// admin only needs to act on it once), then for each unique show compare
// what we have locally (series.json) against a fresh live lookup:
//   - a higher totalSeasons than our series.json knows about -> new season.
//   - more episodes in our own highest season than we have locally -> new
//     episode(s) in a season we're already tracking.
// Either signals "go set up a download for this."
//
// This does NOT attempt to determine "still airing" from metadata (OMDb's
// totalSeasons/episode data is generally more reliable and current than any
// status field) - the episode-count comparison already only flags shows
// that actually have something new, airing or not.
//
// Must run inside a container with access to the app's services (ProfileService,
// SeriesSubscriptionService, MetadataProvider) and the series storage mount,
// e.g.: docker exec movie-streamer-cloudsync-worker node scripts/shows-needing-episode-schedule.js
//
// Usage:
//   node scripts/shows-needing-episode-schedule.js

'use strict';

const fs = require('fs');
const path = require('path');

const ProfileService = require('../src/services/ProfileService');
const SeriesSubscriptionService = require('../src/services/SeriesSubscriptionService');
const metadataProvider = require('../src/services/MetadataProvider');

const SERIES_ROOT = process.env.SERIES_DIR || process.env.BACKFILL_SERIES_DIR || '/app/storage/series';

function readLocalSeriesJson(folderName) {
    if (!folderName) return null;
    const seriesJsonPath = path.join(SERIES_ROOT, folderName, 'series.json');
    if (!fs.existsSync(seriesJsonPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(seriesJsonPath, 'utf-8'));
    } catch (_err) {
        return null;
    }
}

function highestLocalSeasonAndEpisode(seriesJson) {
    const seasons = Object.keys(seriesJson?.seasons || {}).map(Number).filter(Number.isFinite);
    if (!seasons.length) return { season: 0, episode: 0, totalSeasons: parseInt(seriesJson?.totalSeasons, 10) || 0 };
    const highestSeason = Math.max(...seasons);
    const episodes = (seriesJson.seasons[String(highestSeason)]?.episodes || []).map((e) => parseInt(e.episodeNumber, 10)).filter(Number.isFinite);
    const highestEpisode = episodes.length ? Math.max(...episodes) : 0;
    return {
        season: highestSeason,
        episode: highestEpisode,
        episodeCountInSeason: episodes.length,
        totalSeasons: parseInt(seriesJson?.totalSeasons, 10) || highestSeason
    };
}

async function main() {
    const users = await ProfileService.listUsers();
    console.log(`[shows-schedule] ${users.length} user(s) to check for subscriptions.`);

    // imdbId -> { title, folderName, subscribers: [] }
    const byShow = new Map();

    for (const user of users) {
        const { items } = await SeriesSubscriptionService.readSubscriptions(user);
        for (const item of items) {
            if (!item.imdbId || item.autoGet === false) continue;
            const existing = byShow.get(item.imdbId) || {
                imdbId: item.imdbId,
                title: item.title,
                folderName: item.folderName,
                subscribers: []
            };
            existing.subscribers.push(user);
            if (!existing.folderName && item.folderName) existing.folderName = item.folderName;
            if (!existing.title && item.title) existing.title = item.title;
            byShow.set(item.imdbId, existing);
        }
    }

    console.log(`[shows-schedule] ${byShow.size} unique subscribed show(s) (autoGet enabled) across all users.\n`);

    const needsAttention = [];
    const upToDate = [];
    const noLocalData = [];

    for (const show of byShow.values()) {
        const seriesJson = readLocalSeriesJson(show.folderName);
        if (!seriesJson) {
            noLocalData.push(show);
            continue;
        }

        const local = highestLocalSeasonAndEpisode(seriesJson);

        let liveTotalSeasons = local.totalSeasons;
        let liveEpisodeCountInSeason = local.episodeCountInSeason;
        try {
            const liveMeta = await metadataProvider.fetchMetadataWithFallback({
                imdbId: show.imdbId,
                title: show.title,
                contentType: 'series'
            });
            if (liveMeta?.data?.totalSeasons) {
                liveTotalSeasons = parseInt(liveMeta.data.totalSeasons, 10) || local.totalSeasons;
            }

            const liveEpisodes = await metadataProvider.fetchSeasonEpisodesWithFallback({
                imdbId: show.imdbId,
                title: show.title,
                season: local.season || 1
            });
            if (Array.isArray(liveEpisodes)) {
                liveEpisodeCountInSeason = liveEpisodes.length;
            }
        } catch (err) {
            console.warn(`[shows-schedule] Live lookup failed for ${show.title || show.imdbId}: ${err.message}`);
        }

        const newSeasonAvailable = liveTotalSeasons > local.totalSeasons;
        const newEpisodeInCurrentSeason = liveEpisodeCountInSeason > (local.episodeCountInSeason || 0);

        const record = {
            ...show,
            localHighest: `S${local.season}E${local.episode}`,
            localTotalSeasons: local.totalSeasons,
            liveTotalSeasons,
            liveEpisodeCountInCurrentSeason: liveEpisodeCountInSeason,
            localEpisodeCountInCurrentSeason: local.episodeCountInSeason,
            newSeasonAvailable,
            newEpisodeInCurrentSeason
        };

        if (newSeasonAvailable || newEpisodeInCurrentSeason) {
            needsAttention.push(record);
        } else {
            upToDate.push(record);
        }
    }

    console.log(`=== NEEDS A DOWNLOAD SCHEDULE (${needsAttention.length}) ===`);
    for (const r of needsAttention) {
        const reasons = [];
        if (r.newSeasonAvailable) reasons.push(`new season available (have ${r.localTotalSeasons}, provider says ${r.liveTotalSeasons})`);
        if (r.newEpisodeInCurrentSeason) reasons.push(`current season S${r.localHighest.match(/S(\d+)/)[1]} has ${r.liveEpisodeCountInCurrentSeason} episodes, we have ${r.localEpisodeCountInCurrentSeason}`);
        console.log(`  ${r.title || r.imdbId} (${r.imdbId}) - folder: ${r.folderName} - subscribers: ${r.subscribers.length} - local highest: ${r.localHighest}`);
        console.log(`    -> ${reasons.join('; ')}`);
    }

    console.log(`\n=== Up to date (${upToDate.length}) ===`);
    for (const r of upToDate) {
        console.log(`  ${r.title || r.imdbId} (${r.imdbId}) - local highest: ${r.localHighest}`);
    }

    console.log(`\n=== No local series.json found (${noLocalData.length}) - check folderName/subscription data ===`);
    for (const r of noLocalData) {
        console.log(`  ${r.title || r.imdbId} (${r.imdbId}) - folderName recorded as: "${r.folderName || '(none)'}"`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[shows-schedule] Fatal error:', err.message || err);
        process.exit(1);
    });
