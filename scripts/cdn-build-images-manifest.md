Converts a flat list of R2/S3 object keys into the JSON manifest that CdnAssetService uses to decide whether an image can be served from the CDN edge instead of the origin.

WHAT IT DOES
Reads a newline-delimited list of object keys from a file (normally produced upstream by `rclone lsf -R --files-only` against the images bucket, via scripts/cdn-sync-images.sh), strips blank lines and any housekeeping keys that start with `_` or `.`, sorts the remaining keys, and tallies how many keys fall under each top-level prefix (e.g. catalog-covers/, tv-covers/). It then writes a manifest object (schemaVersion, bucket, baseUrl, generatedAt, totalKeys, countsByPrefix, and the full key list) to disk, writing to a .tmp file first and renaming it into place so a reader never sees a half-written manifest.

USAGE
  node scripts/cdn-build-images-manifest.js <path-to-key-list-file>

  <path-to-key-list-file>   Required positional argument: path to a text file of object keys, one per line.

  Environment variables (all optional):
  CDN_BASE        Base URL prepended to keys in the manifest. Default: https://images.any.movie
  BUCKET          Bucket name recorded in the manifest. Default: imagesanymovie
  MANIFEST_PATH   Output path for the manifest. Default: /home/epic/movie-streamer-data/cdn-images-manifest.json

NOTES
- This script only transforms a local key-list file into a local manifest file - it does not itself talk to R2/S3/rclone or any external API. It's normally invoked by scripts/cdn-sync-images.sh after that script has already run rclone to produce the key list.
- Overwrites MANIFEST_PATH each run (atomically, via write-then-rename); safe to re-run as long as the input key-list file is current.
- Exits with an error if the given key-list file doesn't exist.
