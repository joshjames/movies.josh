Adds a genre/category tag to a list of movies in bulk, without touching anything else in their metadata.

WHAT IT DOES
Reads a text file of folder names (one per line), and for each one prepends the given tag to that movie's existing `genre` field in metadata.json (via MetadataRegistry, so it also updates Redis where applicable). Folders with no metadata.json are skipped and reported. Genres double as the site's home-page "category" rows, so tagging a batch this way is how you create/grow a category (e.g. tagging a batch of anime movies "Anime" makes an Anime row appear on the home page).

USAGE
  node scripts/bulk-tag-movies.js --list <path-to-file> --tag <GenreName> [--dry-run]

  --list <file>   Text file, one folder name per line.
  --tag <name>    Genre/tag to prepend, e.g. "Anime".
  --dry-run       Show what would change without writing anything.

NOTES
- Matching is by exact folder name, so make sure the list reflects current folder names (IngestSanitizerWorker can rename folders during normal operation, which will make stale lists miss titles - if something in the list doesn't get tagged, check whether its folder was renamed since the list was made).
