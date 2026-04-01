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
        this.bot.use(session());  // Add session only once, here
        console.log("[DEBUG] 3 - Session middleware added");

        this.db = db;
        this.tradingBot = tradingBot;
        this.userConnections = new Map();
        this.loginQueue = new PQueue({ concurrency: 2 });
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
    async start() {
        console.log("[DEBUG] 10 - start() called");
        
        // Provide error handling for launch
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
                
                // Initialize ctx.state if undefined
                if (!ctx.state) ctx.state = {};

                const userId = ctx.from?.id?.toString();
                if (userId) {
                    ctx.state.user = await this.db.getUser(userId);

                    if (!ctx.state.user && userId === config.telegram.adminId) {
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

        // LOGIN COMMAND
        this.bot.command('login', async (ctx) => {
            const args = ctx.message.text.split(' ');
            if (args.length < 3) {
                return ctx.reply('❌ *Usage:* `/login email password`', { parse_mode: 'Markdown' });
            }

            const email = args[1];
            const password = args.slice(2).join(' ');
            let user = await this.db.getUser(ctx.from.id);
            const pendingCode = ctx.session?.pendingCode;

            if (!user && !pendingCode) {
                return ctx.reply('❌ Please `/start` with an access code first.');
            }

            await this.loginQueue.add(async () => {
                const statusMsg = await ctx.reply('🔄 Connecting to IQ Option...');

                try {
                    const iqClient = new IQOptionClient(email, password, ctx.from.id, this.db);
                    const loggedIn = await iqClient.login(true);
                    if (!loggedIn) {
                        await ctx.deleteMessage(statusMsg.message_id);
                        return ctx.reply('❌ Login failed. Check your email and password.');
                    }

                    if (!user && pendingCode) {
                        await this.db.registerUserWithCode(ctx.from.id, email, password, pendingCode);
                        user = await this.db.getUser(ctx.from.id);
                        ctx.session.pendingCode = null;
                    }

                    // Set up callbacks
                    iqClient.onTradeOpened = (tradeData) => {
                        this.handleTradeOpened(ctx.from.id, tradeData);
                    };

                    iqClient.onTradeClosed = (tradeResult) => {
                        this.handleTradeClosed(ctx.from.id, tradeResult);
                    };

                    iqClient.onBalanceChanged = ({ amount, currency }) => {
                        this.db.updateUser(ctx.from.id, { balance: amount, currency, connected: true });
                        logger.info(`💰 User ${ctx.from.id}: Balance updated to ${currency}${amount}`);
                    };

                    this.userConnections.set(ctx.from.id, iqClient);
                    await this.db.updateUser(ctx.from.id, { connected: true });

                    await ctx.deleteMessage(statusMsg.message_id);
                    await ctx.reply(
                        '🎉 *Successfully Connected to IQ Option!*\n' +
                        '━━━━━━━━━━━━━━━\n\n' +
                        '📺 [COMPLETE VIDEO GUIDE](https://youtu.be/tePDDjJnMuM)\n\n' +
                        '*⏩ NEXT STEPS:*\n\n' +
                        '*1️⃣ Set trade amount:* `/setamount 1500`\n' +
                        '*2️⃣ Check balance:* `/balance`\n' +
                        '*3️⃣ View martingale:* `/martingale`\n' +
                        '*4️⃣ Wait for signals — trades run automatically!*\n\n' +
                        '━━━━━━━━━━━━━━━\n' +
                        '_Type /help anytime to see all commands._',
                        {
                            parse_mode: 'Markdown',
                            disable_web_page_preview: false,
                            ...this.userMainMenu
                        }
                    );
                } catch (error) {
                    await ctx.deleteMessage(statusMsg.message_id);
                    ctx.reply('❌ Login failed: ' + error.message);
                }
            });
        });

        // BALANCE COMMAND
        this.bot.command('balance', async (ctx) => {
            const client = this.userConnections.get(ctx.from.id);
            if (!client || !client.connected) {
                return ctx.reply('❌ Not connected. Use /login first.');
            }

            // Force a profile refresh to get latest balances
            client.refreshProfile();
            await new Promise(resolve => setTimeout(resolve, 1000));

            const currentSymbol = getCurrencySymbol(client.currency);
            const realSymbol = getCurrencySymbol(client.realCurrency);
            const practiceSymbol = getCurrencySymbol(client.practiceCurrency);

            const message =
                `💰 *Balance*\n` +
                `━━━━━━━━━━━━━━━\n` +
                `*Current Account:* ${client.accountType}\n` +
                `Balance: ${currentSymbol}${client.balance.toLocaleString()}\n\n` +
                `*REAL:* ${realSymbol}${client.realBalance.toLocaleString()}\n` +
                `*PRACTICE:* ${practiceSymbol}${client.practiceBalance.toLocaleString()}`;

            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        // STATUS COMMAND
        this.bot.command('status', async (ctx) => {
            const client = this.userConnections.get(ctx.from.id);
            const connected = client?.connected || false;
            const user = ctx.state.user;
            const expires = user?.access_expires_at ? new Date(user.access_expires_at).toLocaleDateString() : 'N/A';

            let message = `📊 *Connection Status*\n━━━━━━━━━━━━━━━\n`;
            message += `🔌 IQ Option: ${connected ? '✅ Connected' : '❌ Disconnected'}\n`;
            if (connected && client) {
                message += `💳 Account: ${client.accountType}\n`;
                message += `💰 Balance: ${getCurrencySymbol(client.currency)}${client.balance.toLocaleString()}\n`;
            }
            message += `📅 Access Expires: ${expires}\n`;

            await ctx.reply(message, { parse_mode: 'Markdown' });
        });

        // SET AMOUNT COMMAND
        this.bot.command('setamount', async (ctx) => {
            if (!ctx.state.user) return ctx.reply('❌ Please login first');
            const args = ctx.message.text.split(' ');
            if (args.length < 2) {
                const current = ctx.state.user.tradeAmount || 1500;
                const symbol = getCurrencySymbol(ctx.state.user.currency || 'USD');
                return ctx.reply(`💰 *Current amount:* ${symbol}${current}\n\n/setamount [amount]`, { parse_mode: 'Markdown' });
            }
            const amount = parseFloat(args[1]);
            if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Enter a valid amount');
            await this.db.updateUser(ctx.from.id, { tradeAmount: amount });
            const symbol = getCurrencySymbol(ctx.state.user.currency || 'USD');
            ctx.reply(`✅ Trade amount set to ${symbol}${amount}`);
        });

        // MARTINGALE COMMAND
        this.bot.command('martingale', async (ctx) => {
            const user = ctx.state.user;
            if (!user) return ctx.reply('❌ Please login first');

            const client = this.userConnections.get(ctx.from.id);
            const isEnabled = user.martingale_enabled !== false;
            const currency = client?.currency || user?.currency || 'USD';
            const symbol = getCurrencySymbol(currency);
            const baseAmount = user.martingale?.base_amount || user.tradeAmount || 1500;
            const step = user.martingale?.current_step || 0;
            const losses = user.martingale?.loss_streak || 0;

            const multipliers = [1, 1, 1, 1, 4, 8, 16, 32];
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
                `📉 Step: ${step + 1}/8 | Losses: ${losses}\n\n` +
                `*Sequence:*\n${sequence}\n\n` +
                `_Win → reset to base_\n` +
                `_8 losses → auto-reset_`;

            await ctx.reply(message, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(isEnabled ? '🔴 Turn OFF' : '✅ Turn ON', isEnabled ? 'martingale_off' : 'martingale_on')],
                    [Markup.button.callback('🔄 Reset to Base', 'martingale_reset')]
                ])
            });
        });

        // ACCOUNT SWITCHING
        this.bot.command('practice', async (ctx) => {
            const client = this.userConnections.get(ctx.from.id);
            if (!client) return ctx.reply('❌ Please /login first');
            client.accountType = 'PRACTICE';
            client.refreshProfile();
            await this.db.updateUser(ctx.from.id, { account_type: 'PRACTICE' });
            await new Promise(resolve => setTimeout(resolve, 500));
            const symbol = getCurrencySymbol(client.currency);
            ctx.reply(`✅ Switched to PRACTICE account\n💰 Balance: ${symbol}${client.balance.toLocaleString()}`);
        });

        this.bot.command('real', async (ctx) => {
            const client = this.userConnections.get(ctx.from.id);
            if (!client) return ctx.reply('❌ Please /login first');
            await ctx.reply(
                '⚠️ *WARNING: Switching to REAL account*\n\nThis uses real money. Are you sure?',
                { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yes', 'confirm_real'), Markup.button.callback('❌ Cancel', 'cancel_real')]]) }
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
            const client = this.userConnections.get(ctx.from.id);
            if (client) {
                await client.logout();
                this.userConnections.delete(ctx.from.id);
            }
            ctx.reply('👋 Logged out');
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

        // ADMIN COMMANDS
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
            let msg = '📋 *Connected Users:*\n';
            for (const [userId, client] of this.userConnections) {
                const user = await this.db.getUser(userId);
                msg += `\n👤 ${user?.email || userId}: ${client.connected ? '✅' : '❌'}`;
            }
            ctx.reply(msg, { parse_mode: 'Markdown' });
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
            helpMsg += '/practice - Demo mode\n';
            helpMsg += '/real - Real money\n';
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
                helpMsg += '/connections - Show connections\n\n';
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

        this.bot.action('confirm_real', async (ctx) => {
            await ctx.answerCbQuery();
            const client = this.userConnections.get(ctx.from.id);
            if (!client) return ctx.reply('❌ Please /login first');
            client.accountType = 'REAL';
            client.refreshProfile();
            await this.db.updateUser(ctx.from.id, { account_type: 'REAL' });
            await new Promise(resolve => setTimeout(resolve, 500));
            const symbol = getCurrencySymbol(client.currency);
            ctx.reply(`✅ Switched to REAL account\n💰 Balance: ${symbol}${client.balance.toLocaleString()}`);
        });

        this.bot.action('cancel_real', async (ctx) => {
            await ctx.answerCbQuery();
            await ctx.reply('❌ Cancelled');
        });

        // Menu handlers
        this.bot.hears('🏠 Main Menu', async (ctx) => {
            if (ctx.state.user?.is_admin) {
                await ctx.reply('Admin Menu', this.adminMainMenu);
            } else if (ctx.state.user) {
                await ctx.reply('Main Menu', this.userMainMenu);
            }
        });

        this.bot.hears('💰 Balance', async (ctx) => {
            const client = this.userConnections.get(ctx.from.id);
            if (!client || !client.connected) return ctx.reply('❌ Not connected');
            client.refreshProfile();
            await new Promise(resolve => setTimeout(resolve, 500));
            const symbol = getCurrencySymbol(client.currency);
            ctx.reply(`💰 Balance: ${symbol}${client.balance.toLocaleString()}`);
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
            const client = this.userConnections.get(ctx.from.id);
            if (!client) return ctx.reply('❌ Login first');
            client.accountType = 'REAL';
            client.refreshProfile();
            await this.db.updateUser(ctx.from.id, { account_type: 'REAL' });
            ctx.reply('✅ Switched to REAL');
        });

        this.bot.hears('🔌 Status', async (ctx) => {
            const client = this.userConnections.get(ctx.from.id);
            ctx.reply(`🔌 Status: ${client?.connected ? '✅ Connected' : '❌ Disconnected'}`);
        });

        // ================== ADMIN MENU HANDLERS ===================
        this.bot.hears('🎫 Generate Code', async (ctx) => {
            if (!ctx.state.user?.is_admin) return ctx.reply('❌ Admin only');
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

    async handleTradeOpened(userId, tradeData) {
        const user = await this.db.getUser(userId);
        if (!user) return;
        const client = this.userConnections.get(userId);
        const symbol = getCurrencySymbol(client?.currency || user.currency || 'USD');
        const message = `🟢 *NEW TRADE*\n━━━━━━━━━━━━━━━\n📊 ${tradeData.asset}\n📈 ${tradeData.direction}\n💰 ${symbol}${tradeData.amount}\n⏱️ ${tradeData.duration} min`;

        try { await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' }); } catch (err) { }

        const adminId = config.telegram.adminId;
        if (adminId && adminId !== userId) {
            try { await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' }); } catch (err) { }
        }
    }

    async handleTradeClosed(userId, tradeResult) {
        const user = await this.db.getUser(userId);
        if (!user) return;
        const message = `${tradeResult.isWin ? '✅' : '❌'} *${tradeResult.isWin ? 'WIN' : 'LOSS'}*\n━━━━━━━━━━━━━━━\n📊 ${tradeResult.asset}\n💰 P&L: ${tradeResult.profit}`;

        try { await this.bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' }); } catch (err) { }

        const adminId = config.telegram.adminId;
        if (adminId && adminId !== userId) {
            try { await this.bot.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' }); } catch (err) { }
        }
    }

    getUserClient(userId) {
        return this.userConnections.get(userId);
    }

    getAllConnectedClients() {
        const clients = [];
        const seen = new Set();
        for (const [userId, client] of this.userConnections) {
            if (client.connected && !seen.has(userId)) {
                seen.add(userId);
                clients.push({ userId, client });
            }
        }
        return clients;
    }

}

module.exports = TelegramBot;