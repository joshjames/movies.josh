Builds curated TV and movie catalog files by querying the live TMDb API, cross-referenced against the local IMDb-derived TV index.

WHAT IT DOES
Calls several TMDb endpoints (trending, discover-by-genre, on-the-air, etc.) for both TV and movies, paginating each until it has enough raw results. For every result it looks up TMDb's `external_ids` endpoint to resolve the matching IMDb id (bounded concurrency of 6 in-flight requests), then for TV rows merges in richer fields (title, genres, episode count, vote counts) from the local metadata/tv-show-index.json built by build-imdb-catalogs.js/build-tv-show-index.js when a matching IMDb id is found there. If a genre-specific TMDb query doesn't return enough matched results, it backfills the remainder from the local IMDb TV index directly.

Writes one JSON file per catalog spec into metadata/: TV catalogs are catalog_tv_trending_50.json, catalog_tv_popular_50.json, catalog_tv_currently_airing_30.json, catalog_tv_comedy_50.json, catalog_tv_drama_50.json, catalog_tv_family_50.json; movie catalogs are catalog_movie_trending_50.json, catalog_movie_popular_50.json, catalog_movie_new_50.json (new = released in roughly the last year).

USAGE
  node scripts/build-tmdb-catalogs.js

  Takes no arguments.

NOTES
- Requires TMDb credentials: THEMOVIEDB_API_KEY or THEMOVIEDB_API_READ_ACCESS_TOKEN (or the legacy TMDB_API_KEY / TMDB_READ_ACCESS_TOKEN names) in the environment. The script exits immediately with an error if neither is set.
- Makes a real number of live TMDb API calls (multiple list pages per catalog spec, plus one external_ids call per candidate row) - subject to TMDb's rate limits; a run touches roughly a dozen list endpoints and potentially several hundred external_ids lookups.
- Benefits from metadata/tv-show-index.json already existing locally (built by build-imdb-catalogs.js or build-tv-show-index.js) for richer TV merges, but will still run without it - it just falls back to TMDb-only fields for TV rows with no local match.
- Safe to re-run - every run fully overwrites its output catalog files from scratch.
