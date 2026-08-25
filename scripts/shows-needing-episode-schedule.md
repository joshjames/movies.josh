Reports which "My Shows" subscriptions likely have new episodes that aren't in the library yet, so an admin can go set up a download for them.

WHAT IT DOES
Reads every user's subscriptions.json, dedupes by IMDb id (one show with many subscribers is only reported once), and for each show compares the local series.json against a fresh live metadata lookup. Flags a show if the provider now reports more total seasons than we have, or more episodes in the season we're already tracking than we have locally. Prints three sections: shows that need a download scheduled (with the reason), shows that are up to date, and shows with no local series.json at all (usually a sign the subscription record's folderName is wrong or stale).

USAGE
  node scripts/shows-needing-episode-schedule.js

  Takes no arguments.

NOTES
- Must run inside a container with access to ProfileService/SeriesSubscriptionService/MetadataProvider and the series storage mount, e.g.:
    docker exec movie-streamer-cloudsync-worker node scripts/shows-needing-episode-schedule.js
- Read-only / reporting only - it does not create any downloads itself. Acting on the results (adding a download schedule) is still done manually via the admin scheduler tool. This script exists because there's no automatic "add a schedule when a user subscribes to an airing show" mechanism yet - it's a stand-in until enough real cases are seen to design that automation properly.
- If a show shows up under "no local series.json found," check that its subscription record's folderName actually matches a real series folder - a few records have been found with a stale/wrong folderName in the past.
