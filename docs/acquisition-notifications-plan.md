# Acquisition UX & Notifications — Plan

## Why this doc

Discussed 2026-09-22. Right now, adding something that isn't already in the
library (via a catalog card, a public row, or a search result) is a bit of a
black box: you click "Find & Queue," get a toast, and then have no real
visibility into what's happening until you happen to notice a play button
show up. The queue itself lives at the bottom of the home page where it's
easy to miss, so between "I clicked add" and "it's ready" the user is mostly
in the dark - worse on mobile, where there's no persistent queue view at all.

This doc captures what we want to change, as a plan to implement later - not
implemented yet, and not fully designed at the code level. The underlying
acquisition-service behavior (matching/tiers/what triggers a search) is
intentionally out of scope here; the user wants to think about that
separately, especially given the longer-term goal of getting ~99% of content
to instant-play (making a lot of this less urgent, but not zero - there will
always be a tail of on-demand acquisitions).

## Part 1 — Confirm-before-queue popup

Today, clicking "Find & Queue" (or "Add to Library") on a catalog/search
result queues it immediately with no confirmation. Add a lightweight modal
first: explain in plain terms that this will search for the title and add it
to the library, and that progress can be tracked from the home page/
notifications. User clicks OK to actually queue it.

- Scope: anywhere `queueCatalogItem`/`addMediaAsset`-style flows exist
  (`public/browse.html` today; check `public/gridview.html`,
  `public/series.html` for equivalents before implementing).
- Should be skippable/rememberable (e.g. "don't ask me again" persisted to
  the user's profile config) so it doesn't become an annoyance for a power
  user who already knows the flow - open question for implementation, not
  decided yet.

## Part 2 — Expand NotificationService with real staged updates

**Current state (confirmed by reading the code, not assumed):**
`NotificationService.js` itself already supports everything needed
(categories, TTL, push/list/prune) and there's already a consuming UI - an
avatar-menu notification dropdown and `/notifications.html` on
`public/index.html`, plus an unread-bell indicator (`#avatar-bell`,
`data-has-unread`). The gap is entirely on the *producing* side: across the
whole codebase, `NotificationService.push()` is only called in three places,
and only ever **once, at the very end**:

- `PipelineWorker.js` `runQueueCompletionHooks()` - fires a single "added,
  ready to watch" notification when a job completes. Nothing fires when the
  job is created, starts acquiring, or is partway through a stage.
- `PipelineWorker.js` `runSeriesSubscriberNotifications()` - same, only on
  completion, for show subscribers.
- `SeriesAutoGetService.js` - same pattern, only on completion.

So "the notification service hasn't been updating like it used to" is
accurate: there was never per-stage push, and everything since has only
added more completion-only notifications, not intermediate ones.

**What to add** - a notification (and matching toast) at each of these
transitions, per job:

1. **Queued** - "`<title>` queued - looking for a source now." Fired at the
   moment a job is created (torrent.routes.js's add endpoints, or wherever
   the pipeline job actually gets created), not after the fact.
2. **Found / acquiring** - "Found `<title>`, downloading now." Fired when a
   torrent/source is actually selected and download begins (ingest stage
   start) - this is the first point real progress exists.
3. **Progress + ETA** - periodic update (e.g. every 25%, or every N minutes,
   TBD) during the download/transcode stages: "`<title>` 50% - about 5
   minutes remaining." ETA computed from elapsed time since the stage
   started vs. percent complete so far (`elapsed / percentDone *
   (100 - percentDone)`), not a fixed guess - needs a real start timestamp
   recorded per job/stage to compute against. Needs a design decision on
   which stages have real, meaningful progress percentages today (download
   likely does via qBittorrent's own progress field; metadata/subtitles/
   transcode may not - check `PipelineWorker.js` per stage before assuming).
4. **Post-processing** - "`<title>` acquired - finishing up, hang tight."
   Covers metadata/subtitle/transcode/cloudsync stages once the raw
   download itself is done, so the user isn't left thinking it's finished
   the moment the download bar hits 100%.
5. **Ready** - existing completion notification, unchanged.

Each of these should also drive a **toast** (not just the silent
notification-stream entry) so it's visible in the moment, not just on the
next visit to the bell dropdown.

**Where this plugs into the pipeline**: `PipelineWorker.js` already knows
the job and its owner (`getJobOwner`) at every stage transition - the stage
transition points already exist in that file, they just don't currently
call `NotificationService.push`. This is additive, not a rework of pipeline
state itself.

## Part 3 — Persistent in-progress indicator near the avatar

`public/index.html` already has `.avatar-bell` (`#avatar-bell`,
`data-has-unread`) for "you have unread notifications." Add a second, visually
distinct state - a small spinner/ring around or beside the avatar - that
shows whenever the user has at least one job actively in progress (queued
through post-processing, not yet ready). This is the answer to "you're stuck
looking at the bottom of the home page to know anything's happening" -
something persistent and visible from any page, not just the home feed.

- Likely driven by the same notification-list fetch already polled for the
  bell (`/api/profile/notifications`), or a small dedicated
  "active-jobs-count" endpoint - open question, decide when implementing.
- Explicitly called out as important on mobile, where there's no
  persistent queue-manager view in the nav at all today.

## Part 4 — Done already (2026-09-22, same conversation): row-freshness fix

Separately from the above (and already implemented, not part of this plan
going forward): public rows are static JSON rebuilt once a day by the
`public-rows-refresh` BullMQ job, so a title added between rebuilds still
shows as "not in library" in row data and sends you to `/browse.html`
instead of straight to playback, even once it's actually ready. Rather than
patching the rows themselves (rejected - see reasoning below), added a cheap
live check: row cards now pass `imdbId` through to `/browse.html`, which
calls a new `GET /api/library-status/:imdbId` on load and redirects straight
to the player/series page if the title is actually in the library by then.

Rejected alternatives and why:
- **Full rebuild-all on every library add** - correctly called out as
  overkill; re-querying TMDb across all 13 rows (with per-item external-id
  resolution) on every single add is real load for a symptom that isn't
  about row *content* being wrong.
- **Differential/incremental patch into rows** - what belongs in e.g.
  "Popular Streaming Movies" is a property of TMDb's own popularity ranking,
  not of what was just locally acquired; splicing a fresh local add into a
  ranked row would mean guessing it belongs there rather than confirming it
  via TMDb data, which runs against the "don't guess, only reflect confirmed
  data" rule this project already follows. The row's `inLibrary` flag being
  briefly stale is an acceptable, expected side effect of rows being a daily
  snapshot - not a bug in itself.

## Suggested order

Part 4 is done. Of the rest, Part 2 (notification staging) is the one with
the most user-visible impact and the most groundwork already in place
(`NotificationService.js` needs no changes, just more call sites) - probably
the next one to pick up. Part 1 (confirm popup) and Part 3 (avatar spinner)
are both small, independent, UI-only changes that can happen whenever.
