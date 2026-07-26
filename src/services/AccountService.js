// src/services/AccountService.js
const { square, config } = require('../config/square');
const { randomUUID, createHash } = require('crypto');
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

function buildSquareIdempotencyKey(prefix, seed, withNonce = false) {
  const hash = createHash('sha1').update(String(seed || '')).digest('hex').slice(0, 24);
  if (!withNonce) {
    return `${prefix}-${hash}`.slice(0, 45);
  }
  const nonce = randomUUID().replace(/-/g, '').slice(0, 10);
  return `${prefix}-${hash}-${nonce}`.slice(0, 45);
}

function hasSquareErrorCode(error, code) {
  const target = String(code || '').toUpperCase().trim();
  if (!target) return false;

  const bodyErrors = Array.isArray(error?.body?.errors) ? error.body.errors : [];
  const directErrors = Array.isArray(error?.errors) ? error.errors : [];
  const messageText = String(error?.message || '').toUpperCase();

  if (messageText.includes(target)) return true;

  return [...bodyErrors, ...directErrors].some((entry) => {
    return String(entry?.code || '').toUpperCase().trim() === target;
  });
}

class AccountService {
  async findExistingStaticMonthlyVariationId(planId, monthlyPriceCents, currency, variationName) {
    if (!planId) return null;

    let cursor;
    do {
      const response = await square.catalog.search({
        objectTypes: ['SUBSCRIPTION_PLAN_VARIATION'],
        cursor,
        limit: 100
      });

      const objects = Array.isArray(response.objects) ? response.objects : [];
      const match = objects.find((obj) => {
        if (obj?.type !== 'SUBSCRIPTION_PLAN_VARIATION') return false;
        const vData = obj.subscriptionPlanVariationData || {};
        if (String(vData.subscriptionPlanId || '') !== String(planId)) return false;

        const firstPhase = (vData.phases || [])[0] || {};
        const cadence = String(firstPhase.cadence || '').toUpperCase().trim();
        const pricingType = String(firstPhase?.pricing?.type || '').toUpperCase().trim();
        const phaseCurrency = String(firstPhase?.pricing?.priceMoney?.currency || '').toUpperCase().trim();
        const phaseAmount = Number(firstPhase?.pricing?.priceMoney?.amount);
        const currentName = String(vData.name || '').trim();

        if (cadence !== 'MONTHLY' || pricingType !== 'STATIC') return false;
        if (phaseCurrency !== String(currency || '').toUpperCase()) return false;
        if (phaseAmount !== Number(monthlyPriceCents)) return false;

        if (!variationName) return true;
        return currentName.toLowerCase() === String(variationName).toLowerCase().trim();
      });

      if (match?.id) return match.id;
      cursor = response.cursor;
    } while (cursor);

    return null;
  }

  async resolveCurrencyCode() {
    const envCurrency = String(process.env.SQUARE_CURRENCY || '').trim().toUpperCase();
    if (envCurrency) return envCurrency;

    const locationId = String(config.locationId || '').trim();
    if (!locationId) return 'USD';

    try {
      const locationResponse = await square.locations.get({ locationId });
      const locationCurrency = String(locationResponse?.location?.currency || '').trim().toUpperCase();
      return locationCurrency || 'USD';
    } catch (err) {
      logger.warn(`[SQUARE] Could not resolve location currency for ${locationId}: ${err.message}`);
      return 'USD';
    }
  }

