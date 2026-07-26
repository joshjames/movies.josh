# any.movie Domain Cutover Checklist (Primary + Alias Domains)

This checklist makes `any.movie` the canonical root while keeping `anymovie.online` and `anyseries.online` working during and after cutover.

## Canonical Domain Policy

1. Canonical root URL:
   - `https://any.movie`
2. Supported alias URLs:
   - `https://anymovie.online`
   - `https://anyseries.online`
3. Optional regional domains (future):
   - `https://anymovie.us`, `https://anymovie.au`, `https://anymovie.eu`

## App Environment Baseline

1. Set primary and aliases:
   - `APP_URL=https://any.movie`
   - `APP_URL_ALIASES=https://anymovie.online,https://anyseries.online`
2. Keep multi-domain request/signature compatibility:
   - `WEBHOOK_DUAL_DOMAIN=true`
   - `SQUARE_WEBHOOK_ADDITIONAL_URLS=` include every Square webhook endpoint URL for all active domains
3. Keep proxy host coverage for all public domains:
   - `NPM_PROXY_DOMAINS=any.movie,anymovie.online,anyseries.online`
4. Set cookie scope for all active domains:
   - `COOKIE_DOMAIN=any.movie,anymovie.online,anyseries.online`
5. Set email sender identity:
   - `SENDER_EMAIL=welcome@any.movie`
   - `SENDER_NAME=Any.Movie`

## DNS Records Checklist

1. For each active public zone (`any.movie`, `anymovie.online`, `anyseries.online`):
   - `A`/`AAAA` (or proxied CNAME) for apex/root
   - `CNAME` for `www` pointing to preferred frontend target
2. If using Cloudflare proxy/load balancing, ensure every active hostname is attached to a valid proxy record.
3. Keep TTL low during cutover windows, then raise TTL after stabilization.
4. For regional hostnames and server FQDN mapping, adopt a predictable pattern:
   - `edge-<region>-<id>.any.movie` (example: `edge-au-syd-1.any.movie`)
   - Document each FQDN to physical/region mapping for future geo-routing.

## Email, Registration, and Deliverability

1. In DNS for `any.movie`, verify:
   - SPF TXT includes Brevo sender policy
   - DKIM CNAME/TXT records from Brevo are valid
   - DMARC TXT exists (`_dmarc.any.movie`)
2. In Brevo:
   - `any.movie` sender domain authenticated
   - `welcome@any.movie` approved sender
3. In app env:
   - `SUPPORT_EMAIL` points to monitored mailbox
4. Validation flow:
   - Signup verification email link opens `https://any.movie`
   - Password reset email link opens `https://any.movie`

## Payments + Webhooks

1. Square webhook URLs must include the active domain endpoints used by Square signature checks.
2. Verify both endpoints per domain:
   - `/api/webhooks/subscription_payload`
   - `/api/webhooks/subscription_payload_sandbox`
3. Re-send a test webhook event and confirm signature validation passes.

## Traffic Behavior During Cutover

1. Preferred behavior now:
   - All domains stay functional.
   - `any.movie` is the canonical link in app UI, emails, and support communications.
2. Optional redirect policy:
   - Use `301` from alias domains to `https://any.movie` when you are ready for strict canonicalization.
   - Keep aliases non-redirecting until you are done with transition testing.

## Validation Commands

```bash
# Verify domain defaults in code and scripts
rg -n "any\.movie|anymovie\.online|anyseries\.online|APP_URL|APP_URL_ALIASES|NPM_PROXY_DOMAINS|COOKIE_DOMAIN|SENDER_EMAIL"

# Verify DNS answers (example)
dig +short any.movie
dig +short anymovie.online
dig +short anyseries.online
```

## Rollback Plan

1. Revert only env values:
   - `APP_URL` to previous canonical
   - `APP_URL_ALIASES` to previous alias set
2. Keep webhook candidate URLs broad until stable.
3. Re-test auth cookies, signup/reset links, and Square webhook signatures.

## Exit Criteria

1. `any.movie` stable as default for at least 24 hours.
2. Alias domains verified functional end-to-end (login, browse, playback, billing webhook callbacks).
3. DNS and email auth records show healthy status in provider dashboards.
