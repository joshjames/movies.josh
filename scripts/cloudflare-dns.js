#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const {
  listZones,
  listDnsRecords,
  upsertDnsRecord,
  syncDnsRecords
} = require('../src/utils/CloudflareConnector');

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true });

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = 'true';
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return {
    command: positional[0] || 'help',
    flags
  };
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function printHelp() {
  console.log(`Cloudflare DNS helper

Commands:
  list-zones
  list-records --zone <zone> [--type <type>] [--name <name>] [--json]
  sync-record --zone <zone> --type <type> --name <name> --content <value> [--ttl <n>] [--proxied <true|false>] [--comment <text>]
  sync-from-file [--file <path>]

Environment:
  Uses CF_API_TOKEN, AUTH_TOKEN, or ACCOUNT_API_KEY.
  Uses CF_DNS_RECORDS_FILE for sync-from-file when --file is omitted.
`);
}

function formatRecord(record) {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
    ttl: record.ttl,
    comment: record.comment || ''
  };
}

function printTable(rows, columns) {
  if (!rows.length) {
    console.log('No results.');
    return;
  }

  const widths = {};
  for (const column of columns) {
    widths[column] = column.length;
  }

  for (const row of rows) {
    for (const column of columns) {
      widths[column] = Math.max(widths[column], String(row[column] ?? '').length);
    }
  }

  const header = columns.map((column) => column.padEnd(widths[column])).join('  ');
  const divider = columns.map((column) => '-'.repeat(widths[column])).join('  ');
  console.log(header);
  console.log(divider);

  for (const row of rows) {
    console.log(columns.map((column) => String(row[column] ?? '').padEnd(widths[column])).join('  '));
  }
}

function loadRecordFile(filePath) {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array of record definitions in ${resolvedPath}`);
  }
  return parsed;
}

async function handleListZones(flags) {
  const zones = await listZones();
  const rows = (zones || []).map((zone) => ({
    name: zone.name,
    id: zone.id,
    status: zone.status,
    account: zone.account?.name || ''
  }));

  if (parseBool(flags.json, false)) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  printTable(rows, ['name', 'id', 'status', 'account']);
}

async function handleListRecords(flags) {
  const zone = String(flags.zone || '').trim();
  if (!zone) {
    throw new Error('Missing required --zone value');
  }

  const records = await listDnsRecords({
    zoneName: zone,
    type: flags.type,
    name: flags.name
  });

  const rows = (records || []).map(formatRecord);
  if (parseBool(flags.json, false)) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  printTable(rows, ['type', 'name', 'content', 'proxied', 'ttl', 'comment', 'id']);
}

async function handleSyncRecord(flags) {
  const zone = String(flags.zone || '').trim();
  const type = String(flags.type || 'A').trim();
  const name = String(flags.name || '').trim();
  const content = String(flags.content || '').trim();

  if (!zone || !name || !content) {
    throw new Error('sync-record requires --zone, --name, and --content');
  }

  const result = await upsertDnsRecord({
    zoneName: zone,
    type,
    name,
    content,
    ttl: flags.ttl,
    proxied: parseBool(flags.proxied, true),
    comment: flags.comment
  });

  console.log(JSON.stringify({
    action: result.action,
    zone: result.zoneName,
    record: formatRecord(result.record)
  }, null, 2));
}

async function handleSyncFromFile(flags) {
  const filePath = String(flags.file || process.env.CF_DNS_RECORDS_FILE || 'config/cloudflare-dns.records.json').trim();
  const records = loadRecordFile(filePath);
  const results = await syncDnsRecords(records);
  const rows = results.map((result) => ({
    action: result.action,
    zone: result.zoneName,
    type: result.record.type,
    name: result.record.name,
    content: result.record.content
  }));
  printTable(rows, ['action', 'zone', 'type', 'name', 'content']);
}

async function main() {
  const { command, flags } = parseArgs(process.argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'list-zones') {
    await handleListZones(flags);
    return;
  }

  if (command === 'list-records') {
    await handleListRecords(flags);
    return;
  }

  if (command === 'sync-record') {
    await handleSyncRecord(flags);
    return;
  }

  if (command === 'sync-from-file') {
    await handleSyncFromFile(flags);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(`[cloudflare-dns] ERROR: ${err.message}`);
  process.exit(1);
});