const logger = require('../../utils/logger');
const { initRedis } = require('../PipelineQueueService');
const { startPipelineWorker } = require('./PipelineWorker');

async function start() {
    try {
        await initRedis();
    } catch (err) {
        logger.warn(`Pipeline runner Redis init warning: ${err.message}`);
    }

    const intervalMs = parseInt(process.env.PIPELINE_POLL_INTERVAL_MS || '10000', 10);
    logger.info(`Pipeline runner starting with interval ${intervalMs}ms`);
    startPipelineWorker(intervalMs);
}

start().catch((err) => {
    logger.error(`Pipeline runner failed to start: ${err.message}`);
    process.exit(1);
});
