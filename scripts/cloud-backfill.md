Backfills B2 cloud sync for movies that are already transcoded locally but never got pushed to cloud storage (or fell behind after a failure).

WHAT IT DOES
Scans the movie library, finds titles whose local web-profile files (1080p etc.) exist but whose metadata.json shows they were never synced (or sync stalled), and re-runs the CloudSync step for each via the running cloudsync-worker.

USAGE
  node scripts/cloud-backfill.js [--dry-run]

  --dry-run   List what would be synced without actually calling the worker.

NOTES
- Must run inside a container with access to the movies volume and the cloudsync-worker service (e.g. exec into cloudsync-worker itself).
- Safe to re-run - it only acts on titles it still finds unsynced, already-synced titles are skipped.
- Can take a long time for a large backlog; runs to completion and exits (process.exit) rather than hanging, and calls the worker over HTTP with a bounded timeout - both fixed after early versions of this script used to hang indefinitely.
