Builds the rotating cover-image bundle shown on the logged-out welcome/landing page.

WHAT IT DOES
Picks a random sample of existing local cover images from public/images/catalog-covers (up to 8) and metadata/tv-covers (up to 8), copying the chosen files into public/images/welcome-covers/ under new prefixed names (catalog-01.jpg, tv-01.jpg, etc). It then tries to fetch TMDb's "trending all/week" list (up to 12 items, needs TMDb credentials) and downloads each result's backdrop/poster image into the same welcome-covers folder; any individual TMDb download failure is swallowed so the rest of the bundle still completes, and if TMDb credentials are missing entirely this step is skipped (yields zero TMDb assets, not an error).

Combines the local and TMDb assets, shuffles them, takes the first 20, and writes them as a small JS payload (`window.__WELCOME_ASSETS__ = {...}`) to public/data/welcome-assets.js, which the welcome page includes directly.

USAGE
  node scripts/build-welcome-assets.js

  Takes no arguments.

NOTES
- Optional TMDb credentials (THEMOVIEDB_API_KEY or THEMOVIEDB_API_READ_ACCESS_TOKEN) enable the trending-image portion; without them the script still runs fine using only local covers.
- Writes/copies files into public/images/welcome-covers/ and overwrites public/data/welcome-assets.js each run - safe to re-run, output is fully regenerated (though the specific random selection will differ each time since selection is shuffled).
- Makes a modest number of live HTTP calls to TMDb (one list call plus up to 12 image downloads) if credentials are present; no writes to any external service.
