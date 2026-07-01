// src/routes/webhook.routes.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// CRITICAL: This endpoint needs the raw request body to verify the signature
router.post('/subscription_payload', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-square-signature'];
  const webhookSignatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY; // From your Square Dashboard
  const notificationUrl = process.env.SUBSCRIPTION_NOTIFICATION_URL;

  // 1. Verify the signature to ensure it's actually Square calling, not a hacker
  const body = req.body.toString('utf8');
  const stringToSign = notificationUrl + body;
  const hmac = crypto.createHmac('sha256', webhookSignatureKey);
  hmac.update(stringToSign);
  const expectedSignature = hmac.digest('base64');

  if (signature !== expectedSignature) {
    return res.status(401).send('Invalid signature handshake');
  }

  // 2. Process the event payload safely
  const event = JSON.parse(body);
  
  if (event.type === 'subscription.updated') {
    const subscription = event.data.object;
    
    if (subscription.status === 'DEACTIVATED' || subscription.status === 'CANCELED') {
      // Sync your local DB state to drop their access tier
      await db.users.update({ squareCustomerId: subscription.customer_id }, {
        subscriptionStatus: 'INACTIVE',
        billingTier: 'guest'
      });
    }
  }

  // 3. Always respond with a 200 OK within 10 seconds or Square will retry
  res.status(200).send('ACK');
});

module.exports = router;