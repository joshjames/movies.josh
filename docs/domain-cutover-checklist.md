# AnySeries Domain Cutover Checklist (Emergency Compatible)

This checklist keeps `anyseries.online` as primary while preserving temporary compatibility for `anymovie.online` during DNS/security-provider recovery.

## Pre-Deploy Checks

1. Confirm environment has:
   - `APP_URL=https://anyseries.online`
   - `APP_URL_LEGACY=https://anymovie.online`
   - `WEBHOOK_DUAL_DOMAIN=true`
   - `SQUARE_WEBHOOK_ADDITIONAL_URLS` includes legacy webhook URLs
   - `NPM_PROXY_DOMAINS=anyseries.online,anymovie.online`
2. Confirm sender identity is updated:
   - `SENDER_EMAIL=welcome@anyseries.online`
   - `SENDER_NAME="AnySeries Online"`
3. Confirm Square URLs/names point to primary domain.
4. Keep internal Docker service URLs unchanged.

## Cutover Steps

1. Deploy config/code update.
2. Keep NPM proxy host matching both domains during transition.
3. Verify app login cookie behavior on primary domain.
4. Verify password reset + verification email links.
5. Verify Square webhook delivery for production and sandbox.
6. Verify queue completion emails open primary URL.

## DNS/Provider Incident Mode

1. If `anyseries.online` is blocked in one resolver, continue serving where available.
2. Keep legacy domain in compatibility mode until provider blocklist is lifted.
3. Use emergency broadcast script to send customer status updates.

## Validation Commands

```bash
# Confirm intentional legacy references only
grep -R "anymovie.online" src scripts .env sydney.env

# Quick syntax verification in editor tooling
# (use VS Code Problems / get_errors output)
```

## Rollback Plan

1. Revert only env values to legacy primary:
   - `APP_URL=https://anymovie.online`
   - `AUTH_LINKS_USE_LEGACY=true`
2. Keep `APP_URL_LEGACY` as anyseries if needed.
3. Update NPM target domains/order back if required.
4. Redeploy configuration only.
5. Re-test login, reset email, webhook signature validation.

## Exit Criteria (Back to Normal)

1. DNS/security-provider issue confirmed resolved by providers.
2. Primary domain stable for at least 24 hours.
3. Optional: remove dual-domain compatibility after monitoring window.
