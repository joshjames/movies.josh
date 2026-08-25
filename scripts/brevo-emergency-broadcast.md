Sends a one-off HTML email broadcast to a CSV list of recipients via the Brevo transactional email API.

WHAT IT DOES
Reads a recipient list (CSV of email,name - defaults to scripts/emergency-broadcast/recipients.csv), dedupes by email, and loads an HTML template (defaults to scripts/emergency-broadcast/template.html). It substitutes `{{name}}` in the template per recipient, derives a plain-text fallback from the HTML, and sends each recipient an individual message through the Brevo `v3/smtp/email` API using the `EMAIL_API_KEY` credential (sender defaults to `SENDER_EMAIL`/`SENDER_NAME` env vars, falling back to welcome@any.movie / Any.Movie). Sends are done in batches with a pause between batches to avoid hammering the API, and failures per-recipient are logged and counted without stopping the run.

By default the script runs in dry-run mode: it loads and validates everything and prints a preview of the first 10 recipients, but sends nothing. Only `--live` actually calls the Brevo API.

USAGE
  node scripts/brevo-emergency-broadcast.js --subject "<subject>" [--recipients <path>] [--html-file <path>] [--batch-size <n>] [--pause-ms <n>] [--dry-run | --live]

  --subject <text>     Required. Email subject line.
  --recipients <path>  CSV file of recipients (email,name per line). Default: scripts/emergency-broadcast/recipients.csv
  --html-file <path>   HTML template file, supports {{name}} placeholder. Default: scripts/emergency-broadcast/template.html
  --batch-size <n>     Recipients per batch before pausing. Default: 100
  --pause-ms <n>       Milliseconds to pause between batches. Default: 500
  --dry-run            Preview only, sends nothing (this is the default if neither flag is given).
  --live               Actually send email through Brevo. Requires EMAIL_API_KEY to be set.

NOTES
- Requires EMAIL_API_KEY (Brevo API key) in the environment for --live mode; --dry-run works without it.
- ⚠️ WARNING: running with --live sends real, immediate email to every address in the recipients file via the Brevo API. There is no "undo send" - once a batch is sent it cannot be recalled. Always run without --live first (or explicitly with --dry-run) to check the recipient list and rendered content before switching to --live.
- Double-check the recipients CSV and template content before a live run - this script is meant for urgent one-off broadcasts (e.g. incident notices), not routine mailings, and mistakes reach real users' inboxes immediately.
