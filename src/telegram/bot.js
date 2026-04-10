const { Telegraf, Markup, session } = require('telegraf');
const config = require('../config');
const logger = require('../utils/logger');
const { getCurrencySymbol } = require('../utils/helpers');
const IQOptionClient = require('../iqoption/client');
const { default: PQueue } = require('p-queue');

class TelegramBot {
    constructor(db, tradingBot) {
        console.log("[DEBUG] 1 - Starting constructor");
        this.bot = new Telegraf(config.telegram.token);
        console.log("[DEBUG] 2 - Telegraf instance created");
        this.bot.use(session());
        console.log("[DEBUG] 3 - Session middleware added");

        this.db = db;
        this.tradingBot = tradingBot;
        this.userConnections = new Map();
        this.loginQueue = new PQueue({ concurrency: 5 });
        this.recentNotifications = new Map();
        console.log("[DEBUG] 4 - Maps and queues initialized");

        this.setupMiddleware();
        console.log("[DEBUG] 5 - setupMiddleware called");
        this.setupMenus();
        console.log("[DEBUG] 6 - setupMenus called");
        this.setupCommands();
        console.log("[DEBUG] 7 - setupCommands called");
        this.setupHandlers();
        console.log("[DEBUG] 8 - setupHandlers called");

        this.bot.catch((err, ctx) => {
            logger.error(`Telegraf error: ${err.message}`);
        });
        console.log("[DEBUG] 9 - bot.catch set");
    }

    setConnection(chatId, client) {
        const key = chatId.toString();
        const oldClient = this.userConnections.get(key);
        if (oldClient && oldClient !== client) {
            logger.info(`♻️ Replacing existing client for ${key} - destroying old instances to free RAM`);
            oldClient.destroy();
        }
        this.userConnections.set(key, client);
    }

    removeConnection(chatId) {
        const key = chatId.toString();
        const client = this.userConnections.get(key);
        if (client) {
            client.destroy();
            this.userConnections.delete(key);
        }
    }

    async start() {
        console.log("[DEBUG] 10 - start() called");
        this.bot.launch().catch(err => {
            logger.error(`Failed to launch Telegram bot: ${err.message}`);
        });
        console.log("[DEBUG] 11 - bot launched (background)");
        logger.info('🤖 Telegram bot started');
    }

    setupMiddleware() {
        this.bot.use(async (ctx, next) => {
            try {
                ctx.db = this.db;
                ctx.tradingBot = this.tradingBot;
                if (!ctx.state) ctx.state = {};

                const userId = ctx.from?.id?.toString();
                if (userId) {
                    ctx.state.user = await this.db.getUser(userId);
                    if (!ctx.state.user && config.telegram.adminIds.includes(userId)) {
                        await this.db.ensureAdminUser();
                        ctx.state.user = await this.db.getUser(userId);
                    }
                }
                return next();
            } catch (error) {
                logger.error('Middleware error:', error);
                return next();
            }
        });
    }

    setupMenus() {
        this.adminMainMenu = Markup.keyboard([
            ['🎫 Generate Code', '📋 List Codes'],
            ['👥 List Users', '🔴 Revoke User'],
            ['📢 Add Channel', '📢 Remove Channel'],
            ['⏱️ Set Duration', '📊 System Stats'],
            ['🏠 Main Menu']
        ]).resize();

        this.userMainMenu = Markup.keyboard([
            ['💰 Balance', '📊 My Stats'],
            ['💰 Set Amount', '🤖 Martingale'],
            ['📈 Practice Mode', '💵 Real Mode'],
            ['🔌 Status', '🏠 Main Menu']
        ]).resize();
    }

