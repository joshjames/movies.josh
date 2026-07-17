#!/usr/bin/env bash
set -euo pipefail

WEBUI_PORT="${QBIT_HOST_WEBUI_PORT:-18080}"
BASE="http://127.0.0.1:${WEBUI_PORT}/api/v2"
USER_NAME="${QBIT_SEARCH_USER:-${HOST_QBITTORRENT_USER:-}}"
PASSWORD="${QBIT_SEARCH_PASSWORD:-${HOST_QBITTORRENT_PW:-}}"

printf '== process ==\n'
pgrep -a -f 'qbittorrent-nox|qbittorrent' || true

printf '\n== listener ==\n'
ss -lntp | grep ":${WEBUI_PORT}" || true

printf '\n== app version ==\n'
curl -sS -i "${BASE}/app/version" | head -n 20 || true

if [[ -n "$USER_NAME" && -n "$PASSWORD" ]]; then
  printf '\n== auth + plugins ==\n'
  LOGIN_HEADERS=$(mktemp)
  LOGIN_BODY=$(mktemp)
  curl -sS -D "$LOGIN_HEADERS" -o "$LOGIN_BODY" \
    -X POST "${BASE}/auth/login" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "username=${USER_NAME}" \
    --data-urlencode "password=${PASSWORD}" || true

  STATUS=$(awk 'NR==1{print $2}' "$LOGIN_HEADERS")
  SID=$(awk 'BEGIN{IGNORECASE=1} /^set-cookie: SID=/{sub(/^set-cookie: /,""); sub(/;.*$/,""); print; exit}' "$LOGIN_HEADERS")
  echo "login_status=${STATUS:-unknown} sid_cookie=$([[ -n "$SID" ]] && echo yes || echo no)"

  if [[ -n "$SID" ]]; then
    curl -sS -i "${BASE}/search/plugins" -H "Cookie: ${SID}" | head -n 40 || true
  fi

  rm -f "$LOGIN_HEADERS" "$LOGIN_BODY"
else
  printf '\nNo HOST_QBITTORRENT_USER / HOST_QBITTORRENT_PW provided in env; skipping authenticated plugin check.\n'
fi
