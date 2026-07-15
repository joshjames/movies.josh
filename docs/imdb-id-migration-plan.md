# IMDb ID Migration Plan

This document breaks the media identity migration into safe phases so the system can move toward IMDb-first storage and queue identity without breaking current ingestion, playback, scans, or user flows.

The target model is:

- `metadata.json` and related manifest files remain the source of truth.
- Redis remains a cache and coordination layer, not the canonical identity store.
- `imdbId` becomes the canonical identity for movies and series.
- Queue and acquisition flows target logical media identities, not release names.
- Folder names and filenames become storage implementation details, not truth.

## End State

At the end of this migration:

- New movies are stored under IMDb-based folders such as `movies/tt0097029/`.
- New series are stored under IMDb-based folders such as `series/tt0944947/`.
- Episodes are resolved by logical identity first, then mapped to whichever file currently satisfies that episode.
- Browse, dedupe, attach, ingest, repair, and playback all use IMDb-first lookups.
- Metadata writes flow through registry code paths only.
- Redis and in-process caches are treated as derived acceleration layers.
- Old title-based folders still work through a compatibility resolver until explicitly migrated.

## Current State Summary

Today the intended architecture is already close to the target, but not fully disciplined.

### What already exists

- [docs/metadata-flow.md](./metadata-flow.md) documents the desired rule: files are truth, Redis is derived.
- [src/services/MetadataRegistry.js](../src/services/MetadataRegistry.js) already provides a write-through metadata path.
- [src/services/db.js](../src/services/db.js) already treats Redis as a fast library snapshot cache with JSON fallback.
- [src/services/workers/PipelineWorker.js](../src/services/workers/PipelineWorker.js) already persists pipeline patch data through `MetadataRegistry.writeAndCommit()`.
- [src/services/SeriesFolderResolver.js](../src/services/SeriesFolderResolver.js) already provides IMDb-based folder resolution for series.

### What is still inconsistent

- Some workers still write `metadata.json` directly to disk instead of using the registry.
- Movie identity still leaks through title and folder-name matching in several places.
- Series identity is partially IMDb-based, but the physical folder naming is still mixed.
- Queue and acquisition still depend on torrent/release naming more than logical identity.
- `series.json` and episode layout are still file-centered rather than fully logical-asset-centered.

## Migration Principles

Every phase below follows these rules:

- Do not break current folders before resolvers exist.
- Do not change read paths and write paths in the same phase unless the compatibility layer is already present.
- Introduce canonical identity before changing physical storage layout.
- Add new metadata fields before making them required.
- Prefer additive migration, then tighten validation later.

## Phase 0: Freeze the Contract

### Goal

Make the architectural contract explicit and stable before changing behavior.

### Changes

- Keep [docs/metadata-flow.md](./metadata-flow.md) as the current operational reference.
- Add this migration plan as the implementation roadmap.
- Define the canonical rule in code comments and future review criteria:
  - canonical truth lives in files
  - Redis is cache only
  - IMDb is canonical identity

### Files to review or annotate

- [docs/metadata-flow.md](./metadata-flow.md)
- [src/services/MetadataRegistry.js](../src/services/MetadataRegistry.js)
- [src/services/db.js](../src/services/db.js)

### Why this phase matters

Without freezing the contract first, later changes risk mixing path-based, title-based, and IMDb-based assumptions.

## Phase 1: Enforce Registry-Only Canonical Writes

### Goal

Ensure canonical metadata files can only be changed through registry-controlled writes so file truth and Redis cache stay coherent.

### Changes

- Route all `metadata.json` writes through `MetadataRegistry.writeAndCommit()` or `mergeAndCommit()`.
- Add a companion manifest registry for `series.json` if needed, or extend `MetadataRegistry` into a more generic manifest writer.
- Remove direct `fs.writeFileSync(...metadata.json...)` writes in workers.

### Primary files to update

- [src/services/MetadataRegistry.js](../src/services/MetadataRegistry.js)
  - possibly extend to handle additional manifest types
  - possibly add `updatedAt`, `version`, or commit metadata
- [src/services/workers/CloudSyncWorker.js](../src/services/workers/CloudSyncWorker.js)
  - replace direct `metadata.json` writes with registry commit
- [src/services/workers/TranscoderWorker.js](../src/services/workers/TranscoderWorker.js)
  - replace direct `metadata.json` writes with registry commit
- [src/services/workers/IngestSanitizerWorker.js](../src/services/workers/IngestSanitizerWorker.js)
  - replace direct series metadata writes with registry commit
