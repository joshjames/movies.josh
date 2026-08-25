Builds a simpler, standalone version of the IMDb TV show index (top 2000 by popularity) purely from local IMDb dataset files.

WHAT IT DOES
Streams the gzipped IMDb TSVs in .data/ (title.basics.tsv.gz and title.ratings.tsv.gz required, title.episode.tsv.gz optional) and keeps a running top-2000 min-heap of tvSeries titles ranked by vote count then rating - no minimum vote threshold and no "recent show" carve-out (unlike build-imdb-catalogs.js's TV builder, which does both of those things and supports a much larger, env-configurable limit). For each kept title it records genres (top 3 only), rating, vote count, episode count, and a normalized search-text blob.

Writes metadata/tv-show-index.json (with an updatedAt timestamp, source file references and totals) and metadata/tv-show-index.csv, overwriting whatever was there before.

USAGE
  node scripts/build-tv-show-index.js

  Takes no arguments.

NOTES
- Requires .data/title.basics.tsv.gz and .data/title.ratings.tsv.gz to exist (run update-imdb-data.js first if missing). title.episode.tsv.gz is optional but improves episode counts.
- Purely local/offline - no network calls, only reads .data/*.tsv.gz and writes metadata/tv-show-index.json + .csv.
- Overlaps in purpose with build-imdb-catalogs.js's TV index builder (which writes the same output files but with a larger configurable limit, a lower vote floor, alias/AKA data, and a "recent shows" allowance) - this script is the older/simpler variant; check which one is intended to be the source of truth for metadata/tv-show-index.json before running both, since whichever runs last wins.
- Safe to re-run - fully overwrites its output files each run.
