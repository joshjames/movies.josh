#!/usr/bin/env node

'use strict';

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function normalizeBaseUrl(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function parseCsv(input) {
  return String(input || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function intersects(a, b) {
  const set = new Set((a || []).map((v) => String(v || '').toLowerCase()));
  return (b || []).some((v) => set.has(String(v || '').toLowerCase()));
}

function buildUpdatePayload(host, targetHost, targetPort) {
  const clone = { ...host };
  delete clone.id;
  delete clone.owner;
  delete clone.owner_user_id;
  delete clone.user_id;
  delete clone.created_on;
  delete clone.modified_on;

  clone.forward_host = targetHost;
  clone.forward_port = Number(targetPort);
  return clone;
}

async function apiFetch(url, options = {}, token = '') {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    const detail = body && body.error ? body.error : JSON.stringify(body || {});
    throw new Error(`HTTP ${res.status} ${res.statusText} at ${url}: ${detail}`);
  }
  return body;
}

async function main() {
  const npmUrl = normalizeBaseUrl(env('NPM_URL'));
  const adminUser = env('NPM_ADMIN_USER') || env('PM_ADMIN_USER');
  const adminPassword = env('NPM_ADMIN_PASSWORD');
  const targetHost = env('TARGET_CONTAINER_HOST');
  const targetPort = env('TARGET_CONTAINER_PORT', '3000');
  const domains = parseCsv(env('NPM_PROXY_DOMAINS', 'any.movie,anyseries.online'));
  const dryRun = ['1', 'true', 'yes'].includes(env('NPM_DRY_RUN', 'false').toLowerCase());

  if (!npmUrl || !adminUser || !adminPassword || !targetHost) {
    throw new Error('Missing required env vars: NPM_URL, NPM_ADMIN_USER/PM_ADMIN_USER, NPM_ADMIN_PASSWORD, TARGET_CONTAINER_HOST');
  }

  console.log(`[npm-switch] Authenticating to ${npmUrl} as ${adminUser}`);
  const tokenBody = await apiFetch(`${npmUrl}/api/tokens`, {
    method: 'POST',
    body: JSON.stringify({ identity: adminUser, secret: adminPassword })
  });

  const token = tokenBody?.token;
  if (!token) {
    throw new Error('Auth succeeded but token was missing in response');
  }

  const hosts = await apiFetch(`${npmUrl}/api/nginx/proxy-hosts`, { method: 'GET' }, token);
  if (!Array.isArray(hosts)) {
    throw new Error('Unexpected proxy-hosts response shape');
  }

  const selected = hosts.filter((host) => {
    const hostDomains = Array.isArray(host.domain_names) ? host.domain_names : [];
    if (domains.length > 0) {
      return intersects(hostDomains, domains);
    }
    return String(host.forward_host || '').startsWith('movie-streamer');
  });

  if (selected.length === 0) {
    console.log('[npm-switch] No proxy hosts matched configured domains. No updates applied.');
    return;
  }

  console.log(`[npm-switch] Matched ${selected.length} proxy host(s). Target => http://${targetHost}:${targetPort}`);

  for (const host of selected) {
    const hostId = host.id;
    const domainList = (host.domain_names || []).join(', ');
    if (!hostId) {
      console.log(`[npm-switch] Skipping host with missing id (${domainList})`);
      continue;
    }

    if (dryRun) {
      console.log(`[npm-switch] DRY RUN: would update host #${hostId} (${domainList}) to ${targetHost}:${targetPort}`);
      continue;
    }

    const payload = buildUpdatePayload(host, targetHost, targetPort);
    await apiFetch(`${npmUrl}/api/nginx/proxy-hosts/${hostId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }, token);

    console.log(`[npm-switch] Updated host #${hostId} (${domainList})`);
  }
}

main().catch((err) => {
  console.error(`[npm-switch] ERROR: ${err.message}`);
  process.exit(1);
});
