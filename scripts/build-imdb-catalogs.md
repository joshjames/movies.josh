Builds the IMDb-dataset-derived TV index and the site's movie catalogs (top lists, decade buckets, etc.) entirely from local IMDb dataset files - no network calls.

WHAT IT DOES
Streams the gzipped IMDb TSV dumps in .data/ (title.basics, title.ratings, title.episode, title.akas) that update-imdb-data.js downloads, and builds two things:

TV: selects up to TV_SHOW_INDEX_LIMIT (env-configurable, default 12000) tvSeries titles ranked by vote count/rating (min 1000 votes to qualify for the ranked pool), plus any recent show (within the last 3 years) with at least 5 votes so new shows aren't excluded just for being low-volume yet. Attaches episode counts and up to 10 AKAs/aliases per title, then writes metadata/tv-show-index.json and metadata/tv-show-index.csv.

Movies: similarly selects up to MOVIE_INDEX_LIMIT (default 20000) movie titles by the same popularity ranking, then derives and writes several catalog files into metadata/: movie-index.json (the full selected set), catalog_master_popular_2000(.json/_trimmed.json), catalog_top_100_all_time(_trimmed) (rating >= 8.2... actually votes >= 50000, sorted by rating), catalog_critics_choices(_trimmed) (rating >= 8.2 and votes >= 15000), and one catalog_popular_<decade>s(.json/_trimmed.json) file per decade found in the top-2000 popular set.

USAGE
  node scripts/build-imdb-catalogs.js [--skip-tv] [--skip-movies]

  --skip-tv       Skip building the IMDb TV show index.
  --skip-movies   Skip building the IMDb movie catalogs/index.

NOTES
- Requires the IMDb dataset files to already exist in .data/ (title.basics.tsv.gz and title.ratings.tsv.gz are mandatory; title.episode.tsv.gz and title.akas.tsv.gz are optional but improve output) - run update-imdb-data.js first if they're missing or stale.
- Purely local/offline: reads .data/*.tsv.gz and writes to metadata/*.json and *.csv. No external API calls, no side effects outside this repo's files.
- Safe to re-run - every run fully overwrites its output files from scratch; nothing is appended or merged with prior output.
- Can be slow/memory-heavy on the first run since it streams and holds large TSV files (title.basics can be several million rows) in memory via a min-heap while scanning; expect it to take some time on modest hardware.
