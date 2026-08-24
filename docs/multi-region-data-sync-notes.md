# Multi-Region Data Sync — Current State & Considerations

## Why this doc

Written from a live discussion about keeping LA (primary) and Sydney (and
future downstream servers) in sync, after repeatedly hitting stale-data
symptoms this session (Sydney serving broken covers for titles that had been
renamed/re-tagged/re-keyed on LA, with no automatic propagation at all).

This is notes, not a decided plan. It records the data classification we
landed on, exactly what is and isn't replicating today (verified against the
actual code, not assumed), the options on the table, and open questions -
so the next real design pass starts from ground truth instead of guesswork.

## Data classification (as discussed)

1. **Metadata changes** — media info, subtitle add/change, cover, transcode
   status, cloud-sync status. Lives in `metadata.json`/`series.json` per
   title, on disk.
2. **Media file changes** — new show/season/episode/movie, a new transcoded
   profile, filename change, folder/path change. The actual video bytes;
   once cloud-synced these live in Backblaze B2 and are referenced by
   `remoteKey` — **already effectively solved**, since any region can
   generate a signed URL against the same bucket without needing the file
   locally. The local file + its folder/name is what's in flux.
3. **User data** — profile, watch history, playback position/progress,
   login history, and (new, from the sidebar work) custom rows/config.
4. **Application/API data** — app-level config, feature flags, etc.
   (not deeply investigated yet — flagged for a later pass).

This doc focuses on (1) metadata and (3) user data, since (2)'s actual bytes
are already handled by object storage and (4) hasn't caused a problem yet.

## What's actually replicating today (verified against the code)

### Redis: a genuine live replica, not "just a cache"

Sydney's `redis-hub` is a real native Redis replica of LA's
(`--replicaof 10.100.0.1 6379`) — confirmed live: `master_link_status:up`,
matching `dbsize`, ~1s replication lag when originally set up. The **entire**
Redis keyspace continuously mirrors from LA to Sydney via Redis's own
replication protocol, all the time, not on-demand.

"Read replica" describes **write permission** (a Redis replica rejects
direct writes by design — that's the mechanism that surprised Josh when LA
went down: Sydney's app had to be pointed at `REDIS_WRITE_URL` = LA instead,
because Sydney's local Redis literally cannot accept writes, replica or not).
It does not mean replication isn't happening — replication is happening
continuously and was working correctly the whole time.

### What's actually stored in Redis (and therefore mirrored)

- **User `config.json` + `history.json`** — `ProfileService.readData`/
  `writeData` are cache-first: read checks Redis before disk, write hits
  both together under a lock. Always mirrored.
- **Playback/watch position** — its own Redis hash keyspace
  (`playback:<user>`), unconditionally mirrored (not gated behind the
  config/history check).
- **Pipeline job queue state** (`joshflix:queue:job:` prefix, DB 4).
- **Quota tracking** (`AcquisitionQuotaService`).
- **Distributed locks** — transient by nature; not meaningful to "sync" in
  the same sense, they're point-in-time coordination, not durable state.
- **Movie/series `metadata.json` content** — but **only** for code paths
  that go through `MetadataRegistry.read`/`writeAndCommit`/`mergeAndCommit`,
  which is also cache-first (memory → Redis → disk, writes hit Redis + disk
  together).

### The real gap: several write paths bypass MetadataRegistry entirely

Verified this session, not assumed:

- **`CloudSyncWorker.js`'s movie path** (not the series path, which does use
  `MetadataRegistry.mergeAndCommit`) reads/writes `metadata.json` via raw
  `fs.readFileSync`/`fs.writeFileSync`. This is the exact code path behind
  almost everything we did this session — transcode status, cloud-sync
  status, remoteKey — and it **never touches Redis at all**.
- **`admin.routes.js`'s `persistMetadataFile`** (used by the cloud-key
  repair/rekey endpoints built earlier today, among others) is disk-only,
  no Redis.
- **`IngestSanitizerWorker.js`'s folder renames** — raw `fs.rename*`, no
  Redis touch (and this is the thing that's been silently renaming folders
  mid-session all day).