  async getStaticMonthlyPlanVariationId() {
    // 1) If the caller already configured a fixed-price variation id, prefer it.
    const configured = String(
      process.env.SQUARE_SANDBOX_PLAN_VARIATION_ID ||
      process.env.SQUARE_PROD_PLAN_VARIATION_ID ||
      process.env.SQUARE_PLAN_VARIATION_ID ||
      ''
    ).trim();
    if (configured) {
      try {
        const details = await this.getCatalogPlanVariationDetails(configured);
        const firstPricingType = String(details?.subscriptionPlanVariationData?.phases?.[0]?.pricing?.type || '').toUpperCase().trim();
        if (firstPricingType === 'STATIC') return configured;
      } catch (_err) {
        // fall through to auto-create
      }
    }

    // 2) Resolve a plan id from the existing monthly variation / subscription plan.
    const existingVariationId = await this.findMonthlyPlanVariationIdFromCatalog();
    const existingVariation = existingVariationId ? await this.getCatalogPlanVariationDetails(existingVariationId) : null;
    const planId = existingVariation?.subscriptionPlanVariationData?.subscriptionPlanId;
    if (!planId) {
      return null;
    }

    const monthlyPriceCents = resolvePositiveInt(process.env.SQUARE_SUBSCRIPTION_PRICE_CENTS, 999);
    const currency = await this.resolveCurrencyCode();
    const variationName = String(
      process.env.SQUARE_SUBSCRIPTION_VARIATION_NAME ||
      process.env.SQUARE_SUBSCRIPTION_NAME_SANDBOX ||
      process.env.SQUARE_SUBSCRIPTION_NAME ||
      'AnySeries Monthly Subscription'
    ).trim();

    const existingStaticVariationId = await this.findExistingStaticMonthlyVariationId(
      planId,
      monthlyPriceCents,
      currency,
      variationName
    );
    if (existingStaticVariationId) {
      return existingStaticVariationId;
    }
    const upsertObject = {
      type: 'SUBSCRIPTION_PLAN_VARIATION',
      id: '#anyseries-monthly-static',
      subscriptionPlanVariationData: {
        name: variationName,
        subscriptionPlanId: planId,
        phases: [
          {
            cadence: 'MONTHLY',
            ordinal: BigInt(0),
            pricing: {
              type: 'STATIC',
              priceMoney: {
                amount: BigInt(monthlyPriceCents),
                currency
              }
            }
          }
        ]
      }
    };
    const keySeed = `${planId}|${monthlyPriceCents}|${currency}|${variationName}`;

    let upsertResponse;
    try {
      upsertResponse = await square.catalog.object.upsert({
        idempotencyKey: buildSquareIdempotencyKey('staticvar', keySeed, false),
        object: upsertObject
      });
    } catch (upsertErr) {
      if (!hasSquareErrorCode(upsertErr, 'IDEMPOTENCY_KEY_REUSED')) {
        throw upsertErr;
      }

      // Fall back to a one-off key when Square rejects a stale reused key.
      upsertResponse = await square.catalog.object.upsert({
        idempotencyKey: buildSquareIdempotencyKey('staticvar', `${keySeed}|retry`, true),
        object: upsertObject
      });
    }

    const createdObject = upsertResponse.catalogObject || upsertResponse.catalog_object || upsertResponse.object || null;
    const createdId = createdObject?.id || null;
    return createdId || null;
  }

  normalizeCatalogVariationPhases(variation) {
    const rawPhases = variation?.subscriptionPlanVariationData?.phases || [];
    return rawPhases
      .map((phase) => {
        const ordinal = Number(phase?.ordinal);
        if (!Number.isFinite(ordinal)) return null;

        const normalized = { ordinal: BigInt(Math.max(0, Math.floor(ordinal))) };
        if (phase?.orderTemplateId) {
          normalized.orderTemplateId = String(phase.orderTemplateId);
        }
        return normalized;
      })
      .filter(Boolean);
  }

