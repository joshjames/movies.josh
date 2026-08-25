Command-line helper for listing and syncing Cloudflare DNS zones/records via the Cloudflare API.

WHAT IT DOES
A small multi-command CLI wrapping src/utils/CloudflareConnector: it can list all zones on the account, list DNS records for a given zone (optionally filtered by type/name), create-or-update ("upsert") a single DNS record, or bulk-sync a list of record definitions from a JSON file. "Sync" here means it looks for an existing record matching zone+type+name and updates its content/TTL/proxied/comment if found, or creates it if not - it does not delete records that are absent from the file.

USAGE
  node scripts/cloudflare-dns.js list-zones [--json]
  node scripts/cloudflare-dns.js list-records --zone <zone> [--type <type>] [--name <name>] [--json]
  node scripts/cloudflare-dns.js sync-record --zone <zone> --type <type> --name <name> --content <value> [--ttl <n>] [--proxied <true|false>] [--comment <text>]
  node scripts/cloudflare-dns.js sync-from-file [--file <path>]
  node scripts/cloudflare-dns.js help

  list-zones             List all Cloudflare zones the API token can see.
  list-records            List DNS records for --zone (optional --type/--name filters).
  sync-record             Create or update a single record (requires --zone, --name, --content; --type defaults to A, --proxied defaults to true).
  sync-from-file          Create/update every record described in a JSON array file (--file, or CF_DNS_RECORDS_FILE env var, or config/cloudflare-dns.records.json by default).
  --json                  (list-zones/list-records) Print raw JSON instead of a formatted table.

NOTES
- Requires a Cloudflare API token in CF_API_TOKEN, AUTH_TOKEN, or ACCOUNT_API_KEY.
- list-zones and list-records are read-only and safe to run anytime.
- ⚠️ WARNING: sync-record and sync-from-file write real, live public DNS changes via the Cloudflare API immediately - there is no confirmation prompt or dry-run flag. A wrong --content, --zone, or a typo'd record definition in the sync file can misdirect or break live traffic for that hostname (including proxied/orange-cloud status, which affects whether Cloudflare's proxy and WAF sit in front of it). Double-check --zone, --name, --content, and --proxied before running, and verify a change with list-records afterward. Undo requires manually re-applying the previous record value - the tool does not keep a change history.