- [src/services/workers/PipelineWorker.js](../src/services/workers/PipelineWorker.js)
  - keep as the reference implementation for patch merge and commit

### Why this phase matters

If some code paths write disk directly while others write through registry, the system cannot reliably claim that files are truth and Redis is just a cache. This is the first correctness gate.

### Success criteria

- No canonical `metadata.json` writes bypass the registry.
- Redis and local cache are updated on every canonical write.
- A later rescan is no longer required just to make metadata visible.

## Phase 2: Add Canonical Identity Fields Everywhere

### Goal

Make `imdbId` required as the canonical identity field for movies and series, while preserving legacy fields for compatibility.

### Changes

- Normalize all metadata reads to accept legacy shapes but emit canonical `imdbId`.
- Keep `imdb_id`, `imdbID`, and other legacy aliases readable, but always write back `imdbId` in canonical form.
- Add explicit identity fields to metadata where missing.

### Recommended canonical fields

For movies:

```json
{
  "imdbId": "tt0097029",
  "contentType": "movie",
  "title": "Catch Me If You Can",
  "year": "1989"
}
```

For series:

```json
{
  "imdbId": "tt1234567",
  "contentType": "series",
  "title": "Example Show"
}
```

### Primary files to update

- [src/services/MetadataRegistry.js](../src/services/MetadataRegistry.js)
  - canonicalize on read or write if needed
- [src/services/LibraryScanner.js](../src/services/LibraryScanner.js)
  - keep scanner normalization aligned to canonical `imdbId`
- [src/services/SeriesFolderResolver.js](../src/services/SeriesFolderResolver.js)
  - treat `imdbId` as canonical source key
- [src/routes/admin.routes.js](../src/routes/admin.routes.js)
  - keep repair and normalization flows writing canonical identity back to disk
- [src/routes/media.routes.js](../src/routes/media.routes.js)
  - enforce IMDb-first matching in browse and local lookups
- [src/routes/torrent.routes.js](../src/routes/torrent.routes.js)
  - ensure attachment and acquisition logic stays IMDb-first

### Why this phase matters

You cannot safely move physical folders to IMDb naming until the metadata layer already treats IMDb as the canonical identity everywhere.

### Success criteria

- Every title in the active library can be resolved to one canonical `imdbId`.
- All browse and attach flows prefer IMDb over title/year matching.
- Legacy alias fields remain readable but no longer drive identity.

## Phase 3: Introduce Logical Asset Identity

### Goal

Separate media identity from file path so the queue and repair systems can work against logical targets rather than release names.

### Changes

- Introduce a logical asset model inside metadata.
- For movies, the target is simply the movie IMDb ID.
- For series, the target is the series IMDb ID plus an episode key.
- Treat file variants and source releases as asset implementations, not truth.

### Suggested metadata expansion

Movie asset shape:

```json
{
  "imdbId": "tt0097029",
  "asset": {
    "assetType": "movie",
    "logicalKey": "tt0097029"
  },
  "storage": {
    "files": {
      "1080p": {
        "status": "synced",
        "localPath": "tt0097029/1080p.mp4",
        "remoteKey": "movies/tt0097029/1080p.mp4"
      }
    }
  }
}
```

Series episode shape inside `series.json` or later per-episode manifests:

```json
{
  "seriesImdbId": "tt1234567",
  "episodeKey": "s01e02",
  "seasonNumber": 1,
  "episodeNumber": 2,
  "available": true,
  "localRelativePath": "series/tt1234567/season-01/tt1234567.s01e02.1080p.mp4"
}
```

### Primary files to update

- [src/services/workers/PipelineWorker.js](../src/services/workers/PipelineWorker.js)
  - move queue context toward logical target identity
- [src/routes/torrent.routes.js](../src/routes/torrent.routes.js)
  - enqueue by target media identity, not by release name alone
- [src/services/workers/IngestSanitizerWorker.js](../src/services/workers/IngestSanitizerWorker.js)
  - ingest into logical asset destinations
- [src/routes/media.routes.js](../src/routes/media.routes.js)
  - playback lookup should resolve by identity then current preferred file

### Why this phase matters

This is the actual decoupling step. Once logical identity exists separately from file name, failed downloads, alternate sources, manual repairs, and future redundancy providers become straightforward.

### Success criteria

- Queue payloads can describe the target without depending on torrent naming.
- Playback and library views can resolve an item without trusting folder names.
- Manual replacement of a source file does not change the logical identity of the media.

## Phase 4: Add Read-Optimized IMDb Indexes

### Goal

Move runtime lookups toward precomputed, IMDb-keyed indexes so the system scales by serving memory reads instead of live folder scans.

### Changes

