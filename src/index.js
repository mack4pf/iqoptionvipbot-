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
        // This prevents Render from timing out with a 502 Bad Gateway during slow startup tasks (like connecting to multiple accounts)
        logger.info('📡 Starting Webhook Server...');
        this.webhookServer = new WebhookServer(this);
        this.webhookServer.start();

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

        // ========== AUTO-LOGIN PRIMARY ADMIN ACCOUNT ==========
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

        // ========== FORCE RECONNECT ALL SUB-ACCOUNTS FROM DATABASE ==========
        logger.info('👥 FORCE RECONNECTING ALL SUB-ACCOUNTS FROM DATABASE...');

        try {
            const allAccounts = await this.db.getAllAccounts();
            logger.info(`📊 Found ${allAccounts.length} sub-accounts in database`);

            let connectedCount = 0;
            let failedCount = 0;

            for (const acc of allAccounts) {
                try {
                    logger.info(`🔄 Attempting to restore account: ${acc.email}`);

                    const client = new IQOptionClient(acc.email, 'RESTORED_SESSION', acc.owner_id, this.db);
                    


                    const loggedIn = await client.login(true);

                    if (loggedIn) {
                        client.accountType = 'REAL';
                        client.refreshProfile();

                        client.onTradeOpened = (tradeData) => {
                            this.telegramBot.handleTradeOpened(acc.owner_id, tradeData, acc.email);
                        };
                        client.onTradeClosed = async (tradeResult) => {
                            this.telegramBot.handleTradeClosed(acc.owner_id, tradeResult, acc.email);
                            try {
                                const accounts = await this.db.getAccounts(acc.owner_id);
                                const accountData = accounts.find(a => a.email === acc.email);
                                if (accountData) {
                                    await this.tradeExecutor.handleResult(acc.owner_id, { raw_event: { result: tradeResult.isWin ? 'win' : 'loss' } }, tradeResult, accountData);
                                }
                            } catch (err) { logger.error(`Martingale update error for ${acc.email}:`, err.message); }
                        };
                        client.onBalanceChanged = ({ amount, currency, type }) => {
                            this.db.updateAccount(acc.email, { balance: amount, currency, account_type: type, connected: true });

                        };

                        this.telegramBot.userConnections.set(acc.email, client);
                        await this.db.updateAccount(acc.email, { connected: true });

                        connectedCount++;
                        logger.info(`✅ Successfully restored account: ${acc.email}`);
                    } else {
                        failedCount++;
                        logger.warn(`❌ Failed to restore account: ${acc.email} - login returned false`);
                    }

                    await new Promise(resolve => setTimeout(resolve, 500));

                } catch (err) {
                    failedCount++;
                    logger.error(`❌ Error restoring account ${acc.email}: ${err.message}`);
                }
            }

            logger.info(`✅ Sub-account restoration complete: ${connectedCount} connected, ${failedCount} failed`);
            logger.info(`📊 Total accounts in userConnections: ${this.telegramBot.userConnections.size}`);

        } catch (error) {
            logger.error('❌ Error during sub-account restoration:', error);
        }

        // ========== ALSO CHECK FOR ACCOUNTS IN USERS COLLECTION (LEGACY) ==========
        logger.info('👥 Checking for legacy users in users collection...');
        try {
            const allUsers = await this.db.getAllUsers();
            let legacyConnected = 0;

            for (const user of allUsers) {
                if (config.telegram.adminIds.includes(user._id)) continue;
                if (this.telegramBot.userConnections.has(user.email)) continue;

                if (user.ssid) {
                    try {
                        const client = new IQOptionClient(user.email, 'RESTORED_SESSION', user._id, this.db);
                        const loggedIn = await client.login(true);
                        if (loggedIn) {
                            client.accountType = 'REAL';
                            client.refreshProfile();
                            client.onTradeOpened = (tradeData) => {
                                this.telegramBot.handleTradeOpened(user._id, tradeData);
                            };
                            client.onTradeClosed = async (tradeResult) => {
                                this.telegramBot.handleTradeClosed(user._id, tradeResult);
                            };
                            client.onBalanceChanged = ({ amount, currency, type }) => {
                                this.db.updateUser(user._id, { balance: amount, currency, account_type: type, connected: true });
                            };
                            this.telegramBot.userConnections.set(user.email, client);
                            legacyConnected++;
                            logger.info(`✅ Restored legacy user: ${user.email}`);
                        }
                    } catch (err) {
                        logger.warn(`Failed to restore legacy user ${user.email}: ${err.message}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            logger.info(`✅ Legacy users restored: ${legacyConnected}`);
        } catch (error) {
            logger.error('Error restoring legacy users:', error);
        }

        logger.info('='.repeat(60));
        logger.info('🎯 BOT IS OPERATIONAL');
        logger.info(`📊 Total connected accounts: ${this.telegramBot.userConnections.size}`);
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

                        // Single fast DB lookup - no retry loop (retries cause event loop starvation)
                        const accounts = await this.db.getAccounts(userId);
                        let accountData = accounts.find(a => a.email.toLowerCase() === email.toLowerCase());

                        // If not in accounts collection, fall back to client state immediately
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