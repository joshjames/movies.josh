// src/routes/webhook.routes.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const AccountService = require('../services/AccountService');
const logger = require('../services/logger');

// CRITICAL: This endpoint needs the raw request body to verify the signature
router.post('/subscription_payload', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = String(req.headers['x-square-signature'] || '');
  const webhookSignatureKey = String(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '').trim();
  const fallbackUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const notificationUrl = String(process.env.SUBSCRIPTION_NOTIFICATION_URL || fallbackUrl).trim();

  if (!webhookSignatureKey) {
    logger.error('[SQUARE WEBHOOK] Missing SQUARE_WEBHOOK_SIGNATURE_KEY.');
    return res.status(500).send('Webhook signature key missing');
  }

  // 1. Verify the signature to ensure it's actually Square calling, not a hacker
  const body = req.body.toString('utf8');
  const stringToSign = notificationUrl + body;
  const hmac = crypto.createHmac('sha256', webhookSignatureKey);
  hmac.update(stringToSign);
  const expectedSignature = hmac.digest('base64');

  const signatureMatches = (() => {
    const lhs = Buffer.from(signature);
    const rhs = Buffer.from(expectedSignature);
    if (lhs.length !== rhs.length) return false;
    return crypto.timingSafeEqual(lhs, rhs);
  })();

  if (!signatureMatches) {
    logger.warn('[SQUARE WEBHOOK] Signature mismatch.');
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
});

module.exports = router;