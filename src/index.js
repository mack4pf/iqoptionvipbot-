require('dotenv').config();

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
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

        // ========== START WEBHOOK SERVER EARLY ==========
        logger.info('📡 Starting Webhook Server...');
        this.webhookServer = new WebhookServer(this);
        this.webhookServer.start();

        // Connect to MongoDB
        logger.info('📁 Connecting to MongoDB...');
        this.db = new MongoDB();
        await this.db.connect();
        await this.db.clearAllSessions(); // 🧹 Wipe all old SSIDs
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

        // ========== AUTO-LOGIN PRIMARY ADMIN ACCOUNT (OPTIONAL) ==========
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
        }

        // ❌ ALL SUB-ACCOUNT AND LEGACY USER RESTORATION LOOPS REMOVED
        // No automatic connections – users must manually /login each account

        logger.info('='.repeat(60));
        logger.info('🎯 BOT IS OPERATIONAL');
        logger.info(`📊 Connected accounts: ${this.telegramBot.userConnections.size} (manual logins only)`);
        logger.info('✅ TradingView webhook: POST /api/tradingview');
        logger.info('✅ Telegram bot is running');
        logger.info('='.repeat(60));
    }

    async executeSignalForAllUsers(signal) {
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

        const clients = [];
        for (const [email, client] of this.telegramBot.userConnections) {
            const isConnected = client.connected === true || (client.ws && client.ws.readyState === 1);
            if (isConnected) {
                clients.push({ userId: client.chatId, client, email });
                logger.info(`✅ Account ready for trading: ${email}`);
            } else {
                logger.warn(`⚠️ Account not ready: ${email} (connected=${client.connected}, ws=${client.ws?.readyState})`);
            }
        }

        logger.info(`👥 Found ${clients.length} connected account(s) ready to trade`);

        if (clients.length === 0) {
            logger.info('⚠️ No connected accounts');
            return;
        }

        const batchSize = 50;

        for (let i = 0; i < clients.length; i += batchSize) {
            const batch = clients.slice(i, i + batchSize);
            const batchPromises = batch.map(({ userId, client, email }, index) => {
                return (async () => {
                    const lockKey = email;
                    if (this.userLocks.has(lockKey)) {
                        logger.info(`⏸️ Account ${email} already processing a trade`);
                        return;
                    }

                    this.userLocks.add(lockKey);

                    try {
                        if (index > 0) await new Promise(resolve => setTimeout(resolve, index * 10));

                        const accounts = await this.db.getAccounts(userId);
                        let accountData = accounts.find(a => a.email.toLowerCase() === email.toLowerCase());

                        if (!accountData) {
                            logger.warn(`⚠️ No account data for ${email} - using client state`);
                            accountData = {
                                email,
                                tradeAmount: client.tradeAmount || 1500,
                                martingale_enabled: true,
                                account_type: client.accountType || 'REAL',
                                autoTraderEnabled: true,
                                currency: client.currency || 'USD',
                                balance: client.balance || 0,
                                stats: { total_trades: 0, wins: 0, losses: 0, total_profit: 0 },
                                martingale: { current_step: 0, current_amount: client.tradeAmount || 1500, loss_streak: 0, base_amount: client.tradeAmount || 1500, initial_balance: 0 }
                            };
                        }

                        if (accountData.autoTraderEnabled === false) {
                            logger.info(`⏸️ Account ${email} has auto-trader disabled`);
                            return;
                        }

                        const result = await this.tradeExecutor.execute(userId, client, signal, accountData);
                        if (result.success) {
                            logger.info(`✅ Trade placed for ${email}: ${result.amount}`);
                        } else {
                            logger.info(`❌ Trade failed for ${email}: ${result.error}`);
                        }
                    } catch (error) {
                        logger.error(`Error for ${email}:`, error.message);
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

        logger.info(`✅ Signal execution complete for ${clients.length} accounts`);
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