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

// Add this helper endpoint to your src/routes/account.routes.js pipeline
router.get('/status', requireAuth, async (req, res) => {
  try {
    const user = await db.users.findById(req.user.id);
    
    // Default guest metadata contract
    if (!user || user.subscriptionStatus !== 'ACTIVE') {
      return res.status(200).json({ success: true, subscriptionStatus: 'GUEST' });
    }

    // Process dates cleanly from stored Unix stamps or ISO strings
    const cycleDate = user.nextBillingDate 
      ? new Date(user.nextBillingDate).toLocaleDateString('en-US', { dateStyle: 'long' })
      : 'End of current cycle';

    return res.status(200).json({
      success: true,
      subscriptionStatus: user.subscriptionStatus,
      cancelAtPeriodEnd: user.cancelAtPeriodEnd || false,
      nextBillingCycle: cycleDate
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Database tracking synchronization drop.' });
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