require('dotenv').config();
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
        
        logger.info('📦 Initializing Redis Queue...');
        this.signalQueue = new SignalQueue(this);

        // ========== AUTO-LOGIN ADMIN ACCOUNT ==========
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
                    adminClient.connect();
                    this.telegramBot.userConnections.set(primaryAdminId, adminClient);

                    // Set up admin trade callbacks
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

        // ========== AUTO-LOGIN ALL USERS ==========
        try {
            logger.info('👥 Auto-connecting users from database...');
            const users = await this.db.getAllUsers();
            let connectedCount = 0;
            
            for (const user of users) {
                if (user.ssid && !config.telegram.adminIds.includes(user._id)) {
                    try {
                        // Skip if access expired
                        const hasAccess = await this.db.hasValidAccess(user._id);
                        if (!hasAccess) continue;
                        
                        const client = new IQOptionClient(user.email, 'RESTORED_SESSION', user._id, this.db);
                        const loggedIn = await client.login(true);
                        
                        if (loggedIn) {
                            this.telegramBot.userConnections.set(user._id, client);
                            
                            client.onTradeOpened = (tradeData) => {
                                this.telegramBot.handleTradeOpened(user._id, tradeData);
                            };
                            client.onTradeClosed = async (tradeResult) => {
                                this.telegramBot.handleTradeClosed(user._id, tradeResult);
                                try {
                                    const u = await this.db.getUser(user._id);
                                    await this.tradeExecutor.handleResult(user._id, { raw_event: { result: tradeResult.isWin ? 'win' : 'loss' } }, tradeResult, u);
                                } catch (err) { logger.error('Martingale update error:', err.message); }
                            };
                            client.onBalanceChanged = ({ amount, currency, type }) => {
                                this.db.updateUser(user._id, { balance: amount, currency, account_type: type, connected: true });
                            };
                            
                            connectedCount++;
                            // Prevent spamming IQ Option connection endpoint via rate-limiting connection loop
                            await new Promise(resolve => setTimeout(resolve, 250)); 
                        }
                    } catch (err) {
                        logger.warn(`Failed to auto-connect user ${user._id}: ${err.message}`);
                    }
                }
            }
            logger.info(`✅ Auto-connected ${connectedCount} users`);

            // ========== AUTO-LOGIN SUB-ACCOUNTS ==========
            logger.info('👥 Auto-connecting sub-accounts from database...');
            const subAccounts = await this.db.getAllAccounts();
            let subConnectedCount = 0;
            
            for (const acc of subAccounts) {
                if (acc.ssid) {
                    try {
                        const client = new IQOptionClient(acc.email, 'RESTORED_SESSION', acc.owner_id, this.db);
                        const loggedIn = await client.login(true);
                        
                        if (loggedIn) {
                            this.telegramBot.userConnections.set(acc.email, client);
                            
                            client.onTradeOpened = (tradeData) => this.telegramBot.handleTradeOpened(acc.owner_id, tradeData, acc.email);
                            client.onTradeClosed = async (tradeResult) => {
                                this.telegramBot.handleTradeClosed(acc.owner_id, tradeResult, acc.email);
                                try {
                                    // Fetch the latest account data for this specific sub-account
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
                            
                            subConnectedCount++;
                            await new Promise(resolve => setTimeout(resolve, 250)); 
                        }
                    } catch (err) {
                        logger.warn(`Failed to auto-connect sub-account ${acc.email}: ${err.message}`);
                    }
                }
            }
            logger.info(`✅ Auto-connected ${subConnectedCount} sub-accounts`);

        } catch (error) {
            logger.error('Error auto-connecting users/accounts', error);
        }

        // Initialize Webhook Server
        logger.info('📡 Starting Webhook Server...');
        this.webhookServer = new WebhookServer(this);
        this.webhookServer.start();

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
            // Clean up old signals after 60 seconds
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

        const batchSize = 50; // Execute 50 users at a time to prevent rate limits or CPU overload
        
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
                        // Stagger trade placements within the batch (10ms delay per account) to avoid anti-bot detection
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
                // Short break between batches to protect node.js event loop
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