    setupCommands() {
        // START COMMAND
        this.bot.start(async (ctx) => {
            const args = ctx.message.text.split(' ');
            const code = args[1];

            if (!code) {
                const welcomeMsg =
                    '🤖 *Welcome to IQ Option Auto-Trading Bot!*\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
                    '📺 *COMPLETE VIDEO GUIDE*\n' +
                    'https://youtu.be/tePDDjJnMuM\n\n' +
                    'To start trading, you need two things:\n\n' +
                    '*1️⃣ Create an IQ Option Account*\n' +
                    '👉 [Click Here to Register](https://affiliate.iqoption.net/redir/?aff=785369&aff_model=revenue&afftrack=)\n\n' +
                    '*2️⃣ Get an Access Code*\n' +
                    'Contact admin for access code\n\n' +
                    '*3️⃣ Activate Your Code*\n' +
                    'Send: `/start IQ-XXXX-XXXX-XXXX`\n\n' +
                    '━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
                    '_Need help? Contact ADMIN_';
                return ctx.reply(welcomeMsg, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: false
                });
            }

            try {
                const existingUser = await this.db.getUser(ctx.from.id);
                if (existingUser) {
                    return ctx.reply('❌ You are already registered!');
                }

                const accessCode = await this.db.validateAccessCode(code);
                if (!accessCode) {
                    return ctx.reply('❌ *Invalid or expired access code!*', { parse_mode: 'Markdown' });
                }

                ctx.session = { pendingCode: code };
                await ctx.reply(
                    '✅ *Access Code Accepted!*\n' +
                    '━━━━━━━━━━━━━━━\n\n' +
                    'Now connect your IQ Option account.\n\n' +
                    '*Send this command:*\n' +
                    '`/login your@email.com yourpassword`\n\n' +
                    '*Example:*\n' +
                    '`/login trader@gmail.com MyPass123`\n\n' +
                    '⚠️ Use your exact IQ Option credentials.\n' +
                    '_Your password is encrypted and stored securely._',
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                ctx.reply('❌ Registration failed: ' + error.message);
            }
        });

        // LOGIN COMMAND - Supports multiple accounts, saves to accounts collection
        this.bot.command('login', async (ctx) => {
            const args = ctx.message.text.split(' ');
            if (args.length < 3) {
                return ctx.reply('❌ *Usage:* `/login email password`\n\nYou can use this command multiple times to add multiple accounts.', { parse_mode: 'Markdown' });
            }

            const email = args[1];
            const password = args.slice(2).join(' ');
            let user = await this.db.getUser(ctx.from.id);
            const pendingCode = ctx.session?.pendingCode;

            if (!user && !pendingCode) {
                return ctx.reply('❌ Please `/start` with an access code first.');
            }

            const statusMsg = await ctx.reply(`🔐 Connecting ${email}...`);

            try {
                const iqClient = new IQOptionClient(email, password, ctx.from.id, this.db);
                const loginPromise = iqClient.login(true);
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 20s')), 20000));
                const loggedIn = await Promise.race([loginPromise, timeoutPromise]);

                if (!loggedIn) {
                    await ctx.deleteMessage(statusMsg.message_id);
                    return ctx.reply(`❌ Login failed for ${email}. Check credentials.`);
                }

                if (!user && pendingCode) {
                    await this.db.registerUserWithCode(ctx.from.id, email, password, pendingCode);
                    user = await this.db.getUser(ctx.from.id);
                    ctx.session.pendingCode = null;
                }

                // Force REAL account
                iqClient.accountType = 'REAL';
                iqClient.refreshProfile();

                // Wait for profile to load
                let retries = 0;
                while ((iqClient.realBalance === 0 || !iqClient.realCurrency) && retries < 10) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    retries++;
                }

                // Save this account to the accounts collection if not already present
                const existingAccount = await this.db.getAccountByEmail(email);
                if (!existingAccount) {
                    await this.db.addAccount(ctx.from.id, email, password, 'REAL', 1500);
                    logger.info(`💾 Saved sub‑account ${email} to accounts collection`);
                } else {
                    await this.db.updateAccount(email, { connected: true, ssid: iqClient.ssid });
                }

                iqClient.onTradeOpened = (tradeData) => {
                    this.handleTradeOpened(ctx.from.id, tradeData, email);
                };
                iqClient.onTradeClosed = (tradeResult) => {
                    this.handleTradeClosed(ctx.from.id, tradeResult, email);
                };
                iqClient.onBalanceChanged = ({ amount, currency }) => {
                    this.db.updateAccount(email, { balance: amount, currency, connected: true });
                    logger.info(`💰 Account ${email}: Balance updated to ${currency}${amount}`);
                };

                this.userConnections.set(email, iqClient);
                await this.db.updateAccount(email, { connected: true });

                await ctx.deleteMessage(statusMsg.message_id);

                const symbol = getCurrencySymbol(iqClient.realCurrency || 'USD');
                const realBal = iqClient.realBalance.toLocaleString();
                const practiceSymbol = getCurrencySymbol(iqClient.practiceCurrency || 'USD');
                const practiceBal = iqClient.practiceBalance.toLocaleString();

                await ctx.reply(
                    `✅ *Connected: ${email}*\n` +
                    `━━━━━━━━━━━━━━━\n` +
                    `💰 *REAL:* ${symbol}${realBal}\n` +
                    `🧪 *PRACTICE:* ${practiceSymbol}${practiceBal}\n\n` +
                    `_Ready to trade._`,
                    { parse_mode: 'Markdown' }
                );

            } catch (error) {
                await ctx.deleteMessage(statusMsg.message_id);
                ctx.reply(`❌ Login failed for ${email}: ${error.message}`);
            }
        });

