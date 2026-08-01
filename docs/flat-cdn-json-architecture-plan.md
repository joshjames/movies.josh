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

## Multi-client compatibility (Web, Android, Android TV, future iOS)

Your flat JSON contracts should be treated as client APIs, not just files.

### Why this matters

- Android TV should be able to fetch manifests and row payloads directly client-side for responsive card rendering.
- Mobile clients and web should share one contract so feature rollout stays consistent.
- Future iOS support is much easier if contracts are versioned and stable from day one.

### Recommended contract approach

- Introduce schema version in every manifest and row payload:
  - `schemaVersion`
  - `surface`
  - `generatedAt`
  - `expiresAt` (optional)
- Keep card payload minimal and client-friendly:
  - stable identity (`id`, `mediaType`, `imdbId`)
  - display fields (`title`, `subtitle`, `badge`, `cover`, `backdrop`)
  - actions (`playHref`, `detailsHref`)
  - state hints (`progressPct`, `isNewEpisode`, `isContinueWatching`)
- Use additive evolution only for minor changes (do not break existing keys).
- Use `schemaVersion` bump only when a breaking shape change is unavoidable.

### Android TV implementation note

The current Android TV app is still demo-like and static-list oriented.
Before full cutover, update card/domain models so rows are materialized from manifest JSON rather than hardcoded lists.

Client behavior target:
1. Fetch global manifest.
2. Fetch row payloads in parallel.
3. Render rows immediately as each row payload returns.
4. Fetch user manifest after auth and append personalized rows.

This gives very fast perceived performance on TV interfaces.

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

## User path sharding and geo-routing strategy

You are correct to plan sharding now, not later.

### Recommended user path format

Use a path format that supports both performance and routing flexibility:

- `v1/users/<homeRegion>/<shard>/<userKey>/manifest.json`
- `v1/users/<homeRegion>/<shard>/<userKey>/rows/<row-id>.<version>.json`

Where:
- `homeRegion` is a stable region code assigned at user creation (for example: `na`, `eu`, `ap`).
- `shard` is hash-derived from `userKey` (for even distribution).
- `userKey` is opaque and non-guessable.

### Region code recommendation

- Prefer region-level routing (`na`, `eu`, `ap`) over country-level folders.
- Country-code partitioning is usually too granular for operational simplicity and can create rebalancing pain.
- If needed, store country as metadata in profile/config for policy, not object path partitioning.

### Replication and cost guidance

- Do not force global eager replication for private user payloads unless required.
- Keep origin/write in user home region.
- Allow CDN cache fill on demand in other regions when users travel.
- Optionally pre-warm only top active users or top regions based on observed traffic.

This keeps cost lower while preserving good latency.

### Routing behavior

- Login/session resolves user `homeRegion`.
- Token grants access only to that user prefix.
- Read requests prefer nearest edge; edge pulls from home-region origin when cold.
- Optional async migration flow can change `homeRegion` for long-term relocation.

## Backend database sync service (without sacrificing flat frontend)

Your intuition is right: a database layer can improve durability, rebuild speed, and analytics while keeping edge delivery flat.

### Principle

- Frontend serving layer remains JSON manifests and row payloads on CDN/object storage.
- Backend source-of-truth and sync orchestration can use database + queue + Redis.

### Recommended role split

- Redis:
  - hot cache
  - transient coordination locks
  - pub/sub style invalidation events
- Operational database (document or relational):
  - user collections source records
  - manifest publish ledger
  - job state and replay metadata
  - idempotency keys and audit trail
- Object storage/CDN:
  - immutable row payloads
  - mutable manifests
- Analytics warehouse (separate stack):
  - watch behavior events
  - trend computation
  - recommendation feature generation

### Database choice guidance

- MongoDB is a practical fit for document-heavy collection payloads and schema evolution.
- CouchDB can work for replication-oriented use cases but is less common in modern managed infra.
- PostgreSQL with JSONB is also a strong option if you want strict transactional semantics plus flexible JSON.

Pick based on team operational comfort first. For this workload, operational maturity matters more than theoretical model purity.

### Sync and rebuild flow

1. Writes enter API and are committed to operational DB (authoritative write event).
2. Change event is emitted to queue/stream.
3. Materializer rebuilds affected manifest/row JSON objects.
4. Publisher writes objects and atomically updates manifest pointers.
5. Redis cache is updated/invalidated for hot paths.
6. Event copy is sent to warehouse ingestion for analytics/recommendations.

### Why this helps

- Faster disaster recovery (rebuild manifests from DB state + object versions).
- Better failover control and auditing.
- Cleaner foundation for recommendations, trends, and reporting pipelines.
- Keeps user-facing read path lightweight and edge-first.

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

## 3-phase rollout plan

### Phase 1: Transition period (bridge architecture)

Timeline: 2-4 weeks

