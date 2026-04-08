require('dotenv').config();

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
    if (err.message && err.message.includes('ERR_REQUIRE_ESM')) {
        console.error('FATAL: CommonJS/ESM incompatibility detected.');
    }
});

const config = require('./config');
const MongoDB = require('./database/mongodb');
const TelegramBot = require('./telegram/bot');
const Martingale = require('./trading/martingale');
const TradeExecutor = require('./trading/trade-executor');
const SignalQueue = require('./queue/signal-queue');
const WebhookServer = require('./webhook/server');
const IQOptionClient = require('./iqoption/client');
const logger = require('./utils/logger');

class TradingBot {
    constructor() {
        this.db = null;
        this.telegramBot = null;
        this.martingale = null;
        this.tradeExecutor = null;
        this.signalQueue = null;
        this.webhookServer = null;
        this.recentSignals = new Map();
        this.userLocks = new Set();
    }

    async initialize() {
        logger.info('🚀 STARTING IQ OPTION TRADING BOT');
        logger.info('='.repeat(60));

        // Connect to MongoDB
        logger.info('📁 Connecting to MongoDB...');
        this.db = new MongoDB();
        await this.db.connect();
        await this.db.migrateRealAndNotifications();

        // Initialize Martingale
        this.martingale = new Martingale();

        // Initialize Telegram Bot
        logger.info('🤖 Initializing Telegram Bot...');
        this.telegramBot = new TelegramBot(this.db, this);
        await this.telegramBot.start();

        // Initialize Trade Executor and Queue
        this.tradeExecutor = new TradeExecutor(this.db, this.telegramBot, this.martingale);

        logger.info('📦 Initializing Signal Queue...');
        this.signalQueue = new SignalQueue(this);

        // ========== START WEBHOOK SERVER ==========
        logger.info('📡 Starting Webhook Server...');
        this.webhookServer = new WebhookServer(this);
        this.webhookServer.start();

        // ========== AUTO-LOGIN PRIMARY ADMIN ONLY (NOT ALL USERS) ==========
        const primaryAdminId = config.telegram.adminIds[0];
        if (primaryAdminId && config.iqoption.email && config.iqoption.password) {
            logger.info(`🔌 Auto-logging primary admin account (${primaryAdminId})...`);
            try {
                const adminClient = new IQOptionClient(
                    config.iqoption.email,
                    config.iqoption.password,
                    primaryAdminId,
                    this.db
                );
                const loggedIn = await adminClient.login();
                if (loggedIn) {
                    this.telegramBot.setConnection(primaryAdminId, adminClient);

                    adminClient.onTradeOpened = (tradeData) => {
                        this.telegramBot.handleTradeOpened(primaryAdminId, tradeData);
                    };
                    adminClient.onTradeClosed = async (tradeResult) => {
                        this.telegramBot.handleTradeClosed(primaryAdminId, tradeResult);
                        try {
                            const user = await this.db.getUser(primaryAdminId);
                            await this.tradeExecutor.handleResult(primaryAdminId, { raw_event: { result: tradeResult.isWin ? 'win' : 'loss' } }, tradeResult, user);
                        } catch (err) { logger.error('Martingale update error:', err.message); }
                    };
                    adminClient.onBalanceChanged = ({ amount, currency, type }) => {
                        this.db.updateUser(primaryAdminId, { balance: amount, currency, account_type: type, connected: true });
                    };

                    logger.info('✅ Admin account auto-logged in successfully');
                } else {
                    logger.warn('⚠️ Admin auto-login failed - check credentials in .env');
                }
            } catch (error) {
                logger.error('❌ Admin auto-login error:', error.message);
            }
        } else {
            logger.warn('⚠️ No admin IQ Option credentials in .env - skipping auto-login');
        }

        // AUTO-LOGIN FOR OTHER USERS IS DISABLED FOR FASTER STARTUP
        // Users will login manually via /login command
        logger.info('ℹ️ Auto-login for other users is disabled. Users will login manually via /login');

        logger.info('='.repeat(60));
        logger.info('🎯 BOT IS OPERATIONAL');
        logger.info('✅ TradingView webhook: POST /api/tradingview');
        logger.info('✅ Telegram bot is running');
        logger.info('✅ Admin commands available: /generate, /codes, /users, /revoke, /setduration');
        logger.info('='.repeat(60));
    }

    async executeSignalForAllUsers(signal) {
        // Deduplication
        if (!signal.signalId) {
            logger.warn('⚠️ Signal received without signalId');
        } else {
            const now = Date.now();
            if (this.recentSignals.has(signal.signalId)) {
                logger.info(`⏸️ Duplicate signal ${signal.signalId} ignored`);
                return;
            }
            this.recentSignals.set(signal.signalId, now);
            for (const [id, ts] of this.recentSignals) {
                if (now - ts > 60000) this.recentSignals.delete(id);
            }
        }

        logger.info(`📢 Executing signal: ${signal.asset} ${signal.direction} for ${signal.duration} min`);

        if (!this.telegramBot) {
            logger.info('⚠️ Telegram bot not available');
            return;
        }

        const clients = this.telegramBot.getAllConnectedClients();
        logger.info(`👥 Found ${clients.length} connected user(s)`);

        if (clients.length === 0) {
            logger.info('⚠️ No connected users');
            return;
        }

        const batchSize = 50;

        for (let i = 0; i < clients.length; i += batchSize) {
            const batch = clients.slice(i, i + batchSize);
            const batchPromises = batch.map(({ userId, client, email }, index) => {
                return (async () => {
                    const lockKey = email || userId;
                    if (this.userLocks.has(lockKey)) {
                        logger.info(`⏸️ Account ${lockKey} already processing a trade`);
                        return;
                    }

                    this.userLocks.add(lockKey);

                    try {
                        if (index > 0) await new Promise(resolve => setTimeout(resolve, index * 10));

                        let accountData = null;
                        if (email) {
                            const accounts = await this.db.getAccounts(userId);
                            accountData = accounts.find(a => a.email === email);
                        } else {
                            accountData = await this.db.getUser(userId);
                        }

                        if (accountData && accountData.autoTraderEnabled === false) {
                            logger.info(`⏸️ Account ${email || userId} has auto-trader disabled`);
                            return;
                        }

                        const result = await this.tradeExecutor.execute(userId, client, signal, accountData || {});
                        if (result.success) {
                            logger.info(`✅ Trade placed for ${email || userId}: ${result.amount}`);
                        } else {
                            logger.info(`❌ Trade failed for ${email || userId}: ${result.error}`);
                        }
                    } catch (error) {
                        logger.error(`Error for ${email || userId}:`, error.message);
                    } finally {
                        this.userLocks.delete(lockKey);
                    }
                })();
            });

            await Promise.all(batchPromises);

            if (i + batchSize < clients.length) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        logger.info(`✅ Signal execution complete for ${clients.length} users`);
    }

    async shutdown() {
        logger.info('\n🛑 Shutting down...');
        if (this.db) await this.db.close();
        if (this.signalQueue) await this.signalQueue.shutdown();
        process.exit(0);
    }
}

const bot = new TradingBot();

process.on('SIGINT', () => bot.shutdown());
process.on('SIGTERM', () => bot.shutdown());

bot.initialize().catch(error => {
    logger.error('❌ Fatal error:', error);
    process.exit(1);
});