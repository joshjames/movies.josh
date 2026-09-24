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
# Needs a logged-in session cookie the first time (the whole app sits behind
# requireAuth). Grab yours from the browser (DevTools -> Application ->
# Cookies -> copy the session cookie's value) and export it once:
#   export MOVIE_STREAMER_COOKIE="connect.sid=s%3A...."
# then this script reuses it on every call.

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
