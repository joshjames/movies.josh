// src/services/MetadataRegistry.js
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis'); // Assuming ioredis usage
const redis = new Redis({ db: 3 }); // Using your isolated DB Index path 3
const logger = require('./logger');

const MetadataRegistry = {
    /**
     * Safely updates metadata on disk and instantly pushes it to the Redis read-cache.
     * This forces a deterministic, unidirectional data sync flow.
     */
    async writeAndCommit(metaFilePath, folderName, updatedMetadata) {
        try {
            // Step 1: Commit to the immutable local file system layer
            fs.writeFileSync(metaFilePath, JSON.stringify(updatedMetadata, null, 4));

            // Step 2: Hydrate Redis directly from the freshly written file state
            // Storing as a stringified JSON blob under the asset key keeps your reads lightning fast
            const redisKey = `media:movie:${folderName}`;
            await redis.set(redisKey, JSON.stringify(updatedMetadata));
            
            logger.log(`⚙️ [Registry] Committed [${folderName}] state safely to disk and synchronized Redis cache.`);
            return true;
        } catch (err) {
            logger.log(`❌ [Registry Failure] Failed to execute atomic write on [${folderName}]: ${err.message}`, 'error');
            throw err;
        }
    }
};

module.exports = MetadataRegistry;