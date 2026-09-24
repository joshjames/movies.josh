#!/usr/bin/env bash
# Quick local title+year -> imdbId lookup, for manual admin work.
# Hits GET /api/imdb-lookup, which resolves purely against the local IMDb
# catalog data (MovieTitleIndexService/TvSeriesIndexService) - no external
# OMDb/TMDb call.
#
# Usage:
#   ./scripts/imdb-lookup.sh "Fleabag" 2016
#   ./scripts/imdb-lookup.sh "Fleabag" 2016 series
#   ./scripts/imdb-lookup.sh "The Matrix" 1999 movie
#
# Needs a logged-in cookie the first time (the whole app sits behind
# requireAuth). This app's auth is just one plain cookie - no session ID -
# named "user_profile", holding your username/email exactly as DevTools ->
# Application -> Cookies shows it (already percent-encoded, e.g.
# josh%40joshjames.site for josh@joshjames.site). Copy that value and export
# the whole cookie once:
#   export MOVIE_STREAMER_COOKIE="user_profile=josh%40joshjames.site"
# then this script reuses it on every call. It doesn't expire quickly (see
# the Expires column in DevTools), so you shouldn't need to redo this often.

set -euo pipefail

BASE_URL="${MOVIE_STREAMER_BASE_URL:-https://la.any.movie}"
TITLE="${1:?Usage: imdb-lookup.sh <title> [year] [movie|series]}"
YEAR="${2:-}"
TYPE="${3:-}"

if [[ -z "${MOVIE_STREAMER_COOKIE:-}" ]]; then
    echo "MOVIE_STREAMER_COOKIE is not set - export your session cookie first (see script header)." >&2
    exit 1
fi

QUERY="title=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$TITLE")"
[[ -n "$YEAR" ]] && QUERY="${QUERY}&year=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$YEAR")"
[[ -n "$TYPE" ]] && QUERY="${QUERY}&type=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$TYPE")"

curl -sS -H "Cookie: ${MOVIE_STREAMER_COOKIE}" "${BASE_URL}/api/imdb-lookup?${QUERY}" | python3 -m json.tool
