Re-scans the entire library on disk and rebuilds the site's live TV series index from what it finds.

WHAT IT DOES
Runs the same full library scan sweep (`LibraryScanner.runLibraryScanSweep`) the app performs automatically, walking every configured movie and series storage root, then syncs the resulting inventory into Redis and the on-disk library cache. As part of that sweep it also rebuilds the app's TV series index (`data/tv-series-index.json`, via `TvSeriesIndexService`) - this is the index the site's own "My Shows" / TV browsing UI reads, not the IMDb-dataset-derived `metadata/tv-show-index.json` that the build-imdb/build-tv-show-index scripts produce.

After the scan, it loads the freshly rebuilt index and prints a summary: total items, how many have an IMDb id attached versus how many are missing one, and (up to 50) the folder names that are still missing an IMDb id so an admin can go fix their metadata.

USAGE
  node scripts/backfill-tv-index.js

  Takes no arguments.

NOTES
- Must run inside a container with access to the movie/series storage mounts and a working Redis connection (the scan writes to Redis as well as disk), e.g. the same worker container used for the other backfill scripts.
- Safe to re-run - it's a full non-destructive rescan; it does not remove existing index entries, it only rebuilds the index from what's currently on disk.
- Can take a while on a large library since it walks every movie and series folder; it is a full sweep, not an incremental scan.
