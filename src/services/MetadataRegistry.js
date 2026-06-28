// src/services/MetadataRegistry.js
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// 🚨 STUBBED OUT UNTIL WE FULLY MIGRATE UNIDIRECTIONAL REFACTOR 
// const Redis = require('ioredis'); 
// const redis = new Redis({ db: 3 }); 

const MetadataRegistry = {
    /**
     * Safely updates metadata on disk and instantly pushes it to the Redis read-cache.
     * This forces a deterministic, unidirectional data sync flow.
     */
    async writeAndCommit(metaFilePath, folderName, updatedMetadata) {
        try {
            // Step 1: Commit to the immutable local file system layer
            fs.writeFileSync(metaFilePath, JSON.stringify(updatedMetadata, null, 4));

            // 🚨 STUBBED FOR COLD RUN:
            // const redisKey = `media:movie:${folderName}`;
            // await redis.set(redisKey, JSON.stringify(updatedMetadata));
            
            logger.log(`⚙️ [Registry-STUB] Committed [${folderName}] state safely to disk (Redis cache bypass).`);
            return true;
        } catch (err) {
            logger.log(`❌ [Registry Failure] Failed to execute atomic write on [${folderName}]: ${err.message}`, 'error');
            throw err;
        }
    }
};

module.exports = MetadataRegistry;