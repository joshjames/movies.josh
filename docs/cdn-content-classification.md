# CDN Content Classification and Migration Map

Status as of 2026-08-07. This is the ground-level companion to
[flat-cdn-json-architecture-plan.md](flat-cdn-json-architecture-plan.md): that document
describes the target architecture for flat JSON + edge replication, this one classifies
what actually exists on disk today, records which classes have moved to the edge, and
sequences the rest.

**Live now:** catalog covers, TV covers, and local per-title movie/series covers
(`/movie-assets/**/cover.jpg`) serve from `images.any.movie` (Cloudflare R2). Everything
else still serves from origin.

---

## 1. Content classifiers

Six classes. The classifier is what decides cache policy, hostname, and replication
mechanism — not the directory a file happens to sit in.

| # | Class | Extensions | Mutability | Cache policy | Delivery |
|---|-------|-----------|------------|--------------|----------|
| 1 | **Images** | `.jpg` `.jpeg` `.png` `.webp` `.ico` | Effectively immutable per URL | `max-age=31536000, immutable` + `?v=<mtime>` | **R2 → `images.any.movie`** (covers live; rest pending) |
| 2 | **Media** | `.mp4` `.mkv` `.mpeg` `.avi` `.mp3` `.m4a` | Immutable once ingested | Long, range-request driven | Backblaze B2 presigned (today) → R2 `content.any.movie` (target) |
| 3 | **Subtitles** | `.srt` `.vtt` `.sub` `.sup` | Mutable — re-fetched, re-synced, corrected | Short (`max-age=300`) or versioned | Origin (today) |
| 4 | **Metadata** | `.json` | Mixed: catalogs near-static, feeds volatile | Immutable rows + short-TTL manifests | Origin (today) — this is the flat-JSON plan's target |
| 5 | **Code** | `.html` `.js` `.css` `.webmanifest` | Changes every deploy | Must be build-hashed before any CDN move | Origin (baked into image) |
| 6 | **Operational** | `.tsv.gz` `.log` `.csv` `.env` `.py` `.sh` | n/a | Never public | Never served |

Two rules that fall out of this and are worth stating explicitly:

- **Class is not directory.** `public/css/login-background.jpg` is a class-1 image sitting
  in a code directory. `public/data/welcome-assets.js` is class-4 metadata with a `.js`
  extension. Classify by role, then by extension.
- **Mutability determines everything else.** Classes 1 and 2 are safe to push to an
  immutable edge cache today. Classes 3 and 4 are not, until they carry a version token.
  Class 5 is not, until the build emits content-hashed filenames.

---

## 2. Content inventory by location

### 2.1 In-repo (baked into the container image)

| Path | Class | Files | Size | Served at | CDN status |
|------|-------|------:|-----:|-----------|------------|
| `public/images/catalog-covers/` | Images | 985 | 31 MB | `/images/catalog-covers/` | ✅ **On CDN** |
| `public/images/avatars/` | Images | 137 | 2.6 MB | `/images/avatars/` | Pending — phase 2b |
| `public/images/welcome-covers/` | Images | 20 | 1.3 MB | `/images/welcome-covers/` | Pending — phase 2b |
| `public/images/icons/` | Images | 4 | 216 KB | `/images/icons/` | Pending — phase 2b |
| `public/images/*.{png,jpg}` | Images | 2 | 160 KB | `/images/` | Pending — phase 2b |
| `public/css/login-background.jpg` | Images | 1 | ~148 KB | `/css/` | Pending — misfiled, move to images |
| `public/media/demo.mp4` | Media | 1 | 5.0 MB | `/media/` | Pending — phase 3 |
| `public/*.html` | Code | 26 | ~800 KB | `/` | Blocked on build hashing |
| `public/js/` | Code | 4 | 28 KB | `/js/` | Blocked on build hashing |
| `public/css/` (stylesheets) | Code | — | ~0 KB | `/css/` | Blocked on build hashing |
| `public/data/news.json` | Metadata | 1 | 2 KB | `/data/` | Phase 4 (flat-JSON plan) |
| `public/data/welcome-assets.js` | Metadata | 1 | 3.2 KB | `/data/` | Phase 4 |
| `metadata/catalog_*.json` | Metadata | 70 | 38 MB | not directly served | Phase 4 |
| `.data/` (IMDb TSV dumps, build scripts) | Operational | — | 1.1 GB | never served | Never |