- Generate static JSON indexes from canonical metadata files.
- Load those indexes into memory at boot or hot-reload them on change.
- Keep Redis as an optional fast distribution/cache layer, but do not make it the source of identity.

### Suggested index files

- `metadata/indexes/movies-by-imdb.json`
- `metadata/indexes/movies-by-title-year.json`
- `metadata/indexes/series-by-imdb.json`
- `metadata/indexes/episodes-by-series.json`
- `metadata/indexes/library-summary.json`

### Primary files to update

- [src/services/LibraryScanner.js](../src/services/LibraryScanner.js)
  - either evolve into an index compiler or feed one
- [src/services/db.js](../src/services/db.js)
  - keep Redis snapshot support but document it as derived
- [src/routes/media.routes.js](../src/routes/media.routes.js)
  - resolve browse and playback from compiled indexes where possible
- [src/routes/admin.routes.js](../src/routes/admin.routes.js)
  - expose repair/rebuild endpoints for index regeneration

### Why this phase matters

This is where the architecture becomes operationally scalable. Requests should read precomputed data from memory, not traverse folders or merge live metadata repeatedly.

### Success criteria

- Common user requests can be served from in-memory indexes.
- Full filesystem scans become background maintenance tasks, not request-path dependencies.
- Multi-node deployment can share replicated metadata and compiled index files.

## Phase 5: Introduce IMDb-Based Folder Naming For New Writes

### Goal

Switch physical layout for new ingests to IMDb-based paths without breaking old content.

### Changes

- New movies ingest into `movies/<imdbId>/`.
- New series ingest into `series/<imdbId>/`.
- New episode media writes into predictable series subpaths.
- Existing title-named folders remain readable through resolver compatibility.

### Suggested layout

Movies:

```text
movies/
  tt0097029/
    metadata.json
    1080p.mp4
    cover.jpg
```

Series:

```text
series/
  tt1234567/
    metadata.json
    series.json
    season-01/
      tt1234567.s01e01.1080p.mp4
      tt1234567.s01e02.1080p.mp4
```

### Primary files to update

- [src/services/workers/IngestSanitizerWorker.js](../src/services/workers/IngestSanitizerWorker.js)
  - stop deriving canonical folder names from release titles for new items
- [src/services/SeriesFolderResolver.js](../src/services/SeriesFolderResolver.js)
  - support canonical folder naming plus legacy aliases
- [src/services/StoragePathResolver.js](../src/services/StoragePathResolver.js)
  - resolve canonical IMDb-based paths first, legacy paths second
- [src/routes/admin.routes.js](../src/routes/admin.routes.js)
  - add migration and repair operations for folder normalization

### Why this phase matters

This is the visible storage shift, but it should happen only after identity and lookup semantics are already decoupled.

### Success criteria

- All new ingests use IMDb-based root folders.
- Old folders still play, scan, and attach correctly.
- No user-facing features depend on title-based folder naming anymore.

## Phase 6: Make Queue and Acquisition Intent Logical

### Goal

Turn the queue into an intent system that targets media identity rather than a specific release string.

### Changes

- Queue movie requests as `acquire movie ttXXXXXXX`.
- Queue episode requests as `acquire series ttXXXXXXX episodeKey`.
- Store source attempts separately from logical intent.
- Allow future provider redundancy and manual replacement without changing the target.

### Suggested queue payloads

Movie:

```json
{
  "contentType": "movie",
  "imdbId": "tt0097029",
  "qualityProfile": "1080p",
  "addedByUser": "josh"
}
```

Series episode:

```json
{
  "contentType": "series",
  "imdbId": "tt1234567",
  "episodeKey": "s01e02",
  "qualityProfile": "1080p",
  "addedByUser": "josh"
}
```

### Primary files to update

- [src/routes/torrent.routes.js](../src/routes/torrent.routes.js)
  - accept and preserve logical media target information
- [src/services/TorrentService.js](../src/services/TorrentService.js)
  - keep tags as durable context but treat them as transport metadata, not identity
- [src/services/workers/PipelineWorker.js](../src/services/workers/PipelineWorker.js)
  - reconcile queue state by logical target
- [src/services/PipelineQueueService.js](../src/services/PipelineQueueService.js)
  - persist logical queue state cleanly

### Why this phase matters

This is what enables retry orchestration, alternate providers, and operator intervention without losing the actual target media identity.

### Success criteria

- A failed torrent can be replaced without changing the logical queue target.
- The UI can show requested media by IMDb target rather than by raw torrent name.
- Queue recovery after restart preserves logical target identity.

## Phase 7: Handle Irregular Episode Numbering

