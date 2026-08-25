Downloads the raw IMDb dataset TSV dumps that the various IMDb catalog-building scripts depend on.

WHAT IT DOES
Downloads title.basics.tsv.gz, title.ratings.tsv.gz, title.episode.tsv.gz, title.akas.tsv.gz, and name.basics.tsv.gz from IMDb's public dataset mirror (https://datasets.imdbws.com by default, overridable via IMDB_DATA_SOURCE_URL or a per-file IMDB_DATA_FILE_URL_<FILENAME> override) into .data/. For each file, unless --force is given, it first does a HEAD request to compare the remote Last-Modified header against the local file's mtime and skips re-downloading if the local copy is already at least as new. Downloads stream to a .tmp file and are renamed into place on success, so a failed/partial download never clobbers a good existing file.

USAGE
  node scripts/update-imdb-data.js [file1 file2 ...] [--force | -f]

  [file names]   Optional list of specific files to download (must be one of: title.basics.tsv.gz, title.ratings.tsv.gz, title.episode.tsv.gz, title.akas.tsv.gz, name.basics.tsv.gz). Unknown names are skipped with a warning. If omitted, all five default files are downloaded.
  --force, -f    Re-download every selected file even if the local copy looks up to date.

NOTES
- Makes live HTTP requests to IMDb's dataset host (or an override URL) - no API key required, but subject to whatever rate limiting/availability IMDb's dataset server has.
- Safe to re-run - by default it's a no-op for any file whose local copy is already current, and downloads always land atomically (via temp file + rename) so a failure never leaves a corrupt file in .data/.
- These files can be large (title.basics/title.akas in particular), so a full download can take a while and use a meaningful amount of disk/bandwidth; run this before build-imdb-catalogs.js / build-tv-show-index.js, which read these files and will error out if they're missing.
