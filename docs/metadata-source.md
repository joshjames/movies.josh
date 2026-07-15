Optimized tool selectionThat constraint changes the design in a useful way. I would not model this as “database logic without a database.” I’d model it as “immutable metadata objects plus compiled indexes.”

**What To Optimize For**
1. Canonical truth lives in files, not rows.
2. Runtime reads precompiled indexes into memory once.
3. User requests never scan folders or recompute identity.
4. Mutations are rare, append-only where possible, and reconciled asynchronously.
5. Media identity is stable even if file placement changes.

**Best Fit For Your Model**
1. Canonical object per movie:
`movies/tt0118884/metadata.json`
2. Canonical object per series:
`series/tt1234567/metadata.json`
3. Canonical object per episode:
`series/tt1234567/episodes/s01e02.json`
or for irregular numbering:
`series/tt1234567/episodes/ep-absolute-014.json`
4. Canonical asset manifest:
`movies/tt0118884/assets.json`
`series/tt1234567/assets.json`

Those are your source-of-truth files.

Then generate read-optimized indexes:
1. `indexes/movies-by-imdb.json`
2. `indexes/movies-by-title-year.json`
3. `indexes/series-by-imdb.json`
4. `indexes/episodes-by-series.json`
5. `indexes/library-summary.json`
6. `indexes/user-collections/<user>.json` only if needed

Load those into memory on boot. That gives you database-like lookup speed with static-file deployment.

**Important Distinction**
Do not use folder structure itself as truth.
Use folder structure as storage layout only.

That means:
1. IMDb ID is canonical identity.
2. Title is presentation metadata.
3. File path is current storage location.
4. Queue/acquisition intent targets identity, not file.

That is the decoupling you want.

**How To Keep It Databaseless But Fast**
1. Writes update one canonical metadata file.
2. A background compiler updates affected indexes only.
3. Frontend/API serves from in-memory indexes.
4. Node watches version/hash of index bundle and hot-reloads.
5. CDN/object storage serves heavy media and static metadata snapshots.

So the hot path is:
1. request
2. memory lookup
3. response

No disk crawl, no metadata joins, no live derivation.

**Recommended File Model**
For a movie:
```json
{
  "imdbId": "tt0097029",
  "type": "movie",
  "title": "Catch Me If You Can",
  "year": 1989,
  "aliases": [],
  "libraryState": "ready",
  "preferredAssetId": "asset_main",
  "assets": [
    {
      "assetId": "asset_main",
      "storage": "local",
      "root": "movies-a",
      "relativePath": "tt0097029/video.mp4",
      "quality": "1080p",
      "container": "mp4",
      "status": "ready"
    }
  ]
}
```

For a series episode:
```json
{
  "seriesImdbId": "tt1234567",
  "episodeKey": "s01e02",
  "scheme": "season_episode",
  "seasonNumber": 1,
  "episodeNumber": 2,
  "title": "Episode Title",
  "libraryState": "missing",
  "preferredAssetId": null,
  "assets": []
}
```

**Why This Scales**
1. Metadata files are small and cacheable.
2. Indexes can be compressed and memory-mapped or loaded once.
3. Multi-node deployment is simple because nodes only need the same index snapshot.
4. Object storage replication is easy because files are immutable or versioned.
5. Rebuild cost is moved off the request path.

**Mutation Strategy**
You still need safe writes, but not a database.

Use:
1. atomic write temp file then rename
2. append-only event log for recovery
3. index compiler job
4. versioned metadata snapshots

Example:
1. write `events/2026-07-14T...-tt0097029-add-asset.json`
2. updater applies to canonical metadata
3. compiler refreshes affected indexes
4. nodes reload changed index files

That gives you crash recovery without a DB.

**Queue Design In This World**
Queue should also be file/event based conceptually:
1. acquisition intent file
2. attempt files
3. resolved asset file
4. pipeline state file

Not:
1. “download this torrent name”
But:
1. “acquire movie tt0097029”
2. “acquire episode tt1234567 s01e02”

Then provider retries, manual replacement, and alternate sources become natural.

**For Irregular TV Numbering**
Do not force everything into `SxxExx` as truth.

Use:
1. canonical `episodeKey`
2. numbering `scheme`
3. optional mappings:
   - season/episode
   - absolute number
   - airdate
   - provider-specific alias

Then filename can still be normalized, but logic is not trapped by filename style.

**Practical Architecture**
1. Canonical metadata files in local volume or object-backed sync.
2. Compiled index bundle generated on change.
3. Nodes load bundle into memory on boot and refresh on version bump.
4. Media assets live on object/local/cloud roots referenced by relative paths.
5. CDN serves covers, metadata bundles, and streamable assets.

**What I’d Avoid**
1. Per-request folder scans.
2. Title-based identity.
3. Using filenames as canonical state.
4. Live inference during playback/search if it can be precompiled.
5. Cross-node mutable in-memory-only truth.

**Most Efficient Migration Path**
1. Introduce IMDb-based canonical metadata first.
2. Keep legacy folders as storage aliases.
3. Add compiled indexes keyed by IMDb.
4. Switch queue/acquisition to logical targets.
5. Only then change new ingest folder layout to IMDb-based paths.
6. Migrate old storage lazily.

That order gives you the decoupling before the physical move, which is safer.

**Short Version**
Yes, you can stay databaseless and still get strong identity and scalability, but only if you treat:
1. canonical metadata files as truth
2. compiled indexes as your “read database”
3. event files as your “write log”
4. storage paths as replaceable asset locations

That is the shape I’d design around.

If you want, I can next turn this into a concrete file-layout and index-layout spec tailored to your current movie/series pipeline.