Work needed:
- Freeze JSON contracts for manifest, row payload, and card payload.
- Implement a shared publisher that writes immutable row files and mutable manifests.
- Convert home/index global rows to CDN-first loading with API fallback.
- Keep dynamic rows (recently added, notifications, queue status) on API for now.
- Add observability: generation latency, publish success, stale manifest age, CDN fetch error rate.
- Add contract test fixtures consumed by web + Android + Android TV clients.

Services and ownership:
- Add `FeedPublishService` for global rows and manifest writes.
- Keep `HomeFeedService` and `/api/home-feed` as fallback surface.
- Add a small frontend reader abstraction that prioritizes CDN manifest then API fallback.

Changes:
- Introduce versioned global row objects under `v1/global/**`.
- Add CI/admin trigger to regenerate and publish manifests.
- Standardize cache headers for rows and manifests.

Considerations:
- Preserve existing UI behavior while swapping data source order.
- Do not purge CDN aggressively; rely on immutable row files + manifest pointer swap.
- Keep one write authority for publish jobs to avoid dual-writer races.

Impact:
- Immediate drop in browse/home API compute and latency.
- Low migration risk because fallback path remains active.
- Establishes the core pattern for all later phases.

Exit criteria:
- Home page renders from CDN manifests on normal path.
- API fallback works when CDN/global manifest is unavailable.
- Publish metrics and alerts are visible and stable.

### Phase 2: Foundation rewrite (major structural changes)

Timeline: 4-8 weeks

Work needed:
- Build user collections domain model (collection + collection items).
- Add collection CRUD APIs and authorization checks.
- Implement per-user materialization pipeline for user manifests and row payloads.
- Add private object storage prefix model and short-lived scoped token issuance.
- Move catalog generation to the same manifest/row contract for consistency.
- Introduce `homeRegion` + shard assignment logic and user-prefix routing.
- Introduce operational database-backed sync ledger for publish/rebuild control.

Services and ownership:
- New `CollectionService` for collection lifecycle and item mutation.
- New `UserManifestService` for per-user row assembly.
- Extend auth/session service for scoped user-path access tokens.
- Optional worker/job queue for debounced user row regeneration.

Changes:
- Add endpoints:
  - `POST /api/collections`
  - `PATCH /api/collections/:id`
  - `DELETE /api/collections/:id`
  - `POST /api/collections/:id/items`
  - `DELETE /api/collections/:id/items/:mediaId`
- Persist source-of-truth collection records (Redis + disk mirror or DB-backed store).
- Publish user manifests under private `v1/users/<shard>/<userKey>/**` prefixes.
- Add left-drawer payload model (Search, My Library, Queue, Collections).

Considerations:
- Keep user identifiers opaque; never expose raw profile identifiers in object paths.
- Debounce writes to prevent object explosion from rapid collection edits.
- Ensure row generation is idempotent and lock-protected.
- Maintain API proxy fallback for private row fetch during rollout.

Impact:
- Enables user-created rows/collections at scale with CDN-backed reads.
- Shifts read load from API/database to object storage + edge cache.
- Introduces the major new complexity area: token security and manifest consistency.

Exit criteria:
- Users can create collections and add movie/series titles.
- User manifests update reliably after collection/library changes.
- Private CDN access works with scoped short-lived tokens.

### Phase 3: Full switchover and scale architecture

Timeline: 2-6 weeks

Work needed:
- Make CDN manifest path primary for global + user surfaces in all clients.
- Remove legacy runtime aggregation paths that are now redundant.
- Keep only explicitly dynamic APIs for volatile rows/events.
- Add cross-site publish safety and reconciliation for multi-region reads.
- Finalize mobile drawer and TV clients to consume manifest contracts natively.
- Finalize analytics export to warehouse and recommendation/trending input feeds.

Services and ownership:
- Publish pipeline becomes the primary browse data control plane.
- API is narrowed to auth, writes, dynamic events, and mutation endpoints.
- Reconciliation/repair job verifies manifests reference existing row files.

Changes:
- Deprecate old direct feed-building code paths after parity validation.
- Remove or downgrade legacy fallbacks that hide production issues.
- Add stricter SLOs for manifest freshness and publish success.
- Add continue-watching and new-episode dynamic contracts (user activity-driven).

Considerations:
- Perform rollback-safe cutover with feature flags per surface.
- Run dual-read validation window before full deprecation.
- Keep single writer for publish authority until distributed locking/versioning is proven.

Impact:
- Frontend browse experience becomes mostly flat, cacheable, and edge-first.
- API and storage costs shift toward predictable publish workloads.
- Platform is ready for broader active/active read scaling with controlled write authority.

Exit criteria:
- 90%+ browse/index reads served from CDN objects (global + user manifests/rows).
- Legacy aggregation paths removed or disabled behind emergency-only flags.
- Manifest freshness and publish error SLOs meet production targets.

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