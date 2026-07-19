// src/services/workers/PipelineWorker.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { getPrimaryAppUrl } = require('../../utils/publicOrigin');
const TorrentService = require('../TorrentService');
const SeriesAcquisitionService = require('../SeriesAcquisitionService');
const LibraryScanner = require('../LibraryScanner');
const { getLibrary } = require('../db');
const { normalizeCard, upsertRecentCard } = require('../HomeFeedService');
const { searchIndex: searchTvSeriesIndex } = require('../TvSeriesIndexService');
const MetadataRegistry = require('../MetadataRegistry');
const ProfileService = require('../ProfileService');
const NotificationService = require('../NotificationService');
const MailerService = require('../MailerService');
const SeriesFolderResolver = require('../SeriesFolderResolver');
const { rebuildSeriesManifest } = require('../SeriesIndexService');
const { buildDefaultWorkerEndpoints } = require('../WorkerEndpoints');
const {
    userGroup,
    mergeLibraryGroups,
    normalizeUserKey
} = require('../LibraryAccessService');
const {
    createJob,
    getAllJobs,
    getJob,
    getNextRunnableJob,
    getJobSnapshot,
    updateJob,
    removeJob
} = require('../PipelineQueueService');
const { withDistributedLock } = require('../DistributedLockService');

const QBIT_URL = process.env.QBIT_URL || 'http://qbittorrent:8080';
const WORKER_ENDPOINTS = buildDefaultWorkerEndpoints();
const CLOUDSYNC_REQUIRED_FOR_COMPLETE = ['1', 'true', 'yes'].includes(String(process.env.REQUIRE_CLOUDSYNC_BEFORE_COMPLETE || '').trim().toLowerCase());

let isProcessingPipeline = false;

function normalizeTags(tags) {
    if (!tags) return '';
    return Array.isArray(tags) ? tags.join(',') : String(tags);
}

function isPipelineTorrentTagString(tagStr) {
    return (
        tagStr.includes('movie-streamer') ||
        tagStr.includes('series-streamer') ||
        tagStr.includes('movie-streamer-processed') ||
        tagStr.includes('series-streamer-processed')
    );
}

function inferContentType(tagStr) {
    return tagStr.includes('series-streamer') ? 'series' : 'movie';
}

function parseSeasonEpisodeFromName(name) {
    const raw = String(name || '');
    const sxeMatches = Array.from(raw.matchAll(/s(\d{1,2})\s*e(\d{1,2})/gi));
    const sxe = sxeMatches.length ? sxeMatches[sxeMatches.length - 1] : null;
    if (sxe) {
        return {
            season: parseInt(sxe[1], 10),
            episode: parseInt(sxe[2], 10)
        };
    }

    const seasonOnly = raw.match(/season\s*(\d{1,2})/i) || raw.match(/s(\d{1,2})(?!\d)/i);
    if (seasonOnly) {
        return {
            season: parseInt(seasonOnly[1], 10),
            episode: null
        };
    }

    return { season: null, episode: null };
}

function normalizeImdbId(value) {
    const cleaned = String(value || '').trim().toLowerCase().replace(/^tt/, '');
    if (!/^\d{5,10}$/.test(cleaned)) return null;
    return `tt${cleaned}`;
}

