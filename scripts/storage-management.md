Reports free disk space across every volume this app uses, plus the size of regenerable cache/staging directories, and can clear those on request.

WHAT IT DOES
Runs `df -h` against each mounted volume (movies library, series library, app metadata, audio remux cache, archive) so you can see real host free space per disk without SSHing in. Also walks the audio remux cache, the archive/to-be-deleted folder, and the script-run log folder to report their actual sizes. With the right flag, it can delete the audio cache contents (safe - it's fully regenerable, rebuilt automatically whenever a user plays a non-default audio track) or prune old script-run log files.

It also prints a note about Docker's own disk usage (images, build cache) - this script cannot see or touch that, because it runs inside the app container, which has no access to the Docker daemon (no docker.sock mounted). It just tells you the equivalent `docker system df` / `docker system prune` commands to run directly on the host.

USAGE
  node scripts/storage-management.js                                Report only, no changes.
  node scripts/storage-management.js --clear-audio-cache [--dry-run]
  node scripts/storage-management.js --clear-script-logs [--days N] [--dry-run]

  --clear-audio-cache   Delete everything in the audio remux cache.
  --clear-script-logs   Delete script-run log files older than --days (default 14).
  --days N              Age threshold in days for --clear-script-logs.
  --dry-run             Show what would be removed/freed without deleting anything.

NOTES
- Report mode (no flags) is always safe to run.
- Clearing the audio cache just means the next playback of a non-default audio track re-remuxes it on the fly (a few seconds' delay the first time) - no data loss.
- The archive/to-be-deleted folder is a manual staging area, not an automatic cache - review its contents yourself before deleting anything from it; this script only reports its size, it never clears it automatically.
- Does NOT touch Docker image/build-cache disk usage (see above) or delete any movie/series media files - deleting local media that's already safely in cloud storage is a separate, more sensitive feature that's deliberately not part of this script yet.
