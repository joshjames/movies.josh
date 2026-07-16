// src/routes/webhook.routes.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const AccountService = require('../services/AccountService');
const logger = require('../services/logger');

function resolveWebhookConfig(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestProto = forwardedProto || req.protocol;
  const requestHost = forwardedHost || req.get('host');
  const fallbackUrl = `${requestProto}://${requestHost}${req.originalUrl}`;

  const configuredUrls = [
    process.env.SUBSCRIPTION_NOTIFICATION_URL,
    process.env.SUBSCRIPTION_SANDBOX_WEBHOOK_URL,
    process.env.SUBSCRIPTION_SANBOX_WEBHOOK_URL,
    fallbackUrl
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const signatureKeys = [
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
    process.env.SQUARE_SIGNATURE_KEY,
    process.env.SQUARE_SANDBOX_SIGNATURE_KEY
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return {
    signatureKeys,
    notificationUrls: Array.from(new Set(configuredUrls)),
    fallbackUrl
  };
}

function signaturesMatch(candidate, provided) {
  const lhs = Buffer.from(String(provided || ''));
  const rhs = Buffer.from(String(candidate || ''));
  if (lhs.length !== rhs.length) return false;
  return crypto.timingSafeEqual(lhs, rhs);
}

async function handleSubscriptionWebhook(req, res) {
  const signature = String(req.headers['x-square-signature'] || '');
  const { signatureKeys, notificationUrls, fallbackUrl } = resolveWebhookConfig(req);

  if (!signatureKeys.length) {
    logger.error('[SQUARE WEBHOOK] Missing webhook signature keys.');
    return res.status(500).send('Webhook signature key missing');
  }

  if (!signature) {
    return res.status(401).send('Missing signature handshake');
  }

  // 1. Verify the signature to ensure it's actually Square calling.
  const body = req.body.toString('utf8');
  const signatureMatches = signatureKeys.some((key) => {
    return notificationUrls.some((url) => {
      const hmac = crypto.createHmac('sha256', key);
      hmac.update(url + body);
      const expected = hmac.digest('base64');
      return signaturesMatch(expected, signature);
    });
  });

  if (!signatureMatches) {
    logger.warn(
      `[SQUARE WEBHOOK] Signature mismatch for requestUrl=${fallbackUrl} candidates=${notificationUrls.join('|')}`
    );
    return res.status(401).send('Invalid signature handshake');
  }

  // 2. Process the event payload safely
  let event;
  try {
    event = JSON.parse(body);
  } catch (_err) {
    return res.status(400).send('Invalid JSON payload');
  }

  try {
    const result = await AccountService.applyWebhookEvent(event);
    if (!result.handled) {
      logger.info(`[SQUARE WEBHOOK] Ignored event type=${event.type || 'unknown'} reason=${result.reason || 'n/a'}`);
    } else {
      logger.info(`[SQUARE WEBHOOK] Synced user=${result.userKey} status=${result.subscriptionStatus}`);
    }
  } catch (err) {
    logger.error(`[SQUARE WEBHOOK] Failed applying event: ${err.message}`);
    return res.status(500).send('Webhook processing failed');
  }

  // 3. Always respond with a 200 OK within 10 seconds or Square will retry
  res.status(200).send('ACK');
}

// Accept both canonical and sandbox-specific webhook paths.
router.post('/subscription_payload', express.raw({ type: 'application/json' }), handleSubscriptionWebhook);
router.post('/subscription_payload_sandbox', express.raw({ type: 'application/json' }), handleSubscriptionWebhook);

module.exports = router;