### 2.2 Host volumes (mounted into the container)

| Host path | Container path | Class mix | Size | CDN status |
|-----------|----------------|-----------|-----:|------------|
| `/home/epic/movies` | `/app/storage/movies` | Media 597 GB · Images 269 covers · Subtitles 1071 srt (107 MB) · Metadata 283 json | **598 GB** | Media on B2; ✅ **covers on CDN**; subs phase 5 |
| `/data/blockchain/media/Series` | `/app/storage/series` | Media (957 mkv + 271 mp4) · Subtitles 1208 srt · Images 43 cover.jpg (+2 season-level, not synced) · Metadata 90 json | **614 GB** | Media on B2; ✅ **covers on CDN**; subs phase 5 |
| `/home/epic/movie-streamer-data` | `/app/metadata` | Images `tv-covers/` 325 files (9.9 MB) · Metadata feeds (~3 MB) | 13 MB | ✅ **tv-covers on CDN**; feeds phase 4 |
| `/home/epic/movie-streamer/metadata` | `/app/catalog-metadata` (ro) | Metadata catalogs | 38 MB | Phase 4 |
| `/home/epic/movie-streamer-cache/audio` | `/app/cache/audio` | Media (transient remuxes) | 7.5 GB | Never — derived cache |
| `/home/epic/tobedel` | `/app/archive` | Operational | 140 KB | Never |
| `/home/epic/redis/data` | `/data` (redis) | Operational | — | Never |

**Total media footprint: ~1.2 TB.** That is the number that makes phase 3 the dominant
cost decision, and it is why media replication needs a per-title policy rather than a
bulk sync.

### 2.3 Cover URL shapes in use

Four distinct URL forms reach the browser. All of them now funnel through
`CoverUrlService`, which is the single rewrite chokepoint:

| URL shape | Backing store | On CDN? |
|-----------|---------------|---------|
| `/images/catalog-covers/<imdbId>.jpg` | `public/images/catalog-covers/` | ✅ yes |
| `/api/tv-shows/<imdbId>/cover` | `/app/metadata/tv-covers/` (fetch-on-miss from OMDb/TMDB) | ✅ yes, when synced |
| `/movie-assets/<folder>/cover.jpg` | `/app/storage/movies/<folder>/cover.jpg` | ✅ yes, when synced |
| `/movie-assets/series/<folder>/cover.jpg` | `/app/storage/series/<folder>/cover.jpg` | ✅ yes, when synced |

**Chokepoint gap found and fixed during rollout:** unlike catalog and TV covers, local
movie/series covers were not built through `CoverUrlService` everywhere. Six separate
call sites in `media.routes.js`, `LibraryScanner.js`, and `SeriesSubscriptionService.js`
built `/movie-assets/...` strings directly — most visibly the `/api/movies` list route,
which re-versioned `item.cover` with its own ad-hoc `Date.now()`-based token instead of
calling `versionCoverUrl()`. Adding the bucket mapping alone did nothing for those call
sites; each had to be routed through `versionCoverUrl()` individually. If a cover
somewhere is still showing an origin path with a plain `?v=<epoch>` token instead of an
`images.any.movie` URL, that is the pattern to search for: a raw template literal
building `/movie-assets/...` instead of calling `versionCoverUrl(...)`.

---

## 3. Domain and bucket allocation

