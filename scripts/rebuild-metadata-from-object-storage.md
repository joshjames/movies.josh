Disaster-recovery reconciliation: patches local metadata.json/series.json files to match what's actually already sitting in the B2 cloud storage bucket, when the local manifests have fallen behind (e.g. after a server outage cut off the sync process mid-backfill).

WHAT IT DOES
Lists every object in the B2 bucket (CLOUD_BUCKET_NAME, default joshflixmedia) and parses movie/series/season/episode/profile identifiers out of the object keys. It then walks the local movies and series storage roots, and for every folder whose metadata already shows a directoryId (IMDb id, or folder name if no IMDb id) present in the bucket, checks whether each resolution profile (1080p/720p/480p) the bucket actually has is already reflected in the local metadata.json (or series.json episode entry) as `status: 'synced'` with the matching `remoteKey`.

Where the bucket has a file the local manifest doesn't know about, it patches in `storage.files[profile] = {status:'synced', remoteKey}` using the same shape CloudSyncWorker.js writes (via MetadataRegistry.mergeAndCommit), so normal playback resolution picks it up with no other code changes needed. It never removes or downgrades existing entries - only fills in gaps. At the end it prints a summary (movies/episodes patched vs. already up to date) plus an "orphan" warning listing any bucket directoryIds that didn't match a local folder at all (renamed/deleted folder locally).

USAGE
  node scripts/rebuild-metadata-from-object-storage.js --dry-run
  node scripts/rebuild-metadata-from-object-storage.js --execute
  node scripts/rebuild-metadata-from-object-storage.js --execute --only "Dark.2017,From"

  --dry-run       Default behavior (also true if neither flag is given). Reports what would be patched without writing anything.
  --execute       Actually writes the patched metadata.json/series.json files.
  --only <list>   Comma-separated list of folder names to restrict processing to (both movies and series folders are matched against the same list).

NOTES
- Must run inside a container with the /app/storage/movies and /app/storage/series mounts and a working Redis connection (MetadataRegistry needs Redis to commit changes), e.g. `docker exec movie-streamer-v2-snode node scripts/rebuild-metadata-from-object-storage.js`.
- Requires B2/S3 credentials: BBkeyID and BBapplicationKey (Backblaze B2 application key), plus optionally CLOUD_ENDPOINT/CLOUD_REGION/CLOUD_BUCKET_NAME to override the defaults (Backblaze us-west-004, bucket joshflixmedia).
- Safe to re-run any number of times - it's idempotent, only adding metadata for bucket content not yet reflected locally; already-synced entries are left untouched and reported as "up to date".
- This is a narrow disaster-recovery tool for one specific failure mode (local manifests behind reality after an interrupted rsync/backfill) - always run with --dry-run first and review the orphan report before using --execute, since an orphan entry may indicate a folder was legitimately renamed/removed and shouldn't be blindly reconciled.
