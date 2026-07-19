#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

function parseArgs(argv) {
  const args = {
    recipients: 'scripts/emergency-broadcast/recipients.csv',
    subject: '',
    htmlFile: 'scripts/emergency-broadcast/template.html',
    batchSize: 100,
    pauseMs: 500,
    dryRun: true
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--recipients' && next) {
      args.recipients = next;
      i += 1;
    } else if (token === '--subject' && next) {
      args.subject = next;
      i += 1;
    } else if (token === '--html-file' && next) {
      args.htmlFile = next;
      i += 1;
    } else if (token === '--batch-size' && next) {
      args.batchSize = Number(next);
      i += 1;
    } else if (token === '--pause-ms' && next) {
      args.pauseMs = Number(next);
      i += 1;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--live') {
      args.dryRun = false;
    }
  }

  if (!Number.isFinite(args.batchSize) || args.batchSize < 1) args.batchSize = 100;
  if (!Number.isFinite(args.pauseMs) || args.pauseMs < 0) args.pauseMs = 500;

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadRecipients(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(absolute, 'utf8');
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const body = lines[0].toLowerCase().includes('email') ? lines.slice(1) : lines;
  const parsed = body
    .map((line) => {
      const [emailPart, namePart] = line.split(',');
      const email = String(emailPart || '').trim().toLowerCase();
      const name = String(namePart || '').trim();
      if (!email || !email.includes('@')) return null;
      return { email, name: name || email.split('@')[0] };
    })
    .filter(Boolean);

  const deduped = [];
  const seen = new Set();
  for (const recipient of parsed) {
    if (seen.has(recipient.email)) continue;
    seen.add(recipient.email);
    deduped.push(recipient);
  }

  return deduped;
}

function loadTemplate(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  return fs.readFileSync(absolute, 'utf8');
}

async function sendTransactionalEmail({ apiKey, senderName, senderEmail, subject, html, recipient }) {
  const payload = {
    sender: { name: senderName, email: senderEmail },
    to: [{ email: recipient.email, name: recipient.name }],
    subject,
    htmlContent: html.replace(/{{\\s*name\\s*}}/gi, recipient.name)
  };

  await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey
    },
    timeout: 15000
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = String(process.env.EMAIL_API_KEY || '').trim();
  const senderEmail = String(process.env.SENDER_EMAIL || 'welcome@anyseries.online').trim();
  const senderName = String(process.env.SENDER_NAME || 'AnySeries Online').trim();

  if (!args.subject) {
    throw new Error('Missing required --subject');
  }

  if (!args.dryRun && !apiKey) {
    throw new Error('EMAIL_API_KEY is required for --live mode');
  }

  const recipients = loadRecipients(args.recipients);
  const html = loadTemplate(args.htmlFile);

  if (recipients.length === 0) {
    console.log('[broadcast] No recipients found. Exiting.');
    return;
  }

  console.log(`[broadcast] Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`[broadcast] Subject: ${args.subject}`);
  console.log(`[broadcast] Recipients: ${recipients.length}`);
  console.log(`[broadcast] Batch size: ${args.batchSize}, pause: ${args.pauseMs}ms`);

  if (args.dryRun) {
    const preview = recipients.slice(0, Math.min(10, recipients.length));
    console.log('[broadcast] Preview recipients:');
    for (const item of preview) {
      console.log(`  - ${item.email} (${item.name})`);
    }
    if (recipients.length > preview.length) {
      console.log(`  ...and ${recipients.length - preview.length} more`);
    }
    return;
  }

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < recipients.length; i += args.batchSize) {
    const batch = recipients.slice(i, i + args.batchSize);
    console.log(`[broadcast] Sending batch ${Math.floor(i / args.batchSize) + 1} (${batch.length} recipients)`);

    for (const recipient of batch) {
      try {
        await sendTransactionalEmail({
          apiKey,
          senderName,
          senderEmail,
          subject: args.subject,
          html,
          recipient
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(`[broadcast] Failed: ${recipient.email} :: ${err.message}`);
      }
    }

    if (i + args.batchSize < recipients.length) {
      await sleep(args.pauseMs);
    }
  }

  console.log(`[broadcast] Complete. sent=${sent} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[broadcast] ERROR: ${err.message}`);
  process.exit(1);
});
