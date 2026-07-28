# Flat CDN JSON Architecture Plan (Global + User Collections)

## Why this plan

You want the browse/index experience to become mostly static, edge-cached, and fast.

That is aligned with the current scaling guidance:
- Keep a single write authority first.
- Replicate read surfaces safely.
- Move heavy read traffic to CDN/object storage.

This document proposes a hybrid model:
- Global rows are pre-generated JSON and cached aggressively.
- User rows (My Library, Collections) are generated per user and delivered from private object paths with short-lived access.
- A small dynamic API remains for near-real-time rows (recently added, notifications).

## Current baseline in this repo

- Home feed already exists as generated JSON via `metadata/home_feed.json` and `metadata/recent_feed.json` with `/api/home-feed` serving it.
- Multiple pre-generated category files already exist under `metadata/catalog_*.json` and are read by media routes.
- Metadata truth is file-based (`metadata.json` per title), while Redis is currently a derived/read model in several flows.
- Active/active guidance is currently single-active queue/write coordinator.

So this is not a rewrite. It is a staged evolution of patterns you already have.

## Architecture goals

1. Reduce homepage/category API compute to near-zero for most requests.
2. Make global browse rows immutable, cacheable, and easy to replicate.
3. Support user-created collections without exposing whole user datasets publicly.
4. Keep the write path centralized while read paths scale to CDN.
5. Avoid expensive CDN purge storms through manifest/version indirection.

## Recommended target model

### 1) Data planes

- Control plane (API): auth, writes, collection mutations, on-demand generation triggers.
- Global read plane (public CDN): global row manifests and row payload files.
- User read plane (private CDN/object paths): per-user manifests and row payload files.
- Dynamic read plane (API or low-TTL edge worker): very fresh rows such as recently added and notifications.

### 2) JSON contract types

- Manifest: list of rows for a surface and pointers to immutable payload files.
- Row payload: cards for one row.
- Card: minimal display model used by frontend renderer.

### 3) Versioning strategy (important)

Use immutable row files and mutable manifests:

- Row file example: `rows/top-50-action.8f2c9d1a.json`
- Manifest points to latest row file URLs.
- CDN TTL:
  - Row files: very long (`max-age=31536000, immutable`)
  - Manifest: short (`max-age=30` to `300`)

This avoids frequent purge calls; publishing a new row is a new file + manifest pointer swap.

## Proposed storage layout

Use clear prefixes and sharding to avoid huge single directories.

Global (public):

- `v1/global/home/manifest.json`
- `v1/global/home/rows/recently-added.<version>.json`
- `v1/global/home/rows/top-rated.<version>.json`
- `v1/global/catalogs/<slug>/manifest.json`
- `v1/global/catalogs/<slug>/rows/<row-id>.<version>.json`

User (private):

- `v1/users/<shard>/<userKey>/manifest.json`
- `v1/users/<shard>/<userKey>/rows/my-library.<version>.json`
- `v1/users/<shard>/<userKey>/rows/collection-<collectionId>.<version>.json`

Where:
- `userKey` is opaque (not plain username/email).
- `shard` is first 2-3 chars of a stable hash of `userKey`.

## Frontend loading model

Index page loads in this order:

1. Fetch global manifest from CDN (public).
2. Render global rows immediately.
3. If logged in, fetch user manifest with temporary auth (private path).
4. Merge user rows into UI (My Library + user collections).
5. Poll or stream only dynamic rows (recent events/notifications), not everything.

This gives a fast first paint while still allowing personalization.

## User collections data model

Treat user collections as metadata references, not duplicated media blobs.

Collection record:
- `collectionId`
- `ownerUserId`
- `name`
- `slug`
- `visibility` (`private` for now)
- `createdAt`, `updatedAt`

Collection item record:
- `collectionId`
- `mediaType` (`movie|series`)
- `mediaId` (prefer IMDb identity)
- optional pin/order metadata
- `addedAt`

Important:
- Store only IDs and lightweight card hints in collection source-of-truth records.
- Resolve to final card shape during materialization.

## Materialization pipeline (generation)

### Global rows

Trigger on:
- Scheduled rebuild (for trending/popular/time-window rows).
- Pipeline completion events for rows impacted by new media.
- Manual admin regeneration endpoint.

Flow:
1. Build row payload JSON.
2. Write immutable row file.
3. Update manifest pointer atomically.
4. Optionally write local mirror copy.

### User rows

Trigger on:
- Collection create/rename/delete.
- Add/remove title in collection.
- Library membership changes for that user.

Flow:
1. Rebuild only impacted user row(s).
2. Write immutable row payload(s) to user prefix.
3. Update user manifest atomically.

Do not regenerate all users at once.

## Auth and secure delivery

Do not expose raw user folder names directly.

Recommended:
- Private bucket/CDN origin for `/v1/users/**`.
- Short-lived token (JWT or signed URL/cookie) scoped to user prefix only.
- Backend issues token at login/session refresh.
- Token claims include allowed prefix and expiry.

Alternative:
- Keep user manifest/rows behind API proxy initially, then shift to direct signed CDN access later.

## Consistency and write authority

Given current architecture, keep one write authority for generation in phase 1:
- One site/process performs manifest and row writes.
- Other sites read from object storage/CDN.

This matches active-active guidance and avoids dual-writer races.

## Handling dynamic rows

You correctly identified that not everything should be static.

Keep these dynamic (API or low-TTL edge worker):
- Recently added (if you need near-immediate freshness).
- Notifications feed.
- Live queue/progress states.

Everything else should default to pre-generated payloads.

## Caching policy

Recommended defaults:

- Global row payloads: 1 year immutable.
- Global manifests: 30-300 seconds.
- User row payloads: 1 day to 30 days immutable (versioned).
- User manifests: 15-120 seconds.
- Dynamic APIs: 0-15 seconds or no-store depending on sensitivity.

Use ETag/If-None-Match on manifests for cheap revalidation.

## Failure and fallback behavior

If user manifest fetch fails:
- Show global rows only.
- Defer user rows and show non-blocking warning in UI.

If row payload file is missing:
- Skip that row.
- Keep rendering rest of manifest.

If generation fails:
- Keep last known good manifest.
- Emit alert and retry job.

## Should you do data-model perfection first?

Recommendation: do contract-first, then parallel implementation.

Do not wait for a "perfect" entire data model. Instead:
1. Freeze JSON contracts (manifest/row/card) and identity rules (IMDb-centric).
2. Implement global static feed pipeline first.
3. Add user collections source model and per-user materializer.
4. Add private CDN tokenized access.
5. Iterate on richer filters/smart collections later.

This avoids large rework while preserving momentum.

## Phased implementation plan

### Phase 0: Contract and observability (1-3 days)

- Define schema files for manifest/row/card and collection records.
- Add versioning/hash naming helper.
- Add metrics: generation latency, manifest publish success, stale age.

Exit criteria:
- Schemas approved.
- Example global and user manifests validated by frontend parser.

### Phase 1: Global home flattening (3-7 days)

- Add publisher that writes global manifests + immutable rows to object storage.
- Keep existing `/api/home-feed` as fallback.
- Frontend reads CDN manifest first, API fallback second.

Exit criteria:
- Home/index works fully from CDN on cache hit.
- API load reduced significantly for browse traffic.

### Phase 2: Catalog flattening (3-7 days)

- Move catalog JSON generation to same manifest/row format.
- Normalize naming for movie/tv catalogs.

Exit criteria:
- Catalog browsing no longer requires expensive runtime aggregation.

### Phase 3: User collections model + APIs (5-10 days)

- Add endpoints:
  - `POST /api/collections`
  - `PATCH /api/collections/:id`
  - `DELETE /api/collections/:id`
  - `POST /api/collections/:id/items`
  - `DELETE /api/collections/:id/items/:mediaId`
- Persist source-of-truth records (Redis + disk mirror or DB).
- Build per-user manifest materializer.

Exit criteria:
- Users can create rows and add movie/series titles.
- User manifest reflects changes quickly.

### Phase 4: Private CDN delivery for user rows (4-8 days)

- Add short-lived scoped token issuance at login refresh.
- Serve user manifest/rows directly from private CDN path.
- Keep API proxy fallback path.

Exit criteria:
- User rows fetched directly from CDN with scoped auth.

### Phase 5: Dynamic row split and mobile drawer integration (3-6 days)

- Keep only dynamic rows via API polling/stream.
- Build left drawer payload contract:
  - Search
  - My Library
  - Queue
  - User Collections list

Exit criteria:
- Mobile drawer is fully data-driven from manifests + dynamic endpoints.

## Suggested JSON examples

Global manifest example:

```json
{
  "version": "2026-07-28T10:15:00Z",
  "surface": "home",
  "rows": [
    {
      "id": "top-rated-row",
      "title": "Top Rated",
      "subtitle": "IMDb score 8.0 and up",
      "href": "/v1/global/home/rows/top-rated.8f2c9d1a.json"
    },
    {
      "id": "weekly-fresh-row",
      "title": "Weekly Fresh",
      "subtitle": "New this week",
      "href": "/v1/global/home/rows/weekly-fresh.91ab3321.json"
    }
  ]
}
```

User manifest example:

```json
{
  "version": "2026-07-28T10:16:10Z",
  "userKey": "u_8a2f4c...",
  "rows": [
    {
      "id": "my-library",
      "title": "My Library",
      "href": "/v1/users/8a/u_8a2f4c/rows/my-library.1f77d91c.json"
    },
    {
      "id": "collection-7f3b",
      "title": "Friday Night Sci-Fi",
      "href": "/v1/users/8a/u_8a2f4c/rows/collection-7f3b.0bd23aa1.json"
    }
  ]
}
```

## Operational notes

- Keep a local mirror of published manifests for disaster recovery.
- Add idempotent publish jobs with lock keys to prevent duplicate writes.
- Add periodic reconciliation job to verify manifest pointers reference existing row objects.
- Add stale-data alarms (for example, if global manifest age exceeds threshold).

regular api update build dynamic rows for 

 - dont forget - continue watching row. needs generating based 
 on users watch history and unfinished.

 - consider a "shows i watch and new episodes"


## Risks and mitigations

Risk: Too many small files per heavy user.
- Mitigation: batch updates, debounce materialization, cap collection count initially.

Risk: Token leakage to private paths.
- Mitigation: short TTL, path-scoped tokens, rotate signing keys.

Risk: Dual-writer overwrite in multi-site.
- Mitigation: single writer for publish path until centralized locking/versioning exists.

Risk: Frontend complexity during migration.
- Mitigation: one reader abstraction with source priority (CDN manifest -> API fallback).

## Immediate next steps for this repo

1. Add a shared manifest schema module and validator.
2. Implement a `FeedPublishService` that writes versioned row files + manifests.
3. Update index loader to consume manifest format first.
4. Introduce collection CRUD model and per-user materializer.
5. Add object storage prefix policy and token issuance flow for `/v1/users/**`.

---

This path lets you evolve toward a mostly flat, globally cached frontend without blocking on full platform redesign, while preserving your current single-writer safety model.