- Given this pattern, there are very likely more raw-fs call sites in
  `media.routes.js`/other workers that were never audited for this — worth
  a full pass rather than assuming MetadataRegistry is used everywhere.

**Net effect**: for a large fraction of real metadata writes — specifically
almost everything in the movies transcode/cloud-sync/repair flow this
session was built around — Redis never sees the update. The *only*
replication path for those is the manual file-level rsync
(`scripts/sync-app-folders.sh`), which until today wasn't even being run
regularly, and had a silent bug (root-ownership `chgrp` failures) quietly
failing the user-profiles leg on every run.

### File/folder/media data

Not covered by Redis at all (Redis is not a filesystem — expected). Only
covered by `sync-app-folders.sh`, run manually. As of today: fixed (ownership
bug) and confirmed clean, and about to move to a periodic cron (see below).

## Options considered for going forward

**A. Keep rsync, make it periodic (short-term, what we're doing now)**
- Pro: zero new infrastructure, already proven to work, easy to reason about.
- Con: still a full-tree diff/scan each run; doesn't scale cleanly to
  several downstream servers; a fixed interval means a worst-case staleness
  window regardless of how much actually changed.

**B. Event-driven push sync (rsync or scp of just the changed file(s),
triggered right after a write)**
- Pro: near-live propagation, no polling/scanning overhead, scales better
  with more downstream servers (fan-out from one write event).
- Con: needs every write path identified and hooked (the MetadataRegistry
  gap above means this only works if we first close that gap — otherwise
  we'd need to hook raw fs writes too, which is fragile and easy to miss a
  call site, exactly the kind of thing that already bit us).

**C. Make Redis the single source of truth for metadata, generate files
from it**
- This was the original instinct ("we were going to create a Redis
  writer") but as Josh noted, this inverts the problem awkwardly: Redis
  isn't the filesystem, so a Sydney-side process would need to watch Redis
  changes and regenerate/write local files and folder structure from them —
  a second, different kind of sync engine, and one that has to handle
  folder renames and file moves, not just JSON content. Feels riskier than
  it saves.

**D. Route metadata reads through Redis everywhere, treat disk as a local
cache**
- If every write path is fixed to go through MetadataRegistry (closing the
  gap above), Sydney's *reads* could mostly come from its already-live Redis
  replica without needing file-level sync for metadata JSON content at all.
  This wouldn't need a new sync mechanism — it's "finish wiring the thing we
  already built." Doesn't cover covers/subtitles (those are real files, not
  JSON), so file-level sync is still needed for those specifically, but the
  set of things needing rsync shrinks a lot.

None of these are mutually exclusive — (D) reduces what (A)/(B) need to
cover, and is probably the highest-leverage next step precisely because the
infrastructure (MetadataRegistry, Redis replication) already exists and
works; it just isn't used consistently.

## Open questions (not decided, need Josh's input)

1. Is it worth auditing/closing the MetadataRegistry gap (movies
   cloud-sync path, admin repair endpoints, IngestSanitizerWorker) before
   investing further in a smarter sync mechanism? This seems like the
   cheapest lever available and de-risks everything downstream of it.
2. For covers/subtitles specifically (real files, can't go through Redis):
   push them to the CDN/object storage directly (as Josh noted "covers...
   should technically be pushed to CDN") instead of syncing them
   file-to-file between app servers at all? That would remove them from
   this problem entirely, similar to how video files already work.
3. How many downstream servers are actually planned, and on what timeline?
   Changes the calculus a lot between "periodic rsync is fine" and "we need
   real fan-out."
4. Should user data (config/history/playback) stay on the current
   Redis-replica-plus-LA-write-authority model permanently, or does that
   also need revisiting once there are 3-4 regions (write latency from a
   distant region back to LA could get worse)?

## For now (per Josh, 2026-08-21)

Turn on periodic sync using the existing script while the above gets
figured out properly — see `scripts/sync-app-folders.sh` (in the
`anymovie.project` repo) and its new cron entry.
