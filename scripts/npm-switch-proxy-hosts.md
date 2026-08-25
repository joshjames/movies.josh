Repoints Nginx Proxy Manager's reverse-proxy hosts for the site's domains to a different backend container/port.

WHAT IT DOES
Logs into a running Nginx Proxy Manager (NPM) instance's API using admin credentials, fetches all configured proxy hosts, and filters them down to the ones matching a configured list of domains (defaults to any.movie, www.any.movie, anyseries.online, anymovie.app, anymovie.digital, anymovie.club, anymovie.today plus whatever NPM_PROXY_DOMAINS adds - the code always merges in that hard-coded default domain list even if NPM_PROXY_DOMAINS is set, it never replaces it). For each matching proxy host it rewrites the host's `forward_host`/`forward_port` to the given target container/port and PUTs the updated host definition back to NPM, leaving every other setting on the host (SSL, access lists, custom locations, etc.) untouched.

If NPM_DRY_RUN is truthy, it logs what it would change for each matched host without calling the update API.

USAGE
  node scripts/npm-switch-proxy-hosts.js

  Takes no CLI flags - entirely configured via environment variables:
  NPM_URL                 Required. Base URL of the Nginx Proxy Manager instance.
  NPM_ADMIN_USER / PM_ADMIN_USER   Required. NPM admin login identity.
  NPM_ADMIN_PASSWORD       Required. NPM admin login secret.
  TARGET_CONTAINER_HOST    Required. New forward_host value for matched proxy hosts.
  TARGET_CONTAINER_PORT    New forward_port value. Default: 3000
  NPM_PROXY_DOMAINS        Comma-separated list of domains to match (merged with the built-in defaults, not replacing them).
  NPM_DRY_RUN              Set to 1/true/yes to log intended changes without applying them.

NOTES
- Requires network access to the NPM instance's API and valid NPM admin credentials.
- ⚠️ WARNING: with NPM_DRY_RUN unset/false, this immediately reconfigures Nginx Proxy Manager's live reverse-proxy routing for every production domain that matches - meaning it can redirect real, in-flight user traffic for any.movie and its sibling domains to a different backend the instant each PUT call succeeds. There is no automatic rollback; reversing it means re-running the script with TARGET_CONTAINER_HOST/PORT set back to the previous backend (so know the current forward_host/port before switching, e.g. via NPM's UI or the API, so you can switch back). Always try NPM_DRY_RUN=true first to confirm which hosts will be touched before a live run.
- If no configured domain matches any proxy host, the script logs that and exits without making any changes (it does not fall back to guessing).