  async findMonthlyPlanVariationIdFromCatalog() {
    const targetPlanName = String(
      process.env.SQUARE_SUBSCRIPTION_PLAN_NAME ||
      process.env.SQUARE_SUBSCRIPTION_NAME_SANDBOX ||
      process.env.SQUARE_SUBSCRIPTION_NAME ||
      'AnySeries Streaming Access'
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

  async getCatalogPlanVariationDetails(planVariationId) {
    if (!planVariationId) return null;

    const response = await square.catalog.batchGet({
      objectIds: [planVariationId]
    });

    const objects = Array.isArray(response.objects) ? response.objects : [];
    return objects.find((obj) => obj?.id === planVariationId) || null;
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

      // If the selected variation is relative-pricing, replace it with a static monthly variation.
      let planVariationDetails = null;
      try {
        planVariationDetails = await this.getCatalogPlanVariationDetails(planVariationId);
      } catch (catalogErr) {
        logger.warn(`[SQUARE] Plan variation lookup by id failed: ${catalogErr.message}`);
      }

      const selectedPricingType = String(planVariationDetails?.subscriptionPlanVariationData?.phases?.[0]?.pricing?.type || '').toUpperCase().trim();
      if (selectedPricingType === 'RELATIVE' || !planVariationId) {
        const staticVariationId = await this.getStaticMonthlyPlanVariationId();
        if (staticVariationId) {
          planVariationId = staticVariationId;
          planVariationDetails = await this.getCatalogPlanVariationDetails(planVariationId).catch(() => planVariationDetails);
        }
      }

      if (!config.locationId) {
        throw new Error('Square location ID is missing for current environment.');
      }
      if (!planVariationId) {
        throw new Error('Square plan variation ID is missing. Set SQUARE_SANDBOX_PLAN_VARIATION_ID or SQUARE_PROD_PLAN_VARIATION_ID, or define SQUARE_SUBSCRIPTION_PLAN_NAME/SQUARE_SUBSCRIPTION_NAME_* to auto-discover.');
      }

      const createPhases = this.normalizeCatalogVariationPhases(planVariationDetails);
      const pricingType = String(planVariationDetails?.subscriptionPlanVariationData?.phases?.[0]?.pricing?.type || '').toUpperCase().trim();

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
        idempotencyKey: buildSquareIdempotencyKey('card', `${userKey}|${Date.now()}`, true),
        card: {
          customerId: squareCustomerId,
          referenceId: userKey.toString()
        },
        sourceId: cardNonce
      });
      const squareCardId = cardResponse.card.id;

      // 3. Bind the customer profile to your subscription plan
      const subscriptionResponse = await square.subscriptions.create({
        idempotencyKey: buildSquareIdempotencyKey('sub', `${userKey}|${planVariationId}|${Date.now()}`, true),
        locationId: config.locationId,
        planVariationId,
        customerId: squareCustomerId,
        cardId: squareCardId,
        startDate: toDateOnlyIso(nowIso),
        timezone: process.env.SQUARE_TIMEZONE || 'UTC',
        source: { name: process.env.SQUARE_SOURCE_NAME || 'AnySeries' },
        ...(createPhases.length > 0 ? { phases: createPhases } : {})
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
        subscriptionPlanPricingType: pricingType || null,
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
      const notFound = hasSquareErrorCode(error, 'NOT_FOUND') || hasSquareErrorCode(error, 'BAD_REQUEST');
      if (notFound) {
        const trialEndsAtMs = currentConfig.trialEndsAt ? Date.parse(currentConfig.trialEndsAt) : NaN;
        const trialActive = Number.isFinite(trialEndsAtMs) && trialEndsAtMs > Date.now();
        const nextConfig = {
          ...currentConfig,
          squareSubscriptionId: null,
          squarePlanVariationId: null,
          nextBillingDate: null,
          cancelAtPeriodEnd: false,
          subscriptionStatus: trialActive ? 'TRIAL' : 'GUEST',
          billingTier: trialActive ? 'trial' : 'guest',
          freeAccessActive: trialActive,
          lastSquareSyncAt: new Date().toISOString(),
          updatedAt: Date.now()
        };

        await ProfileService.writeData(userKey, 'config', nextConfig);
        logger.warn(`[SQUARE] Cleared stale subscription reference for ${userKey} (${subscriptionId}).`);
        return {
          success: true,
          staleReferenceCleared: true,
          reason: 'subscription_not_found',
          config: nextConfig
        };
      }

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