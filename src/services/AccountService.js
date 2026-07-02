// src/services/AccountService.js
const { square, config } = require('../config/square');
const ProfileService = require('./ProfileService');
const logger = require('./logger');

function resolvePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function toIso(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function toDateOnlyIso(value) {
  return toIso(value).split('T')[0];
}

function normalizeSquareSubscriptionStatus(status) {
  const raw = String(status || '').toUpperCase().trim();
  if (!raw) return 'UNKNOWN';

  const map = {
    ACTIVE: 'ACTIVE',
    PENDING: 'PENDING',
    PAUSED: 'PAUSED',
    CANCELED: 'CANCELED',
    CANCELLED: 'CANCELED',
    DEACTIVATED: 'DEACTIVATED'
  };

  return map[raw] || raw;
}

class AccountService {
  async findMonthlyPlanVariationIdFromCatalog() {
    const targetPlanName = String(
      process.env.SQUARE_SUBSCRIPTION_PLAN_NAME ||
      process.env.SQUARE_SUBSCRIPTION_NAME_SANDBOX ||
      process.env.SQUARE_SUBSCRIPTION_NAME ||
      'Anymovie.Online Streaming Access'
    ).trim().toLowerCase();

    let cursor;
    do {
      const response = await square.catalog.search({
        objectTypes: ['SUBSCRIPTION_PLAN', 'SUBSCRIPTION_PLAN_VARIATION'],
        cursor,
        limit: 100
      });

      const objects = Array.isArray(response.objects) ? response.objects : [];
      const variations = objects.filter((obj) => obj?.type === 'SUBSCRIPTION_PLAN_VARIATION');

      // 1) Prefer variation tied to configured plan name and monthly cadence.
      const preferred = variations.find((variation) => {
        const vData = variation.subscriptionPlanVariationData || {};
        const planObj = objects.find((obj) => obj?.id === vData.subscriptionPlanId && obj?.type === 'SUBSCRIPTION_PLAN');
        const planName = String(planObj?.subscriptionPlanData?.name || '').trim().toLowerCase();
        const phase = (vData.phases || [])[0] || {};
        const cadence = String(phase?.cadence || '').toUpperCase().trim();
        return planName && planName.includes(targetPlanName) && cadence === 'MONTHLY';
      });
      if (preferred?.id) return preferred.id;

      // 2) Fallback to any monthly variation.
      const monthlyAny = variations.find((variation) => {
        const phase = (variation.subscriptionPlanVariationData?.phases || [])[0] || {};
        const cadence = String(phase?.cadence || '').toUpperCase().trim();
        return cadence === 'MONTHLY';
      });
      if (monthlyAny?.id) return monthlyAny.id;

      cursor = response.cursor;
    } while (cursor);

    return null;
  }

  resolvePlanVariationId(planTierId) {
    const requested = String(planTierId || '').trim();
    const generic = String(process.env.SQUARE_PLAN_VARIATION_ID || '').trim();

    const tierAliases = new Set(['premium-monthly', 'premium-annual']);
    if (requested && !tierAliases.has(requested)) {
      return requested;
    }

    if (config.isProduction) {
      return String(process.env.SQUARE_PROD_PLAN_VARIATION_ID || generic || '').trim();
    }

    return String(process.env.SQUARE_SANDBOX_PLAN_VARIATION_ID || generic || '').trim();
  }

  async findUserBySquareReferences({ squareCustomerId, squareSubscriptionId }) {
    const users = await ProfileService.listUsers();
    for (const userKey of users) {
      const cfg = await ProfileService.readData(userKey, 'config', {});
      if (!cfg || typeof cfg !== 'object') continue;

      if (squareCustomerId && cfg.squareCustomerId === squareCustomerId) return userKey;
      if (squareSubscriptionId && cfg.squareSubscriptionId === squareSubscriptionId) return userKey;
    }
    return null;
  }

  async initializeSubscription(userKey, { name, email, cardNonce, planTierId } = {}) {
    try {
      const activeConfig = await ProfileService.readData(userKey, 'config', {});
      const resolvedEmail = String(email || activeConfig.email || userKey).trim().toLowerCase();
      const resolvedName = String(name || activeConfig.displayName || activeConfig.name || activeConfig.username || resolvedEmail).trim();
      let planVariationId = this.resolvePlanVariationId(planTierId);

      if (!planVariationId) {
        try {
          planVariationId = await this.findMonthlyPlanVariationIdFromCatalog();
        } catch (catalogErr) {
          logger.warn(`[SQUARE] Catalog plan variation lookup failed: ${catalogErr.message}`);
        }
      }

      if (!config.locationId) {
        throw new Error('Square location ID is missing for current environment.');
      }
      if (!planVariationId) {
        throw new Error('Square plan variation ID is missing. Set SQUARE_SANDBOX_PLAN_VARIATION_ID or SQUARE_PROD_PLAN_VARIATION_ID, or define SQUARE_SUBSCRIPTION_PLAN_NAME/SQUARE_SUBSCRIPTION_NAME_* to auto-discover.');
      }

      const nowIso = new Date().toISOString();
      const signupIso = toIso(activeConfig.signupDate || activeConfig.createdAt || nowIso);
      const trialDays = resolvePositiveInt(process.env.SUBSCRIPTION_TRIAL_DAYS, 7);
      const trialEndsAt = new Date(new Date(signupIso).getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString();

      // 1. Register or reuse customer profile inside Square
      let squareCustomerId = String(activeConfig.squareCustomerId || '').trim();
      if (!squareCustomerId) {
        const customerResponse = await square.customers.create({
          givenName: resolvedName.split(' ')[0] || resolvedName,
          familyName: resolvedName.split(' ').slice(1).join(' ') || '',
          emailAddress: resolvedEmail,
          referenceId: userKey.toString()
        });
        squareCustomerId = customerResponse.customer.id;
      } else {
        try {
          await square.customers.update({
            customerId: squareCustomerId,
            emailAddress: resolvedEmail,
            givenName: resolvedName.split(' ')[0] || resolvedName,
            familyName: resolvedName.split(' ').slice(1).join(' ') || ''
          });
        } catch (updateErr) {
          logger.warn(`[SQUARE] Customer update skipped for ${userKey}: ${updateErr.message}`);
        }
      }

      // 2. Attach the secure card token safely to their Customer profile
      const cardResponse = await square.cards.create({
        idempotencyKey: `card-${userKey}-${Date.now()}`,
        card: {
          customerId: squareCustomerId,
          referenceId: userKey.toString()
        },
        sourceId: cardNonce
      });
      const squareCardId = cardResponse.card.id;

      // 3. Bind the customer profile to your subscription plan
      const subscriptionResponse = await square.subscriptions.create({
        idempotencyKey: `sub-${userKey}-${Date.now()}`,
        locationId: config.locationId,
        planVariationId,
        customerId: squareCustomerId,
        cardId: squareCardId,
        startDate: toDateOnlyIso(nowIso)
      });

      const subscription = subscriptionResponse.subscription || {};
      const normalizedStatus = normalizeSquareSubscriptionStatus(subscription.status || 'ACTIVE');

      const nextConfig = {
        ...activeConfig,
        signupDate: signupIso,
        subscribedAt: nowIso,
        email: resolvedEmail,
        displayName: resolvedName,
        name: resolvedName,
        squareCustomerId,
        squareCardId,
        squareSubscriptionId: subscription.id,
        subscriptionStatus: normalizedStatus,
        billingTier: planTierId || 'premium-monthly',
        subscriptionPlanVariationId: planVariationId,
        cancelAtPeriodEnd: false,
        cancellationRequestedAt: null,
        gracePeriodDays: resolvePositiveInt(process.env.SUBSCRIPTION_GRACE_DAYS, 3),
        gracePeriodEndsAt: null,
        trialDays,
        trialEndsAt,
        freeAccessActive: false,
        nextBillingDate: subscription.chargedThroughDate || activeConfig.nextBillingDate || null,
        updatedAt: Date.now()
      };

      await ProfileService.writeData(userKey, 'config', nextConfig);

      return {
        success: true,
        subscriptionId: subscription.id,
        planVariationId,
        squareCustomerId,
        squareCardId,
        config: nextConfig
      };
    } catch (error) {
      console.error('AccountService Subscription Failure:', error);
      throw new Error(`Billing initialization failed: ${error.message}`);
    }
  }

  async requestCancellation(userKey, subscriptionId) {
    try {
      await square.subscriptions.cancel({
        subscriptionId: subscriptionId
      });

      const activeConfig = await ProfileService.readData(userKey, 'config', {});
      const nowIso = new Date().toISOString();
      const gracePeriodDays = resolvePositiveInt(process.env.SUBSCRIPTION_GRACE_DAYS, 3);
      const chargedThrough = activeConfig.nextBillingDate ? new Date(activeConfig.nextBillingDate) : null;
      let gracePeriodEndsAt = null;
      if (chargedThrough && !Number.isNaN(chargedThrough.getTime())) {
        gracePeriodEndsAt = new Date(chargedThrough.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000).toISOString();
      }

      await ProfileService.writeData(userKey, 'config', {
        ...activeConfig,
        cancelAtPeriodEnd: true,
        cancellationRequestedAt: nowIso,
        gracePeriodDays,
        gracePeriodEndsAt,
        updatedAt: Date.now()
      });

      return { success: true };
    } catch (error) {
      console.error('AccountService Cancellation Failure:', error);
      throw error;
    }
  }

  async reconcileSubscriptionState(userKey) {
    const currentConfig = await ProfileService.readData(userKey, 'config', {});
    const subscriptionId = String(currentConfig.squareSubscriptionId || '').trim();
    if (!subscriptionId) {
      return { success: true, skipped: true, reason: 'no_subscription_id', config: currentConfig };
    }

    let response;
    try {
      response = await square.subscriptions.get({ subscriptionId });
    } catch (error) {
      logger.warn(`[SQUARE] Failed to reconcile subscription ${subscriptionId} for ${userKey}: ${error.message}`);
      return { success: false, error: error.message, config: currentConfig };
    }

    const subscription = response.subscription || {};
    const normalizedStatus = normalizeSquareSubscriptionStatus(subscription.status || 'UNKNOWN');
    const nextBillingDate = subscription.chargedThroughDate || currentConfig.nextBillingDate || null;
    const nowIso = new Date().toISOString();
    const isInactive = normalizedStatus === 'DEACTIVATED' || normalizedStatus === 'CANCELED';
    const gracePeriodDays = resolvePositiveInt(currentConfig.gracePeriodDays, resolvePositiveInt(process.env.SUBSCRIPTION_GRACE_DAYS, 3));

    let gracePeriodEndsAt = currentConfig.gracePeriodEndsAt || null;
    if (isInactive && nextBillingDate) {
      const chargedThrough = new Date(nextBillingDate);
      if (!Number.isNaN(chargedThrough.getTime())) {
        gracePeriodEndsAt = new Date(chargedThrough.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000).toISOString();
      }
    }

    const nextConfig = {
      ...currentConfig,
      subscriptionStatus: normalizedStatus,
      nextBillingDate,
      cancelAtPeriodEnd: isInactive ? true : (currentConfig.cancelAtPeriodEnd || false),
      gracePeriodDays,
      gracePeriodEndsAt,
      billingTier: isInactive ? 'guest' : (currentConfig.billingTier || 'premium-monthly'),
      lastSquareSyncAt: nowIso,
      updatedAt: Date.now()
    };

    await ProfileService.writeData(userKey, 'config', nextConfig);
    return { success: true, config: nextConfig, subscription: { id: subscriptionId, status: normalizedStatus } };
  }

  async applyWebhookEvent(eventPayload) {
    const eventType = String(eventPayload?.type || '').trim();
    const objectPayload = eventPayload?.data?.object;
    const subscription = objectPayload?.subscription || objectPayload || {};

    if (!eventType.startsWith('subscription.') || !subscription) {
      return { handled: false, reason: 'event_not_subscription' };
    }

    const squareCustomerId = subscription.customerId || subscription.customer_id || null;
    const squareSubscriptionId = subscription.id || subscription.subscription_id || null;
    const normalizedStatus = normalizeSquareSubscriptionStatus(subscription.status || subscription.state || 'UNKNOWN');

    const userKey = await this.findUserBySquareReferences({ squareCustomerId, squareSubscriptionId });
    if (!userKey) {
      return { handled: false, reason: 'user_not_found' };
    }

    const currentConfig = await ProfileService.readData(userKey, 'config', {});
    const nowIso = new Date().toISOString();
    const nextBillingDate = subscription.chargedThroughDate || subscription.charged_through_date || currentConfig.nextBillingDate || null;
    const gracePeriodDays = resolvePositiveInt(currentConfig.gracePeriodDays, resolvePositiveInt(process.env.SUBSCRIPTION_GRACE_DAYS, 3));

    let gracePeriodEndsAt = currentConfig.gracePeriodEndsAt || null;
    if ((normalizedStatus === 'DEACTIVATED' || normalizedStatus === 'CANCELED') && nextBillingDate) {
      const chargedThrough = new Date(nextBillingDate);
      if (!Number.isNaN(chargedThrough.getTime())) {
        gracePeriodEndsAt = new Date(chargedThrough.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000).toISOString();
      }
    }

    const isInactive = normalizedStatus === 'DEACTIVATED' || normalizedStatus === 'CANCELED';

    const nextConfig = {
      ...currentConfig,
      squareCustomerId: squareCustomerId || currentConfig.squareCustomerId || null,
      squareSubscriptionId: squareSubscriptionId || currentConfig.squareSubscriptionId || null,
      subscriptionStatus: normalizedStatus,
      nextBillingDate,
      cancelAtPeriodEnd: isInactive ? true : currentConfig.cancelAtPeriodEnd || false,
      gracePeriodDays,
      gracePeriodEndsAt,
      billingTier: isInactive ? 'guest' : (currentConfig.billingTier || 'premium-monthly'),
      freeAccessActive: Boolean(currentConfig.trialEndsAt && new Date(currentConfig.trialEndsAt).getTime() > Date.now()),
      lastSquareWebhookType: eventType,
      lastSquareWebhookAt: nowIso,
      updatedAt: Date.now()
    };

    await ProfileService.writeData(userKey, 'config', nextConfig);
    return { handled: true, userKey, subscriptionStatus: normalizedStatus };
  }
}

module.exports = new AccountService();