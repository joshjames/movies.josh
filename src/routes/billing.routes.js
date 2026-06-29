// src/routes/billing.routes.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');

const USERS_DIR = '/app/storage/users';

// POST: /api/webhooks/square-subscriptions
router.post('/square-subscriptions', (req, res) => {
    // 1. Instantly respond to Square to satisfy their 10-second ACK requirement
    res.sendStatus(200);

    const event = req.body;
    
    // Safety check for target data structures
    if (!event || event.type !== 'subscription.updated' && event.type !== 'subscription.created') {
        return;
    }

    const subscriptionData = event.data?.object?.subscription;
    if (!subscriptionData) return;

    // Use Square's customer ID or a passed reference handle to track your user file
    const squareCustomerId = subscriptionData.customer_id; 
    const status = subscriptionData.status; // e.g., 'ACTIVE', 'CANCELED', 'DEACTIVATED'

    logger.info(`🔔 Square Webhook: Subscription update received for Customer [${squareCustomerId}] -> Status: ${status}`);

    // 2. Locate the databaseless user profile on NVMe storage
    // (If you save the squareCustomerId inside the user's json file on link setup)
    try {
        const userFiles = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
        
        for (const file of userFiles) {
            const filePath = path.join(USERS_DIR, file);
            let userData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

            if (userData.squareCustomerId === squareCustomerId) {
                // 3. Toggle access based on active payment status
                const isPaidUp = (status === 'ACTIVE');
                
                if (userData.hasDonated !== isPaidUp) {
                    userData.hasDonated = isPaidUp;
                    userData.pipelineState = userData.pipelineState || {};
                    userData.pipelineState.lastBillingSync = new Date().toISOString();
                    
                    fs.writeFileSync(filePath, JSON.stringify(userData, null, 4));
                    logger.info(`✅ User [${userData.username}] premium entitlement status flipped to: ${isPaidUp}`);
                }
                break;
            }
        }
    } catch (err) {
        logger.error(`❌ Error processing Square webhook status update: ${err.message}`);
    }
});

module.exports = router;