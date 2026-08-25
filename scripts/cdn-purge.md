Purges cached objects from the Cloudflare CDN edge for the image zone.

WHAT IT DOES
Loads a Cloudflare API token from a local credential file (cftoken.env by default, or CDN_CRED_FILE), resolves the zone id for the configured zone (any.movie by default, or CDN_IMAGES_ZONE), and issues a Cloudflare `purge_cache` API call. Depending on the flags given it purges specific URLs (built from CDN_IMAGES_BASE_URL + the given keys, batched at 30 per Cloudflare API call), a URL prefix (Cloudflare Enterprise-only feature - fails gracefully with a message if the plan doesn't support it), or the entire zone.

The script's own header comment notes this normally shouldn't be needed: covers are served with immutable Cache-Control and the app appends a `?v=<mtime>` token to every URL, so replacing a file and re-syncing naturally produces a new URL that misses cache. This script exists for the exception cases - a bad object cached under a URL that won't change, or a replaced file whose mtime didn't move.

USAGE
  node scripts/cdn-purge.js --key <object-key> [--key <object-key> ...]
  node scripts/cdn-purge.js --prefix <prefix/> [--prefix <prefix/> ...]
  node scripts/cdn-purge.js --all

  --key <key>      Purge one specific object key (repeatable). Built into a full URL using CDN_IMAGES_BASE_URL.
  --prefix <path>  Purge every cached object under a prefix (repeatable). Requires a Cloudflare Enterprise plan - fails with a clear error otherwise.
  --all            Purge everything cached on the entire zone, not just images.
  -h, --help       Print usage and exit.

NOTES
- Requires a Cloudflare API token available via cftoken.env (or CDN_CRED_FILE) containing one of ACCOUNT_API_KEY / ACCOUNT_API_TOKEN / CF_API_TOKEN / AUTH_TOKEN.
- ⚠️ WARNING: this performs a live Cloudflare cache purge that takes effect immediately on real production traffic. --all purges the ENTIRE zone's cache (not just images - every hostname on that zone), which can cause a sudden spike in origin load as caches refill. There is no "undo" for a purge; the only recovery is letting caches repopulate naturally (or from an unaffected mirror/origin). Prefer --key with specific object keys over --prefix or --all whenever possible.
- --prefix silently requires an Enterprise Cloudflare plan; on a lower plan it will report failure and exit with a non-zero code without purging anything.
