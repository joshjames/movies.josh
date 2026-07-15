Your direction makes sense. The clean way is to make IMDb identity the primary key, and treat filenames/paths as replaceable implementation details.

**North Star**
1. Movie identity = imdb_id only.
2. Series identity = imdb_id only.
3. Episode identity = series_imdb_id + episode_key.
4. Files are just versions of an asset, not the asset itself.

**Data Model To Decouple Truth From Files**
1. Title table:
imdb_id, type movie/series, canonical_title, year, status.
2. Episode table:
series_imdb_id, episode_key, season_number nullable, episode_number nullable, absolute_number nullable, air_date nullable, title.
3. Asset table:
asset_id, logical_key, preferred_file_id, state missing/acquired/processing/ready/failed.
4. File table:
file_id, asset_id, storage_provider local/cloud, root_id, relative_path, codec/container/resolution, checksum, source, created_at.
5. Acquisition intent table:
intent_id, target imdb_id and optional episode_key, priority, requester, status, retry_count, last_error.
6. Attempt table:
attempt_id, intent_id, provider, query_used, result_count, selected_release, failure_reason.

This gives you the redundancy loop you want: intent remains stable while files/attempts can change repeatedly.

**Folder Strategy (From Now On)**
1. Movies:
movies/tt1234567/
2. Series:
series/tt1234567/
3. Episodes:
series/tt1234567/season-01/tt1234567.s01e02.<variant>.mp4
4. Non-seasoned or anime styles:
store a scheme field, then map display numbering separately.
5. Keep metadata file per title and per episode for fast scans, but DB/index is source of truth.

You can still keep human-friendly names in metadata/UI without using them in paths.

**Backward Compatibility Without Big Bang Migration**
1. Phase 1:
write new ingests to imdb folders only.
2. Phase 2:
add resolver that maps old folders to imdb_id using existing metadata and indexes.
3. Phase 3:
lazy migration on touch.
When an old item is processed again, move/copy into imdb folder and register aliases.
4. Phase 4:
background migrator for untouched legacy items.
5. Phase 5:
deprecate title-based matching.

This is most efficient because it avoids downtime and avoids moving everything immediately.

**Queue/Pipeline Redesign For Resilience**
1. Queue should track logical targets, not torrent names.
2. Job payload should be:
type movie/episode, imdb_id, episode_key if needed, quality profile, requester.
3. Downloader result should be attached as an attempt artifact.
4. Ingest step should validate against logical target:
movie must resolve to imdb_id, episode must resolve to episode_key.
5. On failure:
keep intent open, mark attempt failed, auto-try next provider/profile.
6. Manual override:
operator can attach a replacement file to same intent without changing logical identity.

That directly supports your “any source is fine if identity matches” goal.

**Episode Identity For Irregular Shows**
1. Support multiple numbering schemes per series:
season_episode, absolute, airdate, custom.
2. Store canonical episode_key internally.
3. Map provider-specific numbering to canonical with a mapping table.
4. If uncertain, keep unresolved episode candidates and allow manual bind once, then persist mapping.

**Search/Add UX Shift**
1. User adds title by imdb_id-backed result.
2. System creates acquisition intent, not immediate file operation.
3. UI shows logical status:
requested, searching, downloading, validating, ready, failed-needs-review.
4. Hide raw link complexity unless user opens advanced details.

This scales better with more users and failures.

**Practical Rollout Order**
1. Introduce logical IDs and resolver layer first.
2. Switch new ingests to imdb folder naming.
3. Refactor queue payload to logical intent shape.
4. Add attempt history and retry orchestration.
5. Add lazy legacy migration.
6. Add provider redundancy strategy.

If you want, next I can draft a concrete schema + endpoint contract proposal for this migration in a single implementation blueprint.