R2 is **not** a CDN on its own — it is object storage. It becomes a CDN when a custom
domain on one of your Cloudflare zones is attached to the bucket, at which point requests
are served through Cloudflare's edge with normal cache behaviour. The free
`pub-<id>.r2.dev` managed domain is also Cloudflare-fronted but is rate-limited and not
intended for production; leave it disabled.

Attaching a custom domain auto-creates the proxied DNS record. **No manual DNS work is
required**, and there is no such thing as a "DNS bucket".

| Hostname | Bucket | Class | Status |
|----------|--------|-------|--------|
| `images.any.movie` | `imagesanymovie` (APAC) | Images | ✅ **Live** — 1622 objects |
| `content.any.movie` | `contentanymovie` (default) | Media | ⚠️ Domain live, **bucket empty** — media still on Backblaze |
| `cache.any.movie` | *(not created)* | Metadata / flat JSON | Reserved for phase 4 |
| `subs.any.movie` | *(not created)* | Subtitles | Reserved for phase 5 |
| `static.any.movie` | *(not created)* | Code (hashed assets) | Reserved for phase 6 |

Mirror hostnames on `anymovie.online` and the other zones are deliberately **not** created
yet. Attaching a second custom domain to an existing bucket is one API call and requires
no code change, so there is nothing to gain from doing it before the primary is proven.

Buckets that exist in the account but are unrelated to this project: `checkthis`,
`vapefinder`.

---

## 4. What is live: the image CDN

### Architecture

```
public/images/catalog-covers/  ─┐
                                ├─ scripts/cdn-sync-images.sh (rclone) ─→ R2: imagesanymovie
/app/metadata/tv-covers/       ─┘                │                              │
                                                 │                    images.any.movie (Cloudflare edge)
                                                 ↓                              │
                        cdn-images-manifest.json │                              ↓
                                                 │                          browser
                                                 ↓                              │
       CoverUrlService.versionCoverUrl() ←── CdnAssetService                    │
                    │                                                           │
       CDN URL if key in manifest, else origin path                             │
                                                        origin fallback ────────┘
                                                        (public/js/cdn-fallback.js)
```

### The three safety layers

The migration is designed so that no single failure produces a broken image:

1. **Manifest gating.** `CdnAssetService` only rewrites a URL to the CDN if the sync job
   recorded that exact object key in `cdn-images-manifest.json`. A partial sync, a new
   cover that has not been replicated yet, or a missing manifest all mean the URL keeps
   its origin path. There is no optimistic rewriting.
2. **Browser origin fallback.** `public/js/cdn-fallback.js` catches image load errors in
   the capture phase, and if the failing URL is on the CDN host it retries the equivalent
   origin URL before the page's own placeholder handler runs. This covers edge incidents
   and client networks that cannot reach the CDN hostname.
3. **Kill switch.** `CDN_IMAGES_ENABLED=false` reverts every cover to origin serving on
   the next request. No redeploy of assets, no cache purge, no code change.

Failure modes verified by `tests/cdnAsset.test.js`: CDN disabled, manifest missing,
manifest corrupt, base URL unset, object not in manifest, unmapped path, path traversal.
All fall back to origin.

### Configuration

In `.env` (app side — read-only, needs no R2 credentials):

```bash
CDN_IMAGES_ENABLED=true
CDN_IMAGES_BASE_URL=https://images.any.movie
R2_IMAGES_BUCKET=imagesanymovie
# CDN_IMAGES_MANIFEST_PATH=   # defaults to $METADATA_DIR/cdn-images-manifest.json
```

The manifest is written to the shared metadata volume
(`/home/epic/movie-streamer-data/cdn-images-manifest.json` → `/app/metadata/...`) so the
host-side sync job and the container read the same file. `CdnAssetService` re-reads it
when its mtime changes, at most once every 30 s — no restart needed after a sync.

### Credentials

