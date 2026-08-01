// src/routes/account.routes.js
const express = require('express');
const router = express.Router();
const AccountService = require('../services/AccountService');
const ProfileService = require('../services/ProfileService');
const AcquisitionQuotaService = require('../services/AcquisitionQuotaService');
const { requireAuth, getActiveUser } = require('../middleware/auth');
const { config: squareConfig } = require('../config/square');
const { getSessionCookieOptions } = require('../utils/cookieOptions');
const SeriesSubscriptionService = require('../services/SeriesSubscriptionService');

/**
 * Handle initial registration payload from signup.html
 */
router.post('/signup/subscribe', requireAuth, async (req, res) => {
  const { name, email, cardNonce, planTierId } = req.body;
  const userKey = getActiveUser(req);

  if (!cardNonce) {
    return res.status(400).json({ error: 'Missing valid payment instrument token.' });
  }

  try {
    const result = await AccountService.initializeSubscription(userKey, { name, email, cardNonce, planTierId });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
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

router.get('/checkout-config', requireAuth, (req, res) => {
  const hasRuntime = Boolean(squareConfig.applicationId && squareConfig.locationId);
  const rawPrice = Number(process.env.SQUARE_SUBSCRIPTION_PRICE_CENTS);
  const planPriceCents = Number.isFinite(rawPrice) && rawPrice > 0 ? Math.floor(rawPrice) : 999;
  const currency = String(process.env.SQUARE_CURRENCY || 'USD').trim().toUpperCase() || 'USD';
  const planLabel = String(process.env.SUBSCRIPTION_PLAN_LABEL || 'Premium Stream Access').trim() || 'Premium Stream Access';

  const patreonJoinUrl = String(
    process.env.PATREON_JOIN_URL ||
    process.env.PATREON_URL ||
    'https://www.patreon.com/'
  ).trim();

  return res.json({
    success: true,
    plan: {
      id: 'premium-monthly',
      label: planLabel,
      priceCents: planPriceCents,
      currency,
      interval: 'month'
    },
    square: {
      enabled: hasRuntime,
      hasRuntime,
      applicationId: squareConfig.applicationId || null,
      locationId: squareConfig.locationId || null,
      isProduction: Boolean(squareConfig.isProduction)
    },
    paymentOptions: {
      square: {
        enabled: hasRuntime,
        label: 'Credit or Debit Card',
        provider: 'Square'
      },
      patreon: {
        enabled: Boolean(patreonJoinUrl),
        label: 'Patreon Membership',
        provider: 'Patreon',
        joinUrl: patreonJoinUrl
      }
    }
  });
});

// Add this helper endpoint to your src/routes/account.routes.js pipeline
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userKey = getActiveUser(req);
    let config = await ProfileService.readData(userKey, 'config', {});

    // Webhook-free mode: reconcile status directly from Square on each status check.
    if (config.squareSubscriptionId) {
      const syncResult = await AccountService.reconcileSubscriptionState(userKey);
      if (syncResult.success && syncResult.config) {
        config = syncResult.config;
      }
    }
    const now = Date.now();
    const trialEndsMs = config.trialEndsAt ? new Date(config.trialEndsAt).getTime() : 0;
    const graceEndsMs = config.gracePeriodEndsAt ? new Date(config.gracePeriodEndsAt).getTime() : 0;
    const inTrial = trialEndsMs > now;
    const inGrace = graceEndsMs > now;
    const quota = await AcquisitionQuotaService.getQuotaSnapshot(userKey, config);
    
    // Default guest metadata contract
    if (!config || config.subscriptionStatus !== 'ACTIVE') {
      if (inTrial) {
        return res.status(200).json({
          success: true,
          subscriptionStatus: 'TRIAL',
          trialEndsAt: config.trialEndsAt,
          trialDays: Number(config.trialDays || 0),
          quota
        });
      }

      if (inGrace) {
        return res.status(200).json({
          success: true,
          subscriptionStatus: 'GRACE',
          gracePeriodEndsAt: config.gracePeriodEndsAt,
          gracePeriodDays: Number(config.gracePeriodDays || 0),
          quota
        });
      }

      return res.status(200).json({
        success: true,
        subscriptionStatus: config.subscriptionStatus || 'GUEST',
        trialEndsAt: config.trialEndsAt || null,
        gracePeriodEndsAt: config.gracePeriodEndsAt || null,
        quota
      });
    }

    // Process dates cleanly from stored Unix stamps or ISO strings
    const cycleDate = config.nextBillingDate 
      ? new Date(config.nextBillingDate).toLocaleDateString('en-US', { dateStyle: 'long' })
      : 'End of current cycle';

    return res.status(200).json({
      success: true,
      subscriptionStatus: config.subscriptionStatus,
      cancelAtPeriodEnd: config.cancelAtPeriodEnd || false,
      nextBillingCycle: cycleDate,
      subscribedAt: config.subscribedAt || null,
      trialEndsAt: config.trialEndsAt || null,
      gracePeriodEndsAt: config.gracePeriodEndsAt || null,
      quota
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
    await AccountService.reconcileSubscriptionState(userKey);
    return res.status(200).json({ success: true, message: 'Subscription set to expire at period end successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/profile', requireAuth, async (req, res) => {
  try {
    const userKey = getActiveUser(req);
    const config = await ProfileService.readData(userKey, 'config', {});
    const quota = await AcquisitionQuotaService.getQuotaSnapshot(userKey, config);
    return res.json({
      success: true,
      user: {
        userKey,
        email: config.email || userKey,
        displayName: config.displayName || config.name || config.username || userKey,
        name: config.name || config.displayName || config.username || userKey,
        avatar: config.avatar || 'avatar_001.png',
        subscriptionStatus: config.subscriptionStatus || 'GUEST',
        quota
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
      res.cookie('user_profile', updated.userKey, getSessionCookieOptions(req));
    }

    return res.json({ success: true, userKey: updated.userKey, config: updated.config });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/subscriptions', requireAuth, async (req, res) => {
  try {
    const userKey = getActiveUser(req);
    const store = await SeriesSubscriptionService.readSubscriptions(userKey);
    return res.json({ success: true, userKey, items: store.items });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/subscriptions', requireAuth, async (req, res) => {
  try {
    const userKey = getActiveUser(req);
    const result = await SeriesSubscriptionService.addSubscription(userKey, req.body || {});
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json({ success: true, item: result.item, count: result.count });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/subscriptions/:imdbId', requireAuth, async (req, res) => {
  try {
    const userKey = getActiveUser(req);
    const result = await SeriesSubscriptionService.removeSubscription(userKey, { imdbId: req.params.imdbId });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;