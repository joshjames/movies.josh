// src/services/AccountService.js
const { square, config } = require('../config/square');

class AccountService {
  async initializeSubscription(userId, { name, email, cardNonce }) {
    try {
      // 1. Register or find the customer profile inside Square's engine
      const customerResponse = await square.customers.create({
        givenName: name.split(' ')[0] || name,
        familyName: name.split(' ')[1] || '',
        emailAddress: email,
        referenceId: userId.toString()
      });
      const squareCustomerId = customerResponse.customer.id;

      // 2. Attach the secure card token safely to their Customer profile
      const cardResponse = await square.cards.create({
        card: {
          customerId: squareCustomerId,
          referenceId: userId.toString()
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

      // 4. Commit values smoothly into your local user database
      const updatedUser = await db.users.update(userId, {
        squareCustomerId: squareCustomerId,
        squareSubscriptionId: subscriptionResponse.subscription.id,
        subscriptionStatus: 'ACTIVE',
        billingTier: 'premium'
      });

      return { success: true, user: updatedUser };
    } catch (error) {
      console.error('AccountService Subscription Failure:', error);
      throw new Error(`Billing initialization failed: ${error.message}`);
    }
  }

  async requestCancellation(userId, subscriptionId) {
    try {
      await square.subscriptions.cancel({
        subscriptionId: subscriptionId
      });

      await db.users.update(userId, {
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