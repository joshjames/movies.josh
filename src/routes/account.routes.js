// src/routes/account.routes.js
const express = require('express');
const router = express.Router();
const AccountService = require('../services/AccountService');
const ProfileService = require('../services/ProfileService');
const { requireAuth, getActiveUser } = require('../middleware/auth');
const { config: squareConfig } = require('../config/square');

/**
 * Handle initial registration payload from signup.html
 */
router.post('/signup/subscribe', requireAuth, async (req, res) => {
  const { name, email, cardNonce } = req.body;
  const userKey = getActiveUser(req);

  if (!cardNonce) {
    return res.status(400).json({ error: 'Missing valid payment instrument token.' });
  }

  try {
    const result = await AccountService.initializeSubscription(userKey, { name, email, cardNonce });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/square-config', requireAuth, (req, res) => {
  const hasRuntime = Boolean(squareConfig.applicationId && squareConfig.locationId);
  return res.json({
    success: true,
    hasRuntime,
    applicationId: squareConfig.applicationId || null,
    locationId: squareConfig.locationId || null,
    isProduction: Boolean(squareConfig.isProduction)
  });
});

// Add this helper endpoint to your src/routes/account.routes.js pipeline
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userKey = getActiveUser(req);
    const config = await ProfileService.readData(userKey, 'config', {});
    
    // Default guest metadata contract
    if (!config || config.subscriptionStatus !== 'ACTIVE') {
      return res.status(200).json({ success: true, subscriptionStatus: 'GUEST' });
    }

    // Process dates cleanly from stored Unix stamps or ISO strings
    const cycleDate = config.nextBillingDate 
      ? new Date(config.nextBillingDate).toLocaleDateString('en-US', { dateStyle: 'long' })
      : 'End of current cycle';

    return res.status(200).json({
      success: true,
      subscriptionStatus: config.subscriptionStatus,
      cancelAtPeriodEnd: config.cancelAtPeriodEnd || false,
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
  const userKey = getActiveUser(req);
  
  try {
    const config = await ProfileService.readData(userKey, 'config', {});
    if (!config.squareSubscriptionId) {
      return res.status(400).json({ error: 'No active streaming subscription found.' });
    }

    await AccountService.requestCancellation(userKey, config.squareSubscriptionId);
    return res.status(200).json({ success: true, message: 'Subscription set to expire at period end successfully.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/profile', requireAuth, async (req, res) => {
  try {
    const userKey = getActiveUser(req);
    const config = await ProfileService.readData(userKey, 'config', {});
    return res.json({
      success: true,
      user: {
        userKey,
        email: config.email || userKey,
        displayName: config.displayName || config.name || config.username || userKey,
        name: config.name || config.displayName || config.username || userKey,
        subscriptionStatus: config.subscriptionStatus || 'GUEST'
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/profile', requireAuth, async (req, res) => {
  try {
    const userKey = getActiveUser(req);
    const payload = req.body || {};
    const updated = await ProfileService.updateAccountProfile(userKey, payload);

    if (updated.userKey && updated.userKey !== userKey) {
      res.cookie('user_profile', updated.userKey, { maxAge: 31536000000, path: '/' });
    }

    return res.json({ success: true, userKey: updated.userKey, config: updated.config });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;