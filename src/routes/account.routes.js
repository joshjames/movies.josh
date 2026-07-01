// src/routes/account.routes.js
const express = require('express');
const router = express.Router();
const AccountService = require('../services/AccountService');
const { requireAuth } = require('../middleware/auth'); // Assuming you have standard session/token auth

/**
 * Handle initial registration payload from signup.html
 */
router.post('/signup/subscribe', requireAuth, async (req, res) => {
  const { name, email, cardNonce } = req.body;
  const userId = req.user.id; // Extracted safely from your session middleware

  if (!cardNonce) {
    return res.status(400).json({ error: 'Missing valid payment instrument token.' });
  }

  try {
    const result = await AccountService.initializeSubscription(userId, { name, email, cardNonce });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Handle manual end-of-cycle cancellation requests from account.html
 */
router.post('/billing/cancel', requireAuth, async (req, res) => {
  const userId = req.user.id;
  
  try {
    const user = await db.users.findById(userId);
    if (!user.squareSubscriptionId) {
      return res.status(400).json({ error: 'No active streaming subscription found.' });
    }

    await AccountService.requestCancellation(userId, user.squareSubscriptionId);
    return res.status(200).json({ message: 'Subscription set to expire at period end successfully.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;