function cleanSeriesTitleFromTorrentName(value) {
    return String(value || '')
        .replace(/\bS\d{1,2}\s*E\d{1,3}\b.*$/i, '')
        .replace(/\b(720p|1080p|2160p|x264|x265|h264|hevc|web[-_. ]?dl|web[-_. ]?rip|bluray|brrip|aac|ddp5\.1|megusta|ingest)\b/gi, ' ')
        .replace(/[._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function inferSeriesImdbIdFromTorrentName(torrentName) {
    const query = cleanSeriesTitleFromTorrentName(torrentName);
    if (!query) return null;
    const candidates = searchTvSeriesIndex(query, 5);
    const best = Array.isArray(candidates) ? candidates[0] : null;
    return normalizeImdbId(best?.imdbId);
}

function normalizeQueueContext(existingContext, torrentName, imdbId) {
    const context = (existingContext && typeof existingContext === 'object') ? existingContext : {};
    const parsed = parseSeasonEpisodeFromName(torrentName);
    const seasonRaw = parseInt(context.season, 10);
    const episodeRaw = parseInt(context.episode, 10);

    const season = Number.isFinite(seasonRaw) && seasonRaw > 0
        ? seasonRaw
        : (Number.isFinite(parsed.season) && parsed.season > 0 ? parsed.season : null);
    const episode = Number.isFinite(episodeRaw) && episodeRaw > 0
        ? episodeRaw
        : (Number.isFinite(parsed.episode) && parsed.episode > 0 ? parsed.episode : null);

    const sourceTypeRaw = String(context.sourceType || '').toLowerCase();
    const sourceType = sourceTypeRaw === 'pack' || sourceTypeRaw === 'episode'
        ? sourceTypeRaw
        : (episode ? 'episode' : (season ? 'pack' : null));

    const addedByUser = normalizeUserKey(context.addedByUser || context.userKey || context.userId);
    const inferredGroup = userGroup(addedByUser);
    const libraryGroups = mergeLibraryGroups(
        context.libraryGroups || [],
        inferredGroup ? [inferredGroup] : [],
        { addGlobalIfMissing: false }
    );

    return {
        imdbId: normalizeImdbId(context.imdbId || imdbId) || null,
        season,
        episode,
        sourceType,
        addedByUser: addedByUser || null,
        libraryGroups,
        targetShowFolder: context.targetShowFolder ? String(context.targetShowFolder) : null
    };
}

function resolveTorrentDownloadPath(torrent) {
    const contentPath = String(torrent.content_path || '').trim();
    const savePath = String(torrent.save_path || '').trim();
    const torrentName = String(torrent.name || '').trim();

    const candidates = [
        contentPath,
        savePath && torrentName ? path.join(savePath, torrentName) : null,
        savePath
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            const stat = fs.lstatSync(candidate);
            if (stat.isDirectory()) return candidate;
            if (stat.isFile()) return path.dirname(candidate);
        } catch (_err) {
            // Ignore bad filesystem candidates and keep trying the next one.
        }
    }

    return contentPath || (savePath && torrentName ? path.join(savePath, torrentName) : savePath || null);
}

function mergeStorage(existingStorage = {}, incomingStorage = {}) {
    return {
        ...existingStorage,
        ...incomingStorage,
        files: {
            ...(existingStorage.files || {}),
            ...(incomingStorage.files || {})
        }
    };
}

function getJobQueueOptions(job) {
    const options = (job?.payload && typeof job.payload.queueOptions === 'object') ? job.payload.queueOptions : {};
    return {
        notifyOnComplete: Boolean(options.notifyOnComplete),
        addToWatchLaterOnComplete: Boolean(options.addToWatchLaterOnComplete)
    };
}

function getJobOwner(job) {
    const payload = (job && typeof job.payload === 'object') ? job.payload : {};
    const queueContext = (payload && typeof payload.queueContext === 'object') ? payload.queueContext : {};
    return normalizeUserKey(
        queueContext.addedByUser ||
        queueContext.userKey ||
        queueContext.userId ||
        payload.addedByUser
    );
}

function buildLibraryHref(item, contentType) {
    if (!item || !item.id) return '/';
    if (contentType === 'series') {
        return `/series.html?id=${encodeURIComponent(item.id)}`;
    }
    return `/player.html?id=${encodeURIComponent(item.id)}`;
}

async function runQueueCompletionHooks(job, libraryItem) {
    const owner = getJobOwner(job);
    if (!owner) return;

    const options = getJobQueueOptions(job);
    if (!options.notifyOnComplete && !options.addToWatchLaterOnComplete) return;

    const config = await ProfileService.readData(owner, 'config', {});
    const mediaTitle = libraryItem?.title || job.payload?.torrentName || 'Your queued title';
    const contentType = job.contentType === 'series' ? 'series' : 'movie';

    if (options.addToWatchLaterOnComplete && libraryItem?.id) {
        await ProfileService.addWatchLaterItem(owner, {
            id: libraryItem.id,
            title: libraryItem.title || mediaTitle,
            contentType,
            cover: libraryItem.cover || '',
            href: buildLibraryHref(libraryItem, contentType),
            imdbId: job.imdbId || libraryItem.imdbId || ''
        });
    }

    // Always publish a library notification for queue completion.
    await NotificationService.push(owner, {
        category: 'library',
        title: `${mediaTitle} added`,
        message: 'Ready to watch in your library.',
        href: buildLibraryHref(libraryItem || {}, contentType),
        payload: {
            jobId: job.id,
            imdbId: job.imdbId || libraryItem?.imdbId || '',
            contentType
        }
    });

    if (options.notifyOnComplete) {
        const targetEmail = String(config.email || owner || '').trim();
        if (targetEmail.includes('@')) {
            const appUrl = getPrimaryAppUrl();
            const displayName = config.displayName || config.name || config.username || owner;
            const destination = `${appUrl}${buildLibraryHref(libraryItem || {}, contentType)}`;

            await MailerService.sendTemplateEmail({
                toEmail: targetEmail,
                toName: displayName,
                subject: `${mediaTitle} is ready in AnySeries`,
                templateName: 'queue-complete-email.html',
                variables: {
                    title: 'Queue Item Completed',
                    preheader: `${mediaTitle} finished processing and is ready to watch.`,
                    username: displayName,
                    mediaTitle,
                    mediaType: contentType === 'series' ? 'TV series' : 'movie',
                    watchUrl: destination,
                    supportEmail: process.env.SUPPORT_EMAIL || 'josh@joshjames.site',
                    appUrl,
                    senderName: process.env.SENDER_NAME || 'AnySeries Admin'
                }
            });
        }
    }
}

async function persistPipelinePatchToDisk(job, patchData, nextStep, resolvedImdbId) {
    const targetFolderPath =
        patchData.folderPath ||
        patchData.cleanPath ||
        patchData.payload?.cleanPath ||
        job.payload?.cleanPath ||
        job.payload?.rawPath ||
        null;

    if (!targetFolderPath || !fs.existsSync(targetFolderPath)) {
        return null;
    }

    let stat;
    try {
        stat = fs.lstatSync(targetFolderPath);
    } catch (_err) {
        return null;
    }
    if (!stat.isDirectory()) return null;

    const folderBaseName = path.basename(targetFolderPath);
    const metadataPath = path.join(targetFolderPath, 'metadata.json');
    const existing = await MetadataRegistry.read(metadataPath, folderBaseName);

    const inferredYearMatch = folderBaseName.match(/\b(19|20)\d{2}\b/);
    const inferredYear = inferredYearMatch ? inferredYearMatch[0] : '';
    const inferredTitle = folderBaseName
        .replace(/\.(19|20)\d{2}\b/g, '')
        .replace(/[._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const merged = {
        ...existing,
        ...patchData,
        imdbId: resolvedImdbId || patchData.imdbId || existing.imdbId || null,
        contentType: patchData.contentType || existing.contentType || job.contentType || 'movie',
        title: patchData.title || existing.title || inferredTitle,
        year: patchData.year || existing.year || inferredYear,
        plot: patchData.plot || existing.plot || '',
        genre: patchData.genre || existing.genre || '',
        runtime: patchData.runtime || existing.runtime || 'N/A',
        rating: patchData.rating || existing.rating || 'N/A',
        pipelineState: patchData.pipelineState || {
            currentStep: nextStep,
            lastUpdated: new Date().toISOString(),
            error: null
        }
    };

    const queueContext = (job.payload && typeof job.payload.queueContext === 'object') ? job.payload.queueContext : {};
    const addedByUser = normalizeUserKey(queueContext.addedByUser || queueContext.userKey || queueContext.userId);
    const addedByGroup = userGroup(addedByUser);

    merged.libraryGroups = mergeLibraryGroups(
        mergeLibraryGroups(existing.libraryGroups || [], patchData.libraryGroups || [], { addGlobalIfMissing: true }),
        mergeLibraryGroups(queueContext.libraryGroups || [], addedByGroup ? [addedByGroup] : [], { addGlobalIfMissing: false }),
        { addGlobalIfMissing: true }
    );

    if (addedByUser) {
        merged.addedByUsers = Array.from(new Set([
            ...(Array.isArray(existing.addedByUsers) ? existing.addedByUsers : []),
            ...(Array.isArray(patchData.addedByUsers) ? patchData.addedByUsers : []),
            addedByUser
        ])).sort();
    } else if (Array.isArray(existing.addedByUsers) || Array.isArray(patchData.addedByUsers)) {
        merged.addedByUsers = Array.from(new Set([
            ...(Array.isArray(existing.addedByUsers) ? existing.addedByUsers : []),
            ...(Array.isArray(patchData.addedByUsers) ? patchData.addedByUsers : [])
        ])).sort();
    }

    if (!existing.addedAt && nextStep === 'COMPLETE') {
        merged.addedAt = new Date().toISOString();
    } else if (existing.addedAt) {
        merged.addedAt = existing.addedAt;
    }

    if (patchData.storage || existing.storage) {
        merged.storage = mergeStorage(existing.storage, patchData.storage || {});
    }

    if (Array.isArray(patchData.subtitles)) {
        merged.subtitles = patchData.subtitles;
    }

    if (patchData.subtitleSelection || existing.subtitleSelection) {
        merged.subtitleSelection = {
            ...(existing.subtitleSelection || {}),
            ...(patchData.subtitleSelection || {})
        };
    }

    if (Array.isArray(patchData.subtitleCatalog)) {
        merged.subtitleCatalog = patchData.subtitleCatalog;
    }

    // These keys are transport-level fields and should not be persisted in metadata manifests.
    delete merged.folderPath;
    delete merged.folderName;
    delete merged.cleanPath;
    delete merged.rawPath;
    delete merged.payload;

    await MetadataRegistry.writeAndCommit(metadataPath, folderBaseName, merged);
    return metadataPath;
}

async function removeCompletedTorrentFromClient(job) {
    const torrentHash = String(job.payload?.torrentHash || '').trim();
    if (!torrentHash) return false;

    const deleteParams = new URLSearchParams();
    deleteParams.append('hashes', torrentHash);
    deleteParams.append('deleteFiles', 'false');

    let primaryError = null;
    try {
        await axios.post(`${QBIT_URL}/api/v2/torrents/delete`, deleteParams.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 5000
        });
        logger.info(`🧹 [Queue] Removed completed torrent from qBittorrent (kept data): ${torrentHash.substring(0, 8)}`);
        return true;
    } catch (err) {
        primaryError = err;
    }

    try {
        const fallback = await TorrentService.deleteTorrentByHash(torrentHash, { deleteFiles: false });
        if (fallback?.success) {
            logger.info(`🧹 [Queue] Removed completed torrent via fallback API path (kept data): ${torrentHash.substring(0, 8)}`);
            return true;
        }
        const fallbackError = fallback?.error || 'Unknown fallback delete error';
        logger.warn(`⚠️ [Queue] Could not remove completed torrent ${torrentHash.substring(0, 8)}: ${(primaryError && primaryError.message) || 'primary delete failed'} | fallback=${fallbackError}`);
        return false;
    } catch (fallbackErr) {
        logger.warn(`⚠️ [Queue] Could not remove completed torrent ${torrentHash.substring(0, 8)}: ${(primaryError && primaryError.message) || 'primary delete failed'} | fallbackException=${fallbackErr.message}`);
        return false;
    }
}

async function retryCompletedTorrentCleanup() {
    const completedJobs = getAllJobs().filter((job) => {
        const status = String(job?.status || '').toUpperCase();
        const step = String(job?.currentStep || '').toUpperCase();
        return status === 'COMPLETE' || step === 'COMPLETE';
    });

    for (const job of completedJobs) {
        const cleaned = await removeCompletedTorrentFromClient(job);
        if (cleaned) {
            removeJob(job.id);
            logger.debug(`✅ [Queue] Completed cleanup retry succeeded for job ${job.id}; removing queue record.`);
        }
    }
}

function findPendingDownloadJob(torrent) {
    const allJobs = getAllJobs();
    const torrentHash = String(torrent.hash || '').toLowerCase();
    const torrentName = String(torrent.name || '').trim();

    return allJobs.find(job => {
        if (job.status !== 'WAITING_DOWNLOAD') return false;
        const jobHash = String(job.payload?.torrentHash || '').toLowerCase();
        const jobName = String(job.payload?.torrentName || '').trim();
        if (torrentHash && jobHash && torrentHash === jobHash) return true;
        return torrentName && jobName && torrentName === jobName;
    }) || null;
}

async function enqueueCompletedTorrent(torrent) {
    const tagStr = normalizeTags(torrent.tags);
    if (!tagStr.includes('movie-streamer') && !tagStr.includes('series-streamer')) return null;
    if (tagStr.includes('-processed')) return null;

    const recoveredMappings = await TorrentService.recoverMappingsFromTorrent(torrent);

    // Retrieve IMDB ID from TorrentService mapping
    const isSeries = tagStr.includes('series-streamer');
    let imdbId = normalizeImdbId(
        TorrentService.extractImdbIdFromTags(torrent.tags) || await TorrentService.getImdbIdByHash(torrent.hash)
    );
    if (!imdbId && isSeries) {
        imdbId = inferSeriesImdbIdFromTorrentName(torrent.name);
        if (imdbId) {
            await TorrentService.setImdbIdForHash(torrent.hash, imdbId);
            logger.info(`🧩 [Queue] Recovered missing IMDb from TV index for ${torrent.name}: ${imdbId}`);
        }
    }

    const addedByUser =
        recoveredMappings?.addedByUser ||
        TorrentService.extractAddedByUserFromTags(torrent.tags) ||
        await TorrentService.getAddedByUserByHash(torrent.hash) ||
        null;

    const rawPath = resolveTorrentDownloadPath(torrent);
    const resolvedFolderName = rawPath ? path.basename(rawPath) : (torrent.name || null);
    const torrentQueueContext = normalizeQueueContext(
        {
            ...(recoveredMappings?.queueContext || {}),
            addedByUser
        },
        resolvedFolderName || torrent.name,
        imdbId || null
    );

    const pendingJob = findPendingDownloadJob(torrent);
    if (pendingJob) {
        const resumed = updateJob(pendingJob, {
            status: 'QUEUED',
            imdbId: pendingJob.imdbId || imdbId || null,
            payload: {
                ...pendingJob.payload,
                torrentHash: torrent.hash || pendingJob.payload?.torrentHash || null,
                torrentName: torrent.name || pendingJob.payload?.torrentName || pendingJob.id,
                rawPath: rawPath || pendingJob.payload?.rawPath || null,
                cleanPath: null,
                videoFile: null,
                queueContext: normalizeQueueContext(
                    {
                        ...(recoveredMappings?.queueContext || {}),
                        ...(pendingJob.payload?.queueContext || {}),
                        addedByUser: pendingJob.payload?.queueContext?.addedByUser || addedByUser || null
                    },
                    torrent.name || pendingJob.payload?.torrentName,
                    pendingJob.imdbId || imdbId || null
                )
            },
            error: null
        });
        logger.info(`🔁 [Queue] Resumed placeholder job ${resumed.id} for completed torrent ${torrent.name}`);
        return resumed;
    }

    const existingJob = getAllJobs().find(job => {
        const jobHash = String(job.payload?.torrentHash || '').toLowerCase();
        const jobName = String(job.payload?.torrentName || '').trim();
        const torrentHash = String(torrent.hash || '').toLowerCase();
        const torrentName = String(torrent.name || '').trim();
        return (torrentHash && jobHash && torrentHash === jobHash) || (torrentName && jobName && torrentName === jobName);
    });

    if (existingJob && ['QUEUED', 'PROCESSING', 'WAITING_DOWNLOAD'].includes(existingJob.status)) {
        logger.info(`↩️ [Queue] Reusing existing job ${existingJob.id} for completed torrent ${torrent.name}`);
        return updateJob(existingJob, {
            status: 'QUEUED',
            payload: {
                ...existingJob.payload,
                torrentHash: torrent.hash || existingJob.payload?.torrentHash || null,
                torrentName: torrent.name || existingJob.payload?.torrentName || existingJob.id,
                rawPath: rawPath || existingJob.payload?.rawPath || null,
                queueContext: normalizeQueueContext(
                    {
                        ...(recoveredMappings?.queueContext || {}),
                        ...(existingJob.payload?.queueContext || {}),
                        addedByUser: existingJob.payload?.queueContext?.addedByUser || addedByUser || null
                    },
                    torrent.name || existingJob.payload?.torrentName,
                    existingJob.imdbId || imdbId || null
                )
            },
            error: null
        });
    }

    const job = createJob({
        status: 'QUEUED',
        currentStep: 'INGEST',
        imdbId: imdbId || null,
        contentType: inferContentType(tagStr),
        payload: {
            torrentHash: torrent.hash || null,
            torrentName: torrent.name,
            rawPath: rawPath,
            cleanPath: null,
            videoFile: null,
            queueContext: torrentQueueContext
        }
    });

    logger.info(`💾 [Queue] Enqueued job ${job.id} for torrent ${torrent.name} (IMDB: ${imdbId || 'unknown'})`);
    return job;
}

function hasAvailableSeasonEpisode(manifest, season, episode) {
    const seasonKey = String(season || '').trim();
    const episodeNum = Number(episode);
    if (!seasonKey || !Number.isFinite(episodeNum) || episodeNum <= 0) return false;

    const seasonEntry = manifest?.seasons?.[seasonKey];
    const episodes = Array.isArray(seasonEntry?.episodes) ? seasonEntry.episodes : [];
    return episodes.some((ep) => {
        const epNum = Number(ep?.episodeNumber);
        return Number.isFinite(epNum) && epNum === episodeNum && (Boolean(ep?.available) || Boolean(String(ep?.localRelativePath || '').trim()));
    });
}

function hasCompleteSeason(manifest, season) {
    const seasonKey = String(season || '').trim();
    if (!seasonKey) return false;

    const seasonEntry = manifest?.seasons?.[seasonKey];
    const episodes = Array.isArray(seasonEntry?.episodes) ? seasonEntry.episodes : [];
    if (!episodes.length) return false;

    return episodes.every((ep) => Boolean(ep?.available) || Boolean(String(ep?.localRelativePath || '').trim()));
}

async function promoteWaitingJobFromFilesystem(job) {
    if (!job || String(job.status || '').toUpperCase() !== 'WAITING_DOWNLOAD') return null;
    if ((job.contentType || '') !== 'series') return null;

    const imdbId = normalizeImdbId(job.imdbId || job.payload?.imdbId || job.payload?.queueContext?.imdbId);
    if (!imdbId) return null;

    const season = normalizePositiveInt(job.payload?.queueContext?.season);
    const episode = normalizePositiveInt(job.payload?.queueContext?.episode);
    if (!season) return null;

    const resolved = SeriesFolderResolver.findSeriesFolderByImdbId(imdbId);
    if (!resolved?.folderPath || !fs.existsSync(resolved.folderPath)) return null;

    let manifest = null;
    try {
        manifest = rebuildSeriesManifest(resolved.folderPath, {
            showFolderName: resolved.folderName,
            write: false
        });
    } catch (_err) {
        return null;
    }

    const sourceType = String(job.payload?.queueContext?.sourceType || '').toLowerCase();
    const promoted = sourceType === 'pack'
        ? hasCompleteSeason(manifest, season)
        : hasAvailableSeasonEpisode(manifest, season, episode);

    if (!promoted) return null;

    const cleanPath = path.join(resolved.folderPath, `Season.${String(season).padStart(2, '0')}`);
    const nextPayload = {
        ...job.payload,
        rawPath: job.payload?.rawPath || cleanPath,
        cleanPath: job.payload?.cleanPath || cleanPath,
        queueContext: {
            ...(job.payload?.queueContext || {}),
            targetShowFolder: job.payload?.queueContext?.targetShowFolder || resolved.folderName
        }
    };

    const promotedJob = updateJob(job, {
        status: 'QUEUED',
        currentStep: 'INGEST',
        payload: nextPayload,
        error: null
    });

    logger.info(`🧭 [Queue] Promoted waiting series job ${job.id} from filesystem manifest: ${resolved.folderName} S${String(season).padStart(2, '0')}${episode ? `E${String(episode).padStart(2, '0')}` : ''}`);
    return promotedJob;
}

async function processSeriesSearchJob(job) {
    const intent = (job?.payload && typeof job.payload.searchIntent === 'object') ? job.payload.searchIntent : {};
    logger.info(`🔎 [Queue][SEARCH] Job ${job?.id || 'unknown'} intent | title="${intent.title || 'n/a'}" imdb=${intent.imdbId || 'n/a'} season=${intent.season || '-'} episode=${intent.episode || '-'} sourceType=${intent.sourceType || 'episode'}`);
    const searchOutcome = await SeriesAcquisitionService.resolveAutoSeriesAcquisition(intent);

    if (!searchOutcome?.success || !searchOutcome.magnetUrl) {
        logger.warn(`❌ [Queue][SEARCH] Job ${job?.id || 'unknown'} failed | query="${searchOutcome?.query || 'n/a'}" error="${searchOutcome?.error || 'No confident search result found for automatic queueing.'}"`);
        return updateJob(job, {
            status: 'FAILED',
            currentStep: 'FAILED',
            error: searchOutcome?.error || 'No confident search result found for automatic queueing.',
            history: [...(job.history || []), { step: job.currentStep, timestamp: new Date().toISOString() }]
        });
    }

    const effectiveImdbId = normalizeImdbId(intent.imdbId || job.imdbId || null);
    const queueContext = {
        ...(job.payload?.queueContext || {}),
        imdbId: effectiveImdbId || job.payload?.queueContext?.imdbId || null,
        season: Number.isFinite(parseInt(intent.season, 10)) ? parseInt(intent.season, 10) : job.payload?.queueContext?.season || null,
        episode: Number.isFinite(parseInt(intent.episode, 10)) ? parseInt(intent.episode, 10) : job.payload?.queueContext?.episode || null,
        sourceType: String(intent.sourceType || job.payload?.queueContext?.sourceType || 'episode').toLowerCase() === 'pack' ? 'pack' : 'episode',
        addedByUser: intent.addedByUser || job.payload?.queueContext?.addedByUser || null
    };

    await TorrentService.addMagnet(searchOutcome.magnetUrl, 'series-streamer', effectiveImdbId, {
        addedByUser: queueContext.addedByUser || null,
        queueContext
    });

    const { torrentName, infoHash } = extractMagnetRuntimeInfo(searchOutcome.magnetUrl);
    logger.info(`✅ [Queue][SEARCH] Job ${job?.id || 'unknown'} selected | query="${searchOutcome.query || 'n/a'}" title="${searchOutcome?.selected?.title || torrentName || 'n/a'}" source=${searchOutcome.source || 'search'} hash=${infoHash || 'n/a'}`);
    return updateJob(job, {
        status: 'WAITING_DOWNLOAD',
        currentStep: 'INGEST',
        imdbId: effectiveImdbId || job.imdbId || null,
        payload: {
            ...job.payload,
            torrentHash: infoHash,
            torrentName,
            rawPath: null,
            cleanPath: null,
            videoFile: null,
            magnetUrl: searchOutcome.magnetUrl,
            imdbId: effectiveImdbId || null,
            mediaTitle: buildQueueMediaTitle({
                title: torrentName,
                imdbId: effectiveImdbId,
                contentType: 'series',
                payload: {
                    torrentName,
                    queueContext
                }
            }),
            queueContext,
            searchStats: searchOutcome.searchStats || null,
            searchSelection: searchOutcome.selected || null
        },
        history: [...(job.history || []), { step: job.currentStep, timestamp: new Date().toISOString() }],
        error: null
    });
}

async function processNextJob(job) {
    if (!job) return null;

    logger.debug(
        `🧭 [Queue] Processing job ${job.id} | status=${job.status} | step=${job.currentStep} | imdbId=${job.imdbId || 'unknown'} | hasRawPath=${Boolean(job.payload?.rawPath)} | hasCleanPath=${Boolean(job.payload?.cleanPath)}`
    );

    // Prevent accidental global ingest sweep when a pre-download placeholder job leaks into runnable state.
    if (job.currentStep === 'INGEST' && !(job.payload?.rawPath || job.payload?.cleanPath)) {
        logger.warn(`⏭️ [Queue] Deferring job ${job.id}: missing folder path for INGEST.`);
        return updateJob(job, {
            status: 'WAITING_DOWNLOAD',
            error: 'Waiting for completed download path before INGEST dispatch.'
        });
    }

    const resolvedJobImdbId = normalizeImdbId(
        job.imdbId ||
        job.payload?.imdbId ||
        job.payload?.queueContext?.imdbId
    ) || null;

    const resolvedSeriesFolder = (() => {
        if ((job.contentType || '') !== 'series' || !resolvedJobImdbId) return null;
        const found = SeriesFolderResolver.findSeriesFolderByImdbId(resolvedJobImdbId);
        return found?.folderName || null;
    })();

    const resolvedQueueContext = {
        ...(job.payload?.queueContext || {}),
        imdbId: resolvedJobImdbId || job.payload?.queueContext?.imdbId || null,
        targetShowFolder: resolvedSeriesFolder || job.payload?.queueContext?.targetShowFolder || null
    };

    if (job.currentStep === 'SEARCH') {
        try {
            const updatedSearchJob = await processSeriesSearchJob(job);
            logger.debug(`🔎 [Queue] Search job ${job.id} resolved to ${updatedSearchJob.status}/${updatedSearchJob.currentStep}`);
            return updatedSearchJob;
        } catch (err) {
            logger.error(`❌ [Queue] Search job ${job.id} failed: ${err.message}`);
            return updateJob(job, {
                status: 'FAILED',
                currentStep: 'FAILED',
                error: err.message,
                history: [...(job.history || []), { step: job.currentStep, timestamp: new Date().toISOString() }]
            });
        }
    }

    const stepMap = {
        INGEST: {
            workerUrl: WORKER_ENDPOINTS.INGEST,
            payload: {
                folderPath: job.payload?.rawPath || job.payload?.cleanPath || null,
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (path.basename(job.payload?.rawPath || '') || job.payload?.torrentName || job.id),
                contentType: job.contentType || 'movie',
                imdbId: resolvedJobImdbId,
                queueContext: resolvedQueueContext
            }
        },
        METADATA: {
            workerUrl: WORKER_ENDPOINTS.METADATA,
            payload: {
                folderPath: job.payload?.cleanPath || job.payload?.rawPath || null,
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (job.payload?.torrentName || job.id),
                contentType: job.contentType || 'movie',
                manualImdbId: resolvedJobImdbId
            }
        },
        SUBTITLES: {
            workerUrl: WORKER_ENDPOINTS.SUBTITLES,
            payload: {
                folderPath: job.payload?.cleanPath || job.payload?.rawPath || null,
                imdbId: resolvedJobImdbId,
                contentType: job.contentType || 'movie',
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (job.payload?.torrentName || job.id)
            }
        },
        TRANSCODE: {
            workerUrl: WORKER_ENDPOINTS.TRANSCODE,
            payload: {
                folderPath: job.payload?.cleanPath || job.payload?.rawPath || null,
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (job.payload?.torrentName || job.id)
            }
        },
        CLOUDSYNC: {
            workerUrl: WORKER_ENDPOINTS.CLOUDSYNC,
            payload: {
                folderPath: job.payload?.cleanPath || job.payload?.rawPath || null,
                folderName: job.payload?.cleanPath ? job.payload.cleanPath.split('/').pop() : (job.payload?.torrentName || job.id),
                imdbId: resolvedJobImdbId,
                contentType: job.contentType || 'movie'
            }
        }
    };

    const stepConfig = stepMap[job.currentStep];
    if (!stepConfig) {
        return updateJob(job, {
            status: 'COMPLETE',
            currentStep: 'COMPLETE',
            history: [...(job.history || []), { step: job.currentStep, timestamp: new Date().toISOString() }]
        });
    }

    try {
        logger.debug(`🧠 [Queue] Dispatching job ${job.id} to ${job.currentStep} -> ${stepConfig.workerUrl}`);
        const response = await axios.post(stepConfig.workerUrl, stepConfig.payload, { timeout: 1800000 });
        const patchData = response.data?.patchData || {};
        const nextStep = patchData.pipelineState?.currentStep || {
            INGEST: 'METADATA',
            METADATA: 'SUBTITLES',
            SUBTITLES: 'TRANSCODE',
            TRANSCODE: CLOUDSYNC_REQUIRED_FOR_COMPLETE ? 'CLOUDSYNC' : 'COMPLETE',
            CLOUDSYNC: 'COMPLETE'
        }[job.currentStep] || 'COMPLETE';

        const resolvedImdbId = normalizeImdbId(
            patchData.imdbId ||
            resolvedJobImdbId ||
            job.payload?.imdbId ||
            job.payload?.queueContext?.imdbId
        ) || null;

        const mergedPayload = {
            ...job.payload,
            ...(patchData.payload || {}),
            cleanPath:
                patchData.cleanPath ||
                patchData.folderPath ||
                patchData.payload?.cleanPath ||
                patchData.payload?.folderPath ||
                job.payload?.cleanPath ||
                job.payload?.rawPath ||
                null,
            rawPath: patchData.rawPath || job.payload?.rawPath || null,
            imdbId: resolvedImdbId
        };

        const metadataPath = await persistPipelinePatchToDisk(job, patchData, nextStep, resolvedImdbId);
        if (metadataPath) {
            logger.debug(`📝 [Queue] Persisted metadata snapshot for job ${job.id} at ${metadataPath}`);
        }

        logger.debug(
            `📦 [Queue] ${job.id} ${job.currentStep} response: success=${response.data?.success !== false} | nextStep=${nextStep} | patchKeys=${Object.keys(patchData).join(',') || 'none'} | resolvedImdbId=${resolvedImdbId || 'unknown'}`
        );

        const updated = updateJob(job, {
            status: response.data?.success === false ? 'FAILED' : (nextStep === 'COMPLETE' ? 'COMPLETE' : 'QUEUED'),
            currentStep: response.data?.success === false ? 'FAILED' : nextStep,
            imdbId: resolvedImdbId,
            payload: mergedPayload,
            history: [
                ...(job.history || []),
                { step: job.currentStep, timestamp: new Date().toISOString() }
            ],
            error: response.data?.success === false ? response.data?.error || 'worker failed' : null
        });

        logger.debug(`🧠 [Queue] Job ${updated.id} moved to ${updated.currentStep}`);

        if (['INGEST', 'METADATA', 'CLOUDSYNC'].includes(job.currentStep) || updated.currentStep === 'COMPLETE') {
            try {
                await LibraryScanner.runLibraryScanSweep();
                logger.debug(`♻️ [Queue] Library snapshot refreshed after ${job.currentStep} for job ${updated.id}`);

                if (updated.currentStep === 'COMPLETE' || updated.status === 'COMPLETE') {
                    const library = await getLibrary();
                    const folderName = path.basename(updated.payload?.cleanPath || updated.payload?.rawPath || updated.payload?.torrentName || '');
                    const itemId = updated.contentType === 'series' ? `series/${encodeURIComponent(folderName)}` : encodeURIComponent(folderName);
                    const libraryItem = updated.contentType === 'series'
                        ? (library.shows || []).find(item => item.id === itemId)
                        : (library.movies || []).find(item => item.id === itemId);

                    if (libraryItem) {
                        upsertRecentCard(normalizeCard({
                            ...libraryItem,
                            addedAt: libraryItem.addedAt || new Date().toISOString()
                        }));
                        logger.debug(`🆕 [Queue] Recent feed updated for ${folderName}`);
                    }

                    try {
                        await runQueueCompletionHooks(updated, libraryItem || null);
                    } catch (completionErr) {
                        logger.warn(`⚠️ [Queue] Completion hooks failed for ${updated.id}: ${completionErr.message}`);
                    }
                }
            } catch (scanErr) {
                logger.warn(`⚠️ [Queue] Library refresh failed after ${job.currentStep}: ${scanErr.message}`);
            }
        }

        if (updated.status === 'COMPLETE' || updated.currentStep === 'COMPLETE') {
            const removedFromClient = await removeCompletedTorrentFromClient(updated);
            if (!removedFromClient) {
                logger.warn(`⚠️ [Queue] Job ${updated.id} completed but torrent delete failed; retaining COMPLETE job for cleanup retry.`);
                return updateJob(updated, {
                    status: 'COMPLETE',
                    currentStep: 'COMPLETE',
                    error: 'Completed pipeline, pending qBittorrent cleanup retry.'
                });
            }

            removeJob(updated.id);
            logger.debug(`✅ [Queue] Job ${updated.id} finalized and removed from active queue map.`);
            return updated;
        }

        if (updated.status === 'QUEUED' && updated.currentStep !== 'COMPLETE' && updated.currentStep !== 'FAILED') {
            logger.debug(`🔁 [Queue] Continuing job ${updated.id} to ${updated.currentStep}`);
            return processNextJob(updated);
        }

        return updated;
    } catch (err) {
        const responseError = err.response?.data?.error || err.response?.data?.message || null;
        logger.error(`❌ [Queue] Job ${job.id} failed during ${job.currentStep}: ${err.message}${responseError ? ` | workerError=${responseError}` : ''}`);
        return updateJob(job, {
            status: 'FAILED',
            currentStep: 'FAILED',
            error: responseError || err.message,
            history: [...(job.history || []), { step: job.currentStep, timestamp: new Date().toISOString() }]
        });
    }
}

async function checkPipelineCompletions() {
    if (isProcessingPipeline) return;

    try {
        await retryCompletedTorrentCleanup();

        const queuedJob = getNextRunnableJob();
        if (queuedJob) {
            isProcessingPipeline = true;
            await withDistributedLock(`pipeline:job:${queuedJob.id}`, async () => {
                const freshQueuedJob = getJob(queuedJob.id);
                if (!freshQueuedJob || freshQueuedJob.status !== 'QUEUED') return;
                logger.debug(`🚦 [Queue] Processing queued job ${freshQueuedJob.id} from scheduler tick.`);
                await processNextJob(freshQueuedJob);
            }, { ttlMs: 15000, waitMs: 2000 });
            isProcessingPipeline = false;
            return;
        }

        // Fetch current active torrent tracking pools from qBittorrent
        const qbitRes = await axios.get(`${QBIT_URL}/api/v2/torrents/info`, { timeout: 4000 });
        const torrents = qbitRes.data || [];
        
        if (!torrents.length) return;

        // Isolate complete items belonging specifically to our pipeline types safely
        const completedTorrent = torrents.find(t => {
            if (t.progress !== 1 || !t.tags) return false;
            
            const tagStr = normalizeTags(t.tags);
            if (tagStr.includes('-processed')) return false;
            return tagStr.includes('movie-streamer') || tagStr.includes('series-streamer');
        });

        if (!completedTorrent) {
            const waitingJobs = getAllJobs().filter((job) => String(job?.status || '').toUpperCase() === 'WAITING_DOWNLOAD');
            for (const waitingJob of waitingJobs) {
                const promotedJob = await promoteWaitingJobFromFilesystem(waitingJob);
                if (promotedJob) {
                    isProcessingPipeline = true;
                    await withDistributedLock(`pipeline:job:${promotedJob.id}`, async () => {
                        const freshJob = getJob(promotedJob.id);
                        if (!freshJob || freshJob.status !== 'QUEUED') return;
                        await processNextJob(freshJob);
                    }, { ttlMs: 15000, waitMs: 2000 });
                    isProcessingPipeline = false;
                    return;
                }
            }
            return;
        }

        isProcessingPipeline = true;
        const torrentHash = completedTorrent.hash;

        await withDistributedLock(`pipeline:torrent:${torrentHash}`, async () => {
            const tagStr = normalizeTags(completedTorrent.tags);
            const isSeries = tagStr.includes('series-streamer');

            const activeTag = isSeries ? 'series-streamer' : 'movie-streamer';
            const processedTag = isSeries ? 'series-streamer-processed' : 'movie-streamer-processed';

            logger.debug(`🎉 [Pipeline Agent] Download completion caught: [${completedTorrent.name}] (${isSeries ? 'TV Show' : 'Movie'})`);

            try {
                logger.debug(`⚙️  Rotating workflow tags [${activeTag} -> ${processedTag}] for hash: ${torrentHash}`);

                const removeParams = new URLSearchParams();
                removeParams.append('hashes', torrentHash);
                removeParams.append('tags', activeTag);

                const addParams = new URLSearchParams();
                addParams.append('hashes', torrentHash);
                addParams.append('tags', processedTag);

                await axios.post(`${QBIT_URL}/api/v2/torrents/removeTags`, removeParams.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                await axios.post(`${QBIT_URL}/api/v2/torrents/addTags`, addParams.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                logger.debug(`✅ Tag rotation complete for hash ${torrentHash.substring(0,8)}. Triggering down-pipe automation.`);
            } catch (tagErr) {
                logger.error(`⚠️ Failed updating qBittorrent status tags: ${tagErr.message}`);
                return;
            }

            try {
                const job = await enqueueCompletedTorrent(completedTorrent);
                if (job) {
                    logger.debug(`🚦 [Queue] Starting pipeline chain for job ${job.id}`);
                    await processNextJob(job);
                }
            } catch (queueErr) {
                logger.error(`❌ Queue processing failed: ${queueErr.message}`);
            }
        }, { ttlMs: 15000, waitMs: 2000 });

        isProcessingPipeline = false;

    } catch (err) {
        isProcessingPipeline = false; 
    }
}

function hasUsableJobPath(job) {
    const candidatePaths = [job?.payload?.cleanPath, job?.payload?.rawPath]
        .map((value) => String(value || '').trim())
        .filter(Boolean);

    return candidatePaths.some((candidatePath) => {
        try {
            return fs.existsSync(candidatePath);
        } catch (_err) {
            return false;
        }
    });
}

async function reconcileQueueStartupState() {
    logger.info('🧰 [Queue] Running startup reconciliation for torrent ownership and queue alignment...');

    try {
        const qbitRes = await axios.get(`${QBIT_URL}/api/v2/torrents/info`, { timeout: 8000 });
        const allTorrents = Array.isArray(qbitRes.data) ? qbitRes.data : [];
        const pipelineTorrents = allTorrents.filter((torrent) => isPipelineTorrentTagString(normalizeTags(torrent.tags)));

        let recoveredMappings = 0;
        for (const torrent of pipelineTorrents) {
            const recovered = await TorrentService.recoverMappingsFromTorrent(torrent);
            if (recovered.addedByUser || recovered.imdbId) {
                recoveredMappings += 1;
            }
        }

        const liveHashes = new Set(
            pipelineTorrents
                .map((torrent) => String(torrent.hash || '').trim().toLowerCase())
                .filter(Boolean)
        );
        const liveNames = new Set(
            pipelineTorrents
                .map((torrent) => String(torrent.name || '').trim())
                .filter(Boolean)
        );

        let removedStaleJobs = 0;
        const jobs = getAllJobs();
        for (const job of jobs) {
            const jobHash = String(job?.payload?.torrentHash || '').trim().toLowerCase();
            const jobName = String(job?.payload?.torrentName || '').trim();
            const linkedToLiveTorrent = Boolean(
                (jobHash && liveHashes.has(jobHash)) ||
                (jobName && liveNames.has(jobName))
            );

            const waitingLike = ['WAITING_DOWNLOAD', 'PAUSED_DOWNLOAD'].includes(String(job?.status || '').toUpperCase());
            const failedWithoutPath = String(job?.status || '').toUpperCase() === 'FAILED' && !hasUsableJobPath(job);
            const queuedWithoutPath = String(job?.status || '').toUpperCase() === 'QUEUED' && !hasUsableJobPath(job);

            if (linkedToLiveTorrent) continue;

            if (waitingLike || failedWithoutPath || queuedWithoutPath) {
                logger.warn(`🧹 [Queue] Removing stale startup job ${job.id} | status=${job.status} | name=${jobName || 'unknown'} | hash=${jobHash || 'none'}`);
                removeJob(job.id);
                removedStaleJobs += 1;
            }
        }

        logger.info(`🧰 [Queue] Startup reconciliation complete. pipelineTorrents=${pipelineTorrents.length} recoveredMappings=${recoveredMappings} removedStaleJobs=${removedStaleJobs}`);
        return {
            success: true,
            pipelineTorrents: pipelineTorrents.length,
            recoveredMappings,
            removedStaleJobs
        };
    } catch (err) {
        logger.warn(`⚠️ [Queue] Startup reconciliation skipped: ${err.message}`);
        return {
            success: false,
            error: err.message,
            pipelineTorrents: 0,
            recoveredMappings: 0,
            removedStaleJobs: 0
        };
    }
}

module.exports = {
    startPipelineWorker(intervalMs = 10000) {
        logger.debug(`⚙️  Autonomous pipeline queue manager active. Monitoring completions every ${intervalMs}ms...`);
        setInterval(checkPipelineCompletions, intervalMs);
    },
    reconcileQueueStartupState,
    createJob,
    getJob,
    getAllJobs,
    getJobSnapshot,
    updateJob
};