| File | Keys | Scope | Use |
|------|------|-------|-----|
| `cftoken.env` | `ACCOUNT_API_KEY`, `ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` | Account-wide | Sync + purge. **Required** for `imagesanymovie`. |
| `.env` | `ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` | Bucket-scoped to `contentanymovie` | Media only — returns `AccessDenied` on the images bucket. |
| `cloudflare.env` | `ACCESS_KEY_ID`/`SECRET_ACCESS_KEY` | — | ❌ **Dead.** Verified `AccessDenied`. Safe to delete. |

The app container is intentionally given no write credentials for the images bucket. It
only rewrites URLs; replication is a host-side operation.

---

## 5. Runbook

### Replicate new or changed images

```bash
npm run cdn:sync:images            # sync both prefixes, rebuild manifest
npm run cdn:sync:images:dry        # show what would transfer, change nothing
./scripts/cdn-sync-images.sh --only tv-covers
npm run cdn:manifest               # rebuild manifest from bucket without transferring
```

`rclone sync` is size/mtime based, so re-running is cheap and idempotent. It also deletes
bucket objects whose local source is gone, which keeps the manifest honest.

> **Known wrinkle:** rclone v1.60 (the version on this host) intermittently gets
> `501 NotImplemented` from R2 on the first attempt for a batch. Its built-in retry
> resolves it, and `rclone check` afterwards has reported 0 differences on every run so
> far. If this becomes noisy, upgrade rclone rather than adding workarounds.
>
> **Second wrinkle (movie-assets only):** `--include "*/cover.jpg"` is not depth-limited
> in rclone — it matches the filename regardless of how many directories precede it. For
> the flat `catalog-covers`/`tv-covers` directories this doesn't matter, but the
> movie/series trees have per-season `cover.jpg` files one level deeper. The script pairs
> the filter with `--max-depth 2` to exclude them (see `FILTERS`/`sync_prefix()` in
> [cdn-sync-images.sh](../scripts/cdn-sync-images.sh)). `--max-depth` limits *both* the
> source and destination listing, so if a stray deep object is ever uploaded before this
> is in place, a normal sync run will not see it to delete — it needs a one-off manual
> `DeleteObjects` call.

### Verify

```bash
# Bucket matches local, byte for byte
rclone check public/images/catalog-covers :s3:imagesanymovie/catalog-covers <s3 flags> --size-only

# Edge is serving with the right headers (expect MISS then HIT)
curl -sI https://images.any.movie/catalog-covers/tt0111161.jpg

# What the app thinks
node -e 'require("dotenv").config(); console.log(require("./src/services/CdnAssetService").getStatus())'
```

### Invalidate

Purging is rarely needed: covers are emitted with `?v=<mtime>`, so replacing a file
produces a new URL that misses cache on its own.

```bash
npm run cdn:purge -- --key catalog-covers/tt0111161.jpg
npm run cdn:purge -- --prefix catalog-covers/     # Enterprise plan only
npm run cdn:purge -- --all                        # whole zone — affects all hostnames
```

### Roll back

```bash
# In .env
CDN_IMAGES_ENABLED=false
```

Then restart the app container. Covers revert to origin immediately; the bucket and DNS
can be left in place.

---

## 6. Roadmap

Ordered by value-to-risk. Each phase should land and be observed before the next starts.

### Phase 2 — local per-title covers ✅ done

Scope: the 269 movie `cover.jpg` files under `/app/storage/movies` and the 43 series
`cover.jpg` files under `/app/storage/series` (one level deep only — 2 season-level
covers, e.g. `House.of.the.Dragon/Season.01/cover.jpg`, are deliberately excluded; nothing
in the app requests them).

Shipped:
- `movie-assets/` and `movie-assets/series/` prefixes added to `SOURCES` in the sync
  script, filtered to `*/cover.jpg` with `--max-depth 2` (an `--include` pattern alone is
  not depth-limited in rclone — it matches the filename regardless of nesting, so the
  first sync pass picked up the 2 season-level covers too; `--max-depth 2` fixed it, but
  files a filtered-out sync had already uploaded before the fix needed a manual delete —
  sync's own delete pass can't see past `--max-depth` either).
