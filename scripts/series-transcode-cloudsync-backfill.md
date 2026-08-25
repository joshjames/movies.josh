Same idea as movies-registration-backfill.js but for TV series episodes: finds episodes that are missing a web-profile transcode or missing from cloud sync, and re-runs those steps.

WHAT IT DOES
Walks the series directory season-by-season, checks each episode's storage profile status, and calls the transcode/cloudsync workers for anything incomplete. Correctly distinguishes "already fully transcoded, raw source cleaned up" from a genuine transcode failure by checking for existing web-profile output files before declaring an episode failed - an earlier bug used to flag already-done episodes as failures and skip their cloud sync as a result.

USAGE
  node scripts/series-transcode-cloudsync-backfill.js [--dry-run] [--show <folderName>]

  --dry-run          Report only, no changes.
  --show <folder>    Limit to one series folder instead of the whole library.

NOTES
- Useful after fixing a series' episode metadata/numbering (e.g. a non-standard naming scheme) to push the corrected episodes through transcode+cloudsync in one pass.
- Exits cleanly on completion; calls workers over HTTP with a bounded timeout rather than hanging.
