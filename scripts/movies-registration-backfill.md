Runs new/unregistered movie folders through the full ingest pipeline: metadata lookup, transcode, and cloud sync - the same pipeline that normally runs automatically when a folder is dropped into the library, but re-triggerable on demand for a batch of folders.

WHAT IT DOES
Walks the movies directory, skips anything already fully registered + transcoded + cloud-synced, and for everything else calls the metadata/transcode/cloudsync workers in turn. Checks each title's actual storage profile status (not just presence of metadata.json) before deciding it "needsTranscode", so it won't re-transcode something that's already synced.

USAGE
  node scripts/movies-registration-backfill.js [--dry-run] [--skip-cover-only]

  --dry-run           Report what would be processed, make no changes.
  --skip-cover-only   Skip titles that only need a cover image refresh (used
                       during the anime bulk-import so partial imports weren't
                       repeatedly re-flagged for cover-only work).

NOTES
- Used for bulk imports (e.g. dropping ~200 new folders into the library at once) rather than one-off additions, which the normal watcher pipeline already handles.
- Real failures usually mean the METADATA step couldn't find a match (bad/missing metadata.json, ambiguous or misspelled title) - check its output for which folders failed and why before re-running.
- Exits cleanly on completion (process.exit) - safe to leave running unattended for a large batch.