- `PREFIX_MAP` in `CdnAssetService` extended with both prefixes, series checked before the
  generic movie prefix (`/movie-assets/series/` is itself a prefix match of
  `/movie-assets/`).
- All six local-cover emission sites fixed to route through `versionCoverUrl()` (see the
  chokepoint-gap callout in §2.3) — this was the larger part of the work, not the bucket
  mapping.
- Browser fallback (`cdn-fallback.js`) extended with the same two prefixes.
- Ongoing replication is still a manual `npm run cdn:sync:images` / cron, not push-on-
  ingest — a cover added or changed between syncs is on origin (or briefly stale on the
  edge) until the next run. That gap is real but low-severity: covers change rarely
  relative to library scans, and the `?v=<mtime>` token means a changed local file
  produces a new URL on its next sync rather than serving a stale image indefinitely.

Follow-up (not yet done): hook a push on ingest-pipeline completion so a newly added
title's cover reaches the edge without waiting for the next scheduled sync.

### Phase 2b — remaining static images *(next)*

Scope: `avatars/` (137), `welcome-covers/` (20), `icons/` (4), the 2 loose files, and
`css/login-background.jpg`.

Work:
- Add `avatars/`, `welcome/`, `icons/`, `ui/` prefixes to `SOURCES` in the sync script and
  to `PREFIX_MAP` in `CdnAssetService`. The manifest gating means this is additive and
  safe. These are flat, static directories — no `--max-depth`/filter caveat like phase 2.
- Relocate `css/login-background.jpg` into `public/images/` so class and directory agree.

Risk: low. Same proven mechanism, no new emission-site auditing expected (these are all
already built through a single template in `scripts/build-welcome-assets.js` or served
statically) — but audit for stray direct references before assuming that.

### Phase 3 — media

Scope: ~1.2 TB across movies and series, currently on Backblaze B2 with 2-hour presigned
URLs generated in `MediaService.js`.

Work:
- Decide B2-plus-R2 versus a migration to R2. R2 has zero egress fees and Cloudflare
  Bandwidth Alliance already makes B2 egress via Cloudflare free, so this is a latency
  and operational-simplicity decision, not purely a cost one.
- `content.any.movie` and its bucket already exist and are empty — the edge half is done.
- The real work is replication throughput and a per-title policy: 1.2 TB will not move in
  one pass, and not every title deserves edge residency. Drive it from watch frequency.
- Signed-URL strategy has to be settled before any public bucket exposure. Media must not
  become anonymously fetchable.

Risk: high. Largest data volume, and it is the paid product.

### Phase 4 — metadata / flat JSON

This is [flat-cdn-json-architecture-plan.md](flat-cdn-json-architecture-plan.md), not a
new workstream. The image CDN establishes the pieces it needs: a bucket, a sync
mechanism, a manifest pattern, and a purge tool. Reserved hostname: `cache.any.movie`.

Immutable row files plus short-TTL manifests, per that plan. The `?v=` token used for
covers is the same idea at a smaller scale.

### Phase 5 — subtitles

Scope: 2279 `.srt` files, ~107 MB in movies alone.

Small and cacheable, but genuinely mutable — subtitles get re-fetched and re-synced.
Needs a version token in the URL before it can go behind an immutable cache. Low value
relative to phases 2–4; do it after the pattern is well worn. Reserved hostname:
`subs.any.movie`.

### Phase 6 — code assets

Blocked on a build step. The 26 HTML files reference `/js/*.js` and `/css/*.css` by
unhashed name, so pushing them to an immutable edge cache would make deploys unshippable.
Requires content-hashed filenames first. Reserved hostname: `static.any.movie`.

### Not migrating

`.data/` (IMDb TSV dumps and build scripts), `/app/archive`, `/app/cache/audio` (derived
remuxes), Redis data, and all `.env` files. These are operational inputs or derived
caches and are never served.
