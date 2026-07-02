// src/services/AccountService.js
const { square, config } = require('../config/square');
const ProfileService = require('./ProfileService');

class AccountService {
  async initializeSubscription(userKey, { name, email, cardNonce }) {
    try {
      const activeConfig = await ProfileService.readData(userKey, 'config', {});
      const resolvedEmail = String(email || activeConfig.email || userKey).trim().toLowerCase();
      const resolvedName = String(name || activeConfig.displayName || activeConfig.name || activeConfig.username || resolvedEmail).trim();

      // 1. Register or find the customer profile inside Square's engine
      const customerResponse = await square.customers.create({
        givenName: resolvedName.split(' ')[0] || resolvedName,
        familyName: resolvedName.split(' ').slice(1).join(' ') || '',
        emailAddress: resolvedEmail,
        referenceId: userKey.toString()
      });
      const squareCustomerId = customerResponse.customer.id;

      // 2. Attach the secure card token safely to their Customer profile
      const cardResponse = await square.cards.create({
        card: {
          customerId: squareCustomerId,
          referenceId: userKey.toString()
        },
        sourceId: cardNonce
      });
      const squareCardId = cardResponse.card.id;

      // 3. Bind the customer profile to your subscription plan
      const subscriptionResponse = await square.subscriptions.create({
        idempotencyKey: `sub-${userId}-${Date.now()}`,
        locationId: config.locationId, // Extracted safely from our central config module
        planVariationId: process.env.SQUARE_PLAN_VARIATION_ID,
        customerId: squareCustomerId,
        cardId: squareCardId
      });

      const nextConfig = {
        ...activeConfig,
        email: resolvedEmail,
        displayName: resolvedName,
        name: resolvedName,
        squareCustomerId: squareCustomerId,
        squareSubscriptionId: subscriptionResponse.subscription.id,
        subscriptionStatus: 'ACTIVE',
        billingTier: 'premium',
        cancelAtPeriodEnd: false,
        nextBillingDate: subscriptionResponse.subscription?.chargedThroughDate || null,
        updatedAt: Date.now()
      };

      await ProfileService.writeData(userKey, 'config', nextConfig);

      return { success: true, subscriptionId: subscriptionResponse.subscription.id, config: nextConfig };
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
      await ProfileService.writeData(userKey, 'config', {
        ...activeConfig,
        cancelAtPeriodEnd: true
      });

      return { success: true };
    } catch (error) {
      console.error('AccountService Cancellation Failure:', error);
      throw error;
    }
  }
}

module.exports = new AccountService();