        // BALANCE COMMAND
        this.bot.command('balance', async (ctx) => {
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ Not connected. Use /login first.');

            let message = `💰 *Account Balances*\n━━━━━━━━━━━━━━━\n`;
            for (const client of userAccounts) {
                const connected = client?.ws?.readyState === 1;
                if (connected) {
                    client.refreshProfile();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                const realSymbol = getCurrencySymbol(client.realCurrency || 'USD');
                const practiceSymbol = getCurrencySymbol(client.practiceCurrency || 'USD');
                const activeSymbol = getCurrencySymbol(client.currency || 'USD');
                const activeType = client.accountType === 'REAL' ? '🔥 REAL' : '🧪 PRACTICE';
                const status = connected ? '🟢' : '🔴';

                message += `\n${status} *${client.email}*\n`;
                message += `💵 REAL: ${realSymbol}${client.realBalance.toLocaleString()}\n`;
                message += `💵 PRACTICE: ${practiceSymbol}${client.practiceBalance.toLocaleString()}\n`;
                message += `🎯 Active: ${activeType} (${activeSymbol}${client.balance.toLocaleString()})\n`;
                message += `━━━━━━━━━━━━━━━\n`;
            }
            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        // STATUS COMMAND
        this.bot.command('status', async (ctx) => {
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ Not connected. Use /login first.');

            const user = ctx.state.user;
            const expires = user?.access_expires_at ? new Date(user.access_expires_at).toLocaleDateString() : 'N/A';

            let message = `📊 *Connection Status*\n━━━━━━━━━━━━━━━\n\n`;
            for (const client of userAccounts) {
                const connected = client?.ws?.readyState === 1;
                if (connected) client.refreshProfile();
                const symbol = getCurrencySymbol(client.realCurrency || client.currency || 'USD');
                message += `📧 *${client.email}*\n`;
                message += `🔌 Status: ${connected ? '✅ Connected' : '❌ Disconnected'}\n`;
                message += `💳 Mode: ${client.accountType === 'REAL' ? '🔥 REAL' : '🧪 PRACTICE'}\n`;
                message += `💰 Real Balance: ${symbol}${client.realBalance.toLocaleString()}\n`;
                message += `━━━━━━━━━━━━━━━\n`;
            }
            message += `📅 Access Expires: ${expires}\n`;
            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        // SET AMOUNT COMMAND (single account) - FIXED to update both users and accounts
        this.bot.command('setamount', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first');
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                // Get current amount and currency from user's record or from connected client
                const current = ctx.state.user.tradeAmount || 1500;
                const client = this.userConnections.get(ctx.state.user.email);
                const currency = client?.realCurrency || ctx.state.user.currency || 'USD';
                const symbol = getCurrencySymbol(currency);
                return ctx.reply(`💰 *Current amount:* ${symbol}${current}\n\n/setamount [amount]`, { parse_mode: 'Markdown' });
            }
            const amount = parseFloat(args[1]);
            if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Enter a valid amount');

            // Update users collection
            await this.db.updateUser(ctx.from.id, { tradeAmount: amount, 'martingale.base_amount': amount });

            // Also update the corresponding account in accounts collection (by email)
            const user = await this.db.getUser(ctx.from.id);
            if (user && user.email) {
                await this.db.updateAccount(user.email, { tradeAmount: amount, 'martingale.base_amount': amount }).catch(() => { });
                // Update in-memory client
                const client = this.userConnections.get(user.email);
                if (client) client.tradeAmount = amount;
            }

            // Get proper currency symbol
            const client = this.userConnections.get(ctx.state.user.email);
            const currency = client?.realCurrency || ctx.state.user.currency || 'USD';
            const symbol = getCurrencySymbol(currency);
            ctx.reply(`✅ Trade amount set to ${symbol}${amount} (Martingale base reset)`);
        });

        this.bot.command('stopnotifications', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first.');
            const current = ctx.state.user.notifications_enabled !== false;
            await this.db.updateUser(ctx.from.id, { notifications_enabled: !current });
            ctx.reply(current ? '🔕 Notifications stopped. You will no longer receive trade alerts.' : '🔔 Notifications resumed. (Commands still work)');
        });

        // MARTINGALE COMMAND
        this.bot.command('martingale', async (ctx) => {
            const user = ctx.state.user;
            if (!user) return ctx.reply('❌ Please login first');

            const userAccounts = this.getClientsByUserId(ctx.from.id);
            const client = userAccounts.find(c => c.email === user.email) || userAccounts[0];
            const isEnabled = user.martingale_enabled !== false;
            const currency = client?.currency || user?.currency || 'USD';
            const symbol = getCurrencySymbol(currency);
            const baseAmount = user.martingale?.base_amount || user.tradeAmount || 1500;
            const step = user.martingale?.current_step || 0;
            const losses = user.martingale?.loss_streak || 0;

            const multipliers = config.trading.martingaleMultipliers;
            const sequence = multipliers.map((m, i) => {
                const amt = baseAmount * m;
                const isCurrent = i === step && losses > 0;
                return `${isCurrent ? '▶️' : `${i + 1}.`} ${symbol}${amt.toLocaleString()}${isCurrent ? ' ← current' : ''}`;
            }).join('\n');

            const message =
                `🤖 *Martingale Strategy*\n` +
                `━━━━━━━━━━━━━━━\n` +
                `Status: ${isEnabled ? '✅ ON' : '🔴 OFF'}\n` +
                `💰 Base: ${symbol}${baseAmount.toLocaleString()}\n` +
                `📉 Step: ${step + 1}/${config.trading.maxSteps} | Losses: ${losses}\n\n` +
                `*Sequence:*\n${sequence}\n\n` +
                `_Win → reset to base_\n` +
                `_${config.trading.maxSteps} losses → auto-reset_`;

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(isEnabled ? '🔴 Turn OFF' : '✅ Turn ON', isEnabled ? 'martingale_off' : 'martingale_on')],
                    [Markup.button.callback('🔄 Reset to Base', 'martingale_reset')]
                ])
            });
        });

        // ACCOUNT SWITCHING (single account)
        this.bot.command('practice', async (ctx) => {
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ Please /login first');
            for (const client of userAccounts) {
                client.accountType = 'PRACTICE';
                client.refreshProfile();
                await this.db.updateAccount(client.email, { account_type: 'PRACTICE' });
            }
            await this.db.updateUser(ctx.from.id, { account_type: 'PRACTICE' });
            ctx.reply(`✅ Switched ${userAccounts.length} accounts to PRACTICE account`);
        });

        this.bot.command('real', async (ctx) => {
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ Please /login first');
            await ctx.reply(
                `⚠️ *WARNING: Switching ${userAccounts.length} accounts to REAL*\n\nThis uses real money. Are you sure?`,
                { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yes', 'confirm_real'), Markup.button.callback('❌ Cancel', 'cancel_real')]]) }
            );
        });

        // Switch ALL connected accounts to PRACTICE
        this.bot.command('practiceall', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');

            let switchedCount = 0;
            let failedCount = 0;

            for (const [email, client] of this.userConnections) {
                try {
                    client.accountType = 'PRACTICE';
                    client.refreshProfile();
                    await this.db.updateAccount(email, { account_type: 'PRACTICE' });
                    switchedCount++;
                    logger.info(`✅ Switched ${email} to PRACTICE mode`);
                } catch (err) {
                    failedCount++;
                    logger.error(`❌ Failed to switch ${email}: ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 100));
            }

            await ctx.reply(
                `✅ *Switched ${switchedCount} accounts to PRACTICE mode*\n` +
                `❌ Failed: ${failedCount}\n\n` +
                `_All trades will now use demo balance._`,
                { parse_mode: 'Markdown' }
            );
        });

        // Switch ALL connected accounts to REAL (with confirmation)
        this.bot.command('realall', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');

            await ctx.reply(
                '⚠️ *WARNING: Switching ALL accounts to REAL mode*\n\n' +
                'This will use REAL money for ALL connected accounts.\n\n' +
                'Are you absolutely sure?',
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✅ YES, switch all to REAL', 'confirm_realall')],
                        [Markup.button.callback('❌ Cancel', 'cancel_realall')]
                    ])
                }
            );
        });

        // STATS COMMAND
        this.bot.command('stats', async (ctx) => {
            const user = ctx.state.user;
            if (!user) return ctx.reply('❌ Please login first');
            const stats = user.stats || { total_trades: 0, wins: 0, losses: 0, total_profit: 0 };
            const winRate = stats.total_trades > 0 ? ((stats.wins / stats.total_trades) * 100).toFixed(1) : 0;
            ctx.reply(
                `📊 *Your Stats*\n━━━━━━━━━━━━━━━\n` +
                `Trades: ${stats.total_trades}\n` +
                `Wins: ${stats.wins}\n` +
                `Losses: ${stats.losses}\n` +
                `Win Rate: ${winRate}%\n` +
                `Profit: $${stats.total_profit.toFixed(2)}`,
                { parse_mode: 'Markdown' }
            );
        });

        // OTHER COMMANDS
        this.bot.command('logout', async (ctx) => {
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ No active connections.');
            for (const client of userAccounts) {
                await client.logout();
                this.userConnections.delete(client.email);
            }
            ctx.reply('👋 All accounts logged out');
        });

        this.bot.command('myid', async (ctx) => {
            ctx.reply(`Your ID: \`${ctx.from.id}\``, { parse_mode: 'Markdown' });
        });

        this.bot.command('menu', async (ctx) => {
            if (ctx.state.user?.is_admin) {
                await ctx.reply('🏠 Admin Menu', this.adminMainMenu);
            } else if (ctx.state.user) {
                await ctx.reply('🏠 Main Menu', this.userMainMenu);
            } else {
                await ctx.reply('👋 Welcome! Use /start to begin.');
            }
        });

        // ADMIN COMMANDS (including fixed /setallamounts)
        this.bot.command('generate', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');
            const code = await this.db.createAccessCode(ctx.from.id);
            ctx.reply(`✅ *New Access Code*\n\n\`${code}\`\n\nValid for 30 days`, { parse_mode: 'Markdown' });
        });

        this.bot.command('codes', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const codes = await this.db.getActiveCodes();
            if (codes.length === 0) return ctx.reply('📭 No active codes.');
            let message = '📋 *Active Codes*\n\n';
            codes.forEach((code, i) => {
                const expires = new Date(code.expires_at).toLocaleDateString();
                const used = code.used_by ? '✅ Used' : '❌ Available';
                message += `${i + 1}. \`${code.code}\`\n   Expires: ${expires} | ${used}\n\n`;
            });
            ctx.reply(message, { parse_mode: 'Markdown' });
        });

        this.bot.command('users', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const users = await this.db.getAllUsers();
            const activeUsers = users.filter(u => !u.is_admin);
            if (activeUsers.length === 0) return ctx.reply('👥 No users.');
            let message = '👥 *Registered Users*\n\n';
            activeUsers.forEach((user, i) => {
                const status = user.connected ? '🟢 Online' : '🔴 Offline';
                message += `${i + 1}. \`${user.email}\`\n   ${status} | Trades: ${user.stats?.total_trades || 0}\n`;
            });
            ctx.reply(message, { parse_mode: 'Markdown' });
        });

        this.bot.command('revoke', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const users = await this.db.getAllUsers();
            const activeUsers = users.filter(u => !u.is_admin);
            if (activeUsers.length === 0) return ctx.reply('👥 No users.');
            const buttons = activeUsers.map(user => [Markup.button.callback(`❌ ${user.email.split('@')[0]}`, `revoke_${user._id}`)]);
            ctx.reply('🔴 *Select user to revoke:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        });

        this.bot.command('addchannel', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const args = ctx.message.text.split(' ');
            if (args.length < 2) return ctx.reply('❌ Usage: /addchannel [channel_id] [name]');
            await this.db.addSignalChannel(ctx.from.id, args[1], args.slice(2).join(' ') || 'Signal Channel');
            ctx.reply(`✅ Channel added: \`${args[1]}\``, { parse_mode: 'Markdown' });
        });

        this.bot.command('removechannel', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const args = ctx.message.text.split(' ');
            if (args.length < 2) return ctx.reply('❌ Usage: /removechannel [channel_id]');
            await this.db.removeSignalChannel(args[1]);
            ctx.reply(`✅ Channel removed: \`${args[1]}\``, { parse_mode: 'Markdown' });
        });

        this.bot.command('setduration', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                const current = await this.db.getGlobalSetting('trade_duration', 5);
                return ctx.reply(`⏱️ *Current duration: ${current} min*\n\n/setduration 3 - Set to 3 min\n/setduration 5 - Set to 5 min`, { parse_mode: 'Markdown' });
            }
            const duration = parseInt(args[1]);
            if (duration !== 3 && duration !== 5) return ctx.reply('❌ Use 3 or 5 minutes');
            await this.db.setGlobalSetting('trade_duration', duration);
            ctx.reply(`✅ Trade duration set to ${duration} minutes`);
        });

        this.bot.command('connections', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            let msg = '📋 *Connected Accounts:*\n';
            for (const [email, client] of this.userConnections) {
                msg += `\n📧 ${email} (User: ${client.chatId}): ${client.connected ? '✅' : '❌'}`;
            }
            ctx.reply(msg, { parse_mode: 'Markdown' });
        });

        this.bot.command('allaccounts', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');

            let msg = '📋 *ALL CONNECTED ACCOUNTS*\n━━━━━━━━━━━━━━━\n';
            let count = 0;

            for (const [email, client] of this.userConnections) {
                const connected = client.connected === true || (client.ws && client.ws.readyState === 1);
                msg += `\n📧 ${email}\n   Status: ${connected ? '✅ Connected' : '❌ Disconnected'}\n   Balance: ${client.currency} ${client.balance}\n`;
                count++;
            }

            msg += `\n━━━━━━━━━━━━━━━\n📊 Total: ${count} accounts`;
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        });

        // FIXED: /setallamounts now works with connected accounts
        this.bot.command('setallamounts', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');
            const args = ctx.message.text.split(' ');
            if (args.length < 2) return ctx.reply('❌ *Usage:* `/setallamounts amount`');
            const amount = parseFloat(args[1]);
            if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Invalid amount');

            let count = 0;
            for (const [email, client] of this.userConnections) {
                // Update in-memory client if it has tradeAmount property
                if (client && typeof client === 'object') {
                    client.tradeAmount = amount;
                    // Also update in DB if account exists
                    await this.db.updateAccount(email, { tradeAmount: amount, 'martingale.base_amount': amount }).catch(() => { });
                    count++;
                }
            }
            ctx.reply(`✅ Trade amount for ALL ${count} connected accounts set to ${amount}`);
        });

        this.bot.command('addaccount', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');
            const args = ctx.message.text.split(' ');
            if (args.length < 3) return ctx.reply('❌ *Usage:* `/addaccount email password`', { parse_mode: 'Markdown' });

            const email = args[1];
            const password = args.slice(2).join(' ');

            const statusMsg = await ctx.reply(`🔄 Connecting account ${email}...`);

            try {
                const iqClient = new IQOptionClient(email, password, ctx.from.id, this.db);
                const loggedIn = await iqClient.login(true);
                if (!loggedIn) {
                    await ctx.deleteMessage(statusMsg.message_id);
                    return ctx.reply(`❌ Login failed for ${email}`);
                }

                iqClient.accountType = 'REAL';
                iqClient.refreshProfile();
                await this.db.addAccount(ctx.from.id, email, password, 'REAL', 1500);

                iqClient.onTradeOpened = (tradeData) => this.handleTradeOpened(ctx.from.id, tradeData, email);
                iqClient.onTradeClosed = (tradeResult) => this.handleTradeClosed(ctx.from.id, tradeResult, email);
                iqClient.onBalanceChanged = ({ amount, currency, type }) => {
                    this.db.updateAccount(email, { balance: amount, currency, account_type: type, connected: true });
                };

                this.userConnections.set(email, iqClient);
                await ctx.deleteMessage(statusMsg.message_id);
                await ctx.reply(
                    `✅ *Account Connected: ${email}*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `*Next:* Please set the trade amount for this account using:\n` +
                    `\`/setaccamount ${email} [amount]\``,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                await ctx.deleteMessage(statusMsg.message_id);
                ctx.reply(`❌ Error adding account: ${error.message}`);
            }
        });

        this.bot.command('setaccamount', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');
            const args = ctx.message.text.split(' ');
            if (args.length < 3) return ctx.reply('❌ *Usage:* `/setaccamount email amount`');

            const email = args[1];
            const amount = parseFloat(args[2]);
            if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Invalid amount');

            await this.db.updateAccount(email, { tradeAmount: amount, 'martingale.base_amount': amount });
            // Also update in-memory client if connected
            const client = this.userConnections.get(email);
            if (client) client.tradeAmount = amount;
            ctx.reply(`✅ Trade amount for ${email} set to ${amount}`);
        });

        this.bot.command('disconnectaccount', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');
            const args = ctx.message.text.split(' ');
            if (args.length < 2) return ctx.reply('❌ *Usage:* `/disconnectaccount email`');

            const email = args[1];
            const client = this.userConnections.get(email);
            if (client) {
                await client.logout();
                this.userConnections.delete(email);
            }
            await this.db.updateAccount(email, { connected: false, ssid: null });
            ctx.reply(`🔌 Disconnected ${email}`);
        });

        // HELP COMMAND
        this.bot.help(async (ctx) => {
            const isAdmin = ctx.state.user?.is_admin;

            let helpMsg = '🤖 *IQ Option Trading Bot Commands*\n━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
            helpMsg += '📺 *VIDEO GUIDE:* https://youtu.be/tePDDjJnMuM\n\n';
            helpMsg += '*🔐 Account:*\n';
            helpMsg += '/start [code] - Register\n';
            helpMsg += '/login email pass - Connect IQ Option\n';
            helpMsg += '/logout - Disconnect\n';
            helpMsg += '/status - Connection status\n';
            helpMsg += '/myid - Your Telegram ID\n\n';
            helpMsg += '*💰 Trading:*\n';
            helpMsg += '/balance - Check balance\n';
            helpMsg += '/setamount [amount] - Set trade amount\n';
            helpMsg += '/martingale - View/toggle martingale\n';
            helpMsg += '/practice - Demo mode (single)\n';
            helpMsg += '/real - Real money (single)\n';
            helpMsg += '/practiceall - Switch ALL to demo (admin)\n';
            helpMsg += '/realall - Switch ALL to real (admin)\n';
            helpMsg += '/stats - Your stats\n\n';

            if (isAdmin) {
                helpMsg += '*👑 Admin:*\n';
                helpMsg += '/generate - Create access code\n';
                helpMsg += '/codes - List codes\n';
                helpMsg += '/users - List users\n';
                helpMsg += '/revoke - Delete user\n';
                helpMsg += '/addchannel - Add channel\n';
                helpMsg += '/removechannel - Remove channel\n';
                helpMsg += '/setduration 3/5 - Trade duration\n';
                helpMsg += '/connections - Show connections\n';
                helpMsg += '/allaccounts - Show all connected accounts\n';
                helpMsg += '/addaccount - Add sub-account\n';
                helpMsg += '/setaccamount - Set sub-account amount\n';
                helpMsg += '/setallamounts - Set amount for ALL connected accounts\n';
                helpMsg += '/disconnectaccount - Disconnect sub-account\n\n';
            }

            helpMsg += '━━━━━━━━━━━━━━━━━━━━━━━━━\n';
            helpMsg += '_Signals execute automatically from TradingView_';

            await ctx.reply(helpMsg, { parse_mode: 'Markdown', disable_web_page_preview: true });
        });
    }

    setupHandlers() {
        // Revoke handler
        this.bot.action(/^revoke_/, async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.answerCbQuery('❌ Admin only');
            const targetId = ctx.match[0].replace('revoke_', '');
            const user = await this.db.getUser(targetId);
            if (!user) return ctx.answerCbQuery('User not found');
            const client = this.userConnections.get(targetId);
            if (client) client.disconnect();
            this.userConnections.delete(targetId);
            await this.db.deleteUser(targetId);
            await ctx.answerCbQuery('✅ Revoked');
            await ctx.editMessageText(`✅ Revoked: ${user.email}`);
        });

        // Martingale handlers
        this.bot.action('martingale_on', async (ctx) => {
            await ctx.answerCbQuery();
            await this.db.updateUser(ctx.from.id, { martingale_enabled: true });
            await ctx.editMessageText('✅ Martingale is now ON');
        });

        this.bot.action('martingale_off', async (ctx) => {
            await ctx.answerCbQuery();
            await this.db.updateUser(ctx.from.id, { martingale_enabled: false });
            await ctx.editMessageText('🔴 Martingale is now OFF');
        });

        this.bot.action('martingale_reset', async (ctx) => {
            await ctx.answerCbQuery();
            await this.db.updateUser(ctx.from.id, {
                'martingale.current_step': 0,
                'martingale.current_amount': null,
                'martingale.loss_streak': 0
            });
            await ctx.editMessageText('🔄 Martingale reset to base');
        });

        // Confirm switch all to REAL
        this.bot.action('confirm_realall', async (ctx) => {
            await ctx.answerCbQuery();

            let switchedCount = 0;
            let failedCount = 0;

            for (const [email, client] of this.userConnections) {
                try {
                    client.accountType = 'REAL';
                    client.refreshProfile();
                    await this.db.updateAccount(email, { account_type: 'REAL' });
                    switchedCount++;
                    logger.info(`✅ Switched ${email} to REAL mode`);
                } catch (err) {
                    failedCount++;
                    logger.error(`❌ Failed to switch ${email}: ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 100));
            }

            await ctx.editMessageText(
                `✅ *Switched ${switchedCount} accounts to REAL mode*\n` +
                `❌ Failed: ${failedCount}\n\n` +
                `_⚠️ All trades will now use REAL money._`,
                { parse_mode: 'Markdown' }
            );
        });

        this.bot.action('cancel_realall', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.editMessageText('❌ Switch cancelled.', { parse_mode: 'Markdown' });
        });

        // Single account real confirmation
        this.bot.action('confirm_real', async (ctx) => {
            await ctx.answerCbQuery();
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ Not connected');

            for (const client of userAccounts) {
                client.accountType = 'REAL';
                client.refreshProfile();
                await this.db.updateAccount(client.email, { account_type: 'REAL' });
            }
            await this.db.updateUser(ctx.from.id, { account_type: 'REAL' });
            ctx.reply(`✅ Switched ${userAccounts.length} accounts to REAL`);
        });

        this.bot.action('cancel_real', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.reply('❌ Cancelled');
        });

        // Menu handlers (existing)
        this.bot.hears('🏠 Main Menu', async (ctx) => {
            if (ctx.state.user?.is_admin) {
                await ctx.reply('Admin Menu', this.adminMainMenu);
            } else if (ctx.state.user) {
                await ctx.reply('Main Menu', this.userMainMenu);
            }
        });

        this.bot.hears('💰 Balance', async (ctx) => {
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ Not connected');
            let msg = `💰 *Account Balances*\n━━━━━━━━━━━━━━━\n`;
            for (const client of userAccounts) {
                const connected = client?.ws?.readyState === 1;
                if (connected) {
                    client.refreshProfile();
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                const realSymbol = getCurrencySymbol(client.realCurrency || 'USD');
                const practiceSymbol = getCurrencySymbol(client.practiceCurrency || 'USD');
                const activeSymbol = getCurrencySymbol(client.currency || 'USD');
                const activeType = client.accountType === 'REAL' ? '🔥 REAL' : '🧪 PRACTICE';
                const status = connected ? '✅' : '❌';
                msg += `\n${status} *${client.email}*\n`;
                msg += `💵 REAL: ${realSymbol}${client.realBalance.toLocaleString()}\n`;
                msg += `💵 PRACTICE: ${practiceSymbol}${client.practiceBalance.toLocaleString()}\n`;
                msg += `🎯 Active: ${activeType} (${activeSymbol}${client.balance.toLocaleString()})\n`;
                msg += `━━━━━━━━━━━━━━━\n`;
            }
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        });

        this.bot.hears('📊 My Stats', async (ctx) => {
            const user = ctx.state.user;
            if (!user) return ctx.reply('❌ Login first');
            const stats = user.stats || { total_trades: 0, wins: 0, losses: 0, total_profit: 0 };
            ctx.reply(`📊 Trades: ${stats.total_trades} | Wins: ${stats.wins} | Losses: ${stats.losses}\nProfit: $${stats.total_profit.toFixed(2)}`);
        });

        this.bot.hears('💰 Set Amount', async (ctx) => {
            ctx.reply('Send /setamount [amount]\nExample: /setamount 1500');
        });

        this.bot.hears('🤖 Martingale', async (ctx) => {
            ctx.reply('Use /martingale');
        });

        this.bot.hears('📈 Practice Mode', async (ctx) => {
            const client = this.userConnections.get(ctx.from.id);
            if (!client) return ctx.reply('❌ Login first');
            client.accountType = 'PRACTICE';
            client.refreshProfile();
            await this.db.updateUser(ctx.from.id, { account_type: 'PRACTICE' });
            ctx.reply('✅ Switched to PRACTICE');
        });

        this.bot.hears('💵 Real Mode', async (ctx) => {
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ Login first');
            for (const client of userAccounts) {
                client.accountType = 'REAL';
                client.refreshProfile();
                await this.db.updateAccount(client.email, { account_type: 'REAL' });
            }
            ctx.reply(`✅ Switched ${userAccounts.length} accounts to REAL`);
        });

        this.bot.hears('🔌 Status', async (ctx) => {
            const userAccounts = this.getClientsByUserId(ctx.from.id);
            if (userAccounts.length === 0) return ctx.reply('❌ No connections');
            let msg = `🔌 *Connection Status*\n━━━━━━━━━━━━━━━\n`;
            for (const client of userAccounts) {
                const connected = client?.ws?.readyState === 1;
                const mode = client.accountType === 'REAL' ? '🔥 REAL' : '🧪 PRACTICE';
                msg += `\n📧 *${client.email}*\n🔌 Status: ${connected ? '✅ Connected' : '❌ Disconnected'}\n💳 Mode: ${mode}\n`;
            }
            ctx.reply(msg, { parse_mode: 'Markdown' });
        });

        // Admin menu handlers (existing)
        this.bot.hears('🎫 Generate Code', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const code = await this.db.createAccessCode(ctx.from.id);
            ctx.reply(`✅ *New Access Code*\n\n\`${code}\`\n\nValid for 30 days`, { parse_mode: 'Markdown' });
        });

        this.bot.hears('📋 List Codes', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const codes = await this.db.getActiveCodes();
            if (codes.length === 0) return ctx.reply('📭 No active codes.');
            let message = '📋 *Active Codes*\n\n';
            codes.forEach((code, i) => {
                const expires = new Date(code.expires_at).toLocaleDateString();
                const used = code.used_by ? '✅ Used' : '❌ Available';
                message += `${i + 1}. \`${code.code}\`\n   Expires: ${expires} | ${used}\n\n`;
            });
            ctx.reply(message, { parse_mode: 'Markdown' });
        });

        this.bot.hears('👥 List Users', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const users = await this.db.getAllUsers();
            const activeUsers = users.filter(u => !u.is_admin);
            if (activeUsers.length === 0) return ctx.reply('👥 No users.');
            let message = '👥 *Registered Users*\n\n';
            activeUsers.forEach((user, i) => {
                const status = user.connected ? '🟢 Online' : '🔴 Offline';
                const safeEmail = user.email.replace(/_/g, '\\_');
                message += `${i + 1}. \`${safeEmail}\`\n   ${status} | Trades: ${user.stats?.total_trades || 0}\n`;
            });
            ctx.reply(message, { parse_mode: 'Markdown' });
        });

        this.bot.hears('🔴 Revoke User', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const users = await this.db.getAllUsers();
            const activeUsers = users.filter(u => !u.is_admin);
            if (activeUsers.length === 0) return ctx.reply('👥 No users.');
            const buttons = activeUsers.map(user => [Markup.button.callback(`❌ ${user.email.split('@')[0]}`, `revoke_${user._id}`)]);
            ctx.reply('🔴 *Select user to revoke:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
        });

        this.bot.command('statusaccount', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');
            const args = ctx.message.text.split(' ');
            if (args.length < 2) return ctx.reply('❌ *Usage:* `/statusaccount email`');

            const email = args[1].toLowerCase();
            const account = await this.db.getAccountByEmail(email);
            if (!account) return ctx.reply(`❌ No account found with email: ${email}`);

            const client = this.userConnections.get(email);
            const connected = client && client.ws && client.ws.readyState === 1;
            const symbol = getCurrencySymbol(account.currency || 'USD');
            let msg = `📊 *Account Status*\n\n`;
            msg += `📧 Email: \`${email}\`\n`;
            msg += `🔌 Status: ${connected ? '✅ Connected' : '❌ Disconnected'}\n`;
            msg += `💳 Mode: ${account.account_type || 'PRACTICE'}\n`;
            msg += `💰 Balance: ${symbol}${account.balance?.toLocaleString() || 0}\n`;
            msg += `📈 Trade Amt: ${symbol}${account.tradeAmount || 1500}\n`;
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        });

        this.bot.hears('📢 Add Channel', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            ctx.reply('Use the command: /addchannel [channel_id] [name]');
        });

        this.bot.hears('📢 Remove Channel', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            ctx.reply('Use the command: /removechannel [channel_id]');
        });

        this.bot.hears('⏱️ Set Duration', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const current = await this.db.getGlobalSetting('trade_duration', 5);
            ctx.reply(`⏱️ *Current duration: ${current} min*\n\nUse command:\n/setduration 3 - Set to 3 min\n/setduration 5 - Set to 5 min`, { parse_mode: 'Markdown' });
        });

        this.bot.hears('📊 System Stats', async (ctx) => {
            if (!ctx.state.user?.is_admin) return;
            const users = await this.db.getAllUsers();
            const activeUsers = users.filter(u => !u.is_admin);
            const onlineCount = activeUsers.filter(u => u.connected).length;
            ctx.reply(`📊 *System Stats*\n━━━━━━━━━━━━━━━\n\n👥 Total Users: ${activeUsers.length}\n🟢 Online Users: ${onlineCount}`, { parse_mode: 'Markdown' });
        });
    }

    async handleTradeOpened(userId, tradeData, accountEmail = null) {
        const user = await this.db.getUser(userId);
        if (!user || user.notifications_enabled === false) return;

        const notifKey = `${accountEmail || userId}_${tradeData.tradeId}_opened`;
        if (this.recentNotifications.has(notifKey)) return;
        this.recentNotifications.set(notifKey, true);
        setTimeout(() => this.recentNotifications.delete(notifKey), 5000);

        const client = accountEmail ? this.userConnections.get(accountEmail) : this.getClientsByUserId(userId)[0];
        const emailLabel = accountEmail ? `\n📧 Account: ${accountEmail}` : '';
        const symbol = getCurrencySymbol(client?.currency || user.currency || 'USD');
        const message = `🟢 *NEW TRADE*${emailLabel}\n━━━━━━━━━━━━━━━\n📊 ${tradeData.asset}\n📈 ${tradeData.direction}\n💰 ${symbol}${tradeData.amount}\n⏱️ ${tradeData.duration} min`;

        try { await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' }); } catch (err) { }

        for (const adminId of config.telegram.adminIds) {
            if (adminId && adminId !== userId) {
                const admin = await this.db.getUser(adminId);
                if (admin && admin.notifications_enabled !== false) {
                    try { await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' }); } catch (err) { }
                }
            }
        }
    }

    async handleTradeClosed(userId, tradeResult, accountEmail = null) {
        const user = await this.db.getUser(userId);
        if (!user || user.notifications_enabled === false) return;

        const notifKey = `${accountEmail || userId}_${tradeResult.tradeId}_closed`;
        if (this.recentNotifications.has(notifKey)) return;
        this.recentNotifications.set(notifKey, true);
        setTimeout(() => this.recentNotifications.delete(notifKey), 5000);

        const emailLabel = accountEmail ? `\n📧 Account: ${accountEmail}` : '';
        const message = `${tradeResult.isWin ? '✅' : '❌'} *${tradeResult.isWin ? 'WIN' : 'LOSS'}*${emailLabel}\n━━━━━━━━━━━━━━━\n📊 ${tradeResult.asset}\n💰 P&L: ${tradeResult.profit}`;

        try { await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' }); } catch (err) { }

        for (const adminId of config.telegram.adminIds) {
            if (adminId && adminId !== userId) {
                const admin = await this.db.getUser(adminId);
                if (admin && admin.notifications_enabled !== false) {
                    try { await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' }); } catch (err) { }
                }
            }
        }
    }

    getClientsByUserId(userId) {
        const clients = [];
        for (const client of this.userConnections.values()) {
            if (client.chatId?.toString() === userId.toString()) {
                clients.push(client);
            }
        }
        return clients;
    }

    getAllConnectedClients() {
        const clients = [];
        for (const [email, client] of this.userConnections) {
            if (client.connected) {
                clients.push({ userId: client.chatId, client, email });
            }
        }
        return clients;
    }
}

module.exports = TelegramBot;