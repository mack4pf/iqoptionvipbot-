const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config');
const logger = require('../utils/logger');

class SignalQueue {
    constructor(tradingBot) {
        this.tradingBot = tradingBot;
        
        let redisConfig = {};
        if (config.redis.url) {
            // Parse ioredis connection options from URL string properly to prevent warnings
            // or pass directly depending on library, but string is fine
            redisConfig = config.redis.url;
        } else {
            redisConfig = {
                host: config.redis.host,
                port: config.redis.port,
                password: config.redis.password,
                maxRetriesPerRequest: null,
                enableReadyCheck: false
            };
        }

        const connection = new IORedis(redisConfig, { maxRetriesPerRequest: null });

        this.queue = new Queue('SignalExecutionQueue', { connection });

        // Worker to process signal executions asynchronously
        this.worker = new Worker('SignalExecutionQueue', async (job) => {
            const signalData = job.data;
            logger.info(`🏭 Processing Queued Signal: ${signalData.asset} ${signalData.direction} [Job ID: ${job.id}]`);
            
            try {
                await this.tradingBot.executeSignalForAllUsers(signalData);
            } catch (error) {
                logger.error(`❌ Job ${job.id} failed: ${error.message}`);
                throw error;
            }
        }, { connection, concurrency: 1 });

        this.worker.on('completed', job => {
            logger.info(`✅ Job ${job.id} completed successfully`);
        });

        this.worker.on('failed', (job, err) => {
            logger.error(`❌ Job ${job.id} officially failed with error ${err.message}`);
        });
        
        // Also start a queue cleanup
        this.queue.clean(3600000, 1000, 'completed'); // Keep 1hr old, max 1000 completed
    }

    async addSignal(signalData) {
        // Pushes the signal onto Redis BullMQ and returns the execution promise setup
        const job = await this.queue.add('execute-signal', signalData, {
            removeOnComplete: true,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 }
        });
        logger.info(`📦 Signal added to Redis Queue: ${job.id}`);
        return job;
    }

    async shutdown() {
        await this.worker.close();
        await this.queue.close();
    }
}

module.exports = SignalQueue;