### Goal

Support shows that do not fit strict `SxxExx` numbering without breaking the normal season/episode flow.

### Changes

- Introduce explicit episode numbering schemes.
- Store canonical `episodeKey` independent of filename.
- Support alternate keys such as absolute number, airdate, run number, or provider alias.

### Suggested fields

```json
{
  "seriesImdbId": "tt1234567",
  "episodeKey": "absolute-014",
  "numberingScheme": "absolute",
  "seasonNumber": null,
  "episodeNumber": null,
  "absoluteNumber": 14
}
```

### Primary files to update

- [src/services/workers/IngestSanitizerWorker.js](../src/services/workers/IngestSanitizerWorker.js)
  - stop assuming every episode target can only be represented as `SxxExx`
- [src/routes/media.routes.js](../src/routes/media.routes.js)
  - expose richer episode identity to playback and browse
- [src/services/SeriesIndexService.js](../src/services/SeriesIndexService.js)
  - persist richer episode identity in manifests

### Why this phase matters

If this is not designed explicitly, anime and irregular TV formats will keep forcing exceptions into folder names and ingest heuristics.

### Success criteria

- Standard series still work with `SxxExx`.
- Irregular numbering can be represented without hacks.
- Episode identity no longer depends on filename parsing alone.

## Phase 8: Lazy Legacy Migration and Optional Background Normalization

### Goal

Migrate old title-based folders safely over time without requiring a disruptive bulk move.

### Changes

- Keep resolvers aware of both old and new layouts.
- Migrate old folders lazily when content is touched, repaired, or reprocessed.
- Optionally add an admin background migrator for batches.

### Primary files to update

- [src/routes/admin.routes.js](../src/routes/admin.routes.js)
  - add explicit migration tools and dry-run reporting
- [src/services/SeriesFolderResolver.js](../src/services/SeriesFolderResolver.js)
  - preserve alias lookups during transition
- [src/services/StoragePathResolver.js](../src/services/StoragePathResolver.js)
  - resolve old and new paths safely

### Why this phase matters

This avoids a high-risk one-shot rename across the library while still getting the system to the new model over time.

### Success criteria

- Old and new layouts coexist safely.
- Migration can happen incrementally.
- Playback, scans, and user library references remain intact during transition.

## Phase 9: Tighten Validation and Remove Title-Based Identity Paths

### Goal

Once enough content has been normalized, remove unsafe fallback behavior that could reintroduce ambiguity.

### Changes

- Eliminate title-only identity matching from browse, attach, and ingest.
- Require IMDb identity for new movie acquisitions.
- Reduce folder-name-derived behavior to compatibility-only code paths.

### Primary files to update

- [src/routes/media.routes.js](../src/routes/media.routes.js)
- [src/routes/torrent.routes.js](../src/routes/torrent.routes.js)
- [src/services/workers/IngestSanitizerWorker.js](../src/services/workers/IngestSanitizerWorker.js)
- [src/services/LibraryScanner.js](../src/services/LibraryScanner.js)

### Why this phase matters

This is the point where the system fully stops relying on ambiguous title logic.

### Success criteria

- No production flow depends on title-only identity.
- All new media requests are canonicalized before acquisition.
- Folder names are no longer treated as source truth.

## Recommended Order of Execution

Execute the phases in this order:

1. Phase 0: Freeze the contract.
2. Phase 1: Enforce registry-only writes.
3. Phase 2: Canonicalize `imdbId` everywhere.
4. Phase 3: Introduce logical asset identity.
5. Phase 4: Add read-optimized indexes.
6. Phase 5: Switch new ingests to IMDb folders.
7. Phase 6: Make queue and acquisition logical.
8. Phase 7: Add irregular episode support.
9. Phase 8: Migrate legacy folders lazily.
10. Phase 9: Remove remaining title-based identity paths.

## What Not To Do

Avoid these shortcuts:

- Do not rename all existing folders first.
- Do not make IMDb folder naming mandatory before resolvers exist.
- Do not keep direct metadata disk writes once registry discipline begins.
- Do not let queue recovery depend solely on torrent names.
- Do not assume all series can be modeled forever as only `SxxExx`.

## Practical First Implementation Slice

If the work should begin with the smallest safe slice, start here:

1. Route every canonical metadata write through `MetadataRegistry`.
2. Canonicalize `imdbId` on all writes.
3. Add any missing movie and series IMDb metadata through repair tooling.
4. Add a config flag for IMDb-based folders on new ingests only.
5. Keep old path resolvers intact while that flag rolls out.

That gives a safe first milestone without forcing a library-wide rename.
