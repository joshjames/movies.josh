# Emergency Brevo Broadcast

Use this to send urgent status updates (DNS blocklist, outage, payment/verification impact) in controlled batches.

## Files

- script: `scripts/brevo-emergency-broadcast.js`
- recipients template: `scripts/emergency-broadcast/recipients.csv`
- html template: `scripts/emergency-broadcast/template.html`

## Recipient CSV Format

Header is optional but recommended:

```csv
email,name
person1@example.com,Person One
person2@example.com,Person Two
```

- Duplicate emails are automatically removed.
- Invalid rows are skipped.

## Dry Run (recommended first)

```bash
node scripts/brevo-emergency-broadcast.js \
  --subject "AnySeries Service Update" \
  --recipients scripts/emergency-broadcast/recipients.csv \
  --html-file scripts/emergency-broadcast/template.html \
  --batch-size 100 \
  --pause-ms 750 \
  --dry-run
```

Dry run prints recipient preview only and sends nothing.

## Live Send

```bash
node scripts/brevo-emergency-broadcast.js \
  --subject "AnySeries Service Update" \
  --recipients scripts/emergency-broadcast/recipients.csv \
  --html-file scripts/emergency-broadcast/template.html \
  --batch-size 100 \
  --pause-ms 750 \
  --live
```

Live mode requires:

- `EMAIL_API_KEY`
- `SENDER_EMAIL`
- `SENDER_NAME`

## Suggested Emergency Workflow

1. Update the HTML template with current status and expected next update window.
2. Run dry-run and verify recipient count + sample entries.
3. Run live send in batches.
4. Save command output for incident timeline.
5. Send a final resolution email when DNS/provider issue is fully cleared.

## Rollback / Safety

- If results are unexpected, stop before `--live`.
- To pause a live campaign, interrupt the process (`Ctrl+C`) between batches.
- Fix CSV/template and rerun from scratch (dedupe still applies per run).
