const logger = require('../utils/logger');

class TradeExecutor {
    constructor(db, telegramBot, martingale) {
        this.db = db;
        this.telegramBot = telegramBot;
        this.martingale = martingale;
        this.openPositions = new Map();
        this.lastTradeCloseTime = new Map();
        this.cooldownSeconds = 10;

        // Clear any stale open positions on startup
        this.openPositions.clear();
        this.lastTradeCloseTime.clear();
    }

    // Validate amount against currency min/max
    validateAmount(amount, currency) {
        const limits = {
            NGN: { min: 1500, max: 50000000 },
            USD: { min: 1, max: 10000000 },
            EUR: { min: 1, max: 100000 },
            GBP: { min: 1, max: 100000 },
            BRL: { min: 5, max: 500000 },
            INR: { min: 70, max: 7000000 },
            MXN: { min: 20, max: 2000000 },
            AED: { min: 5, max: 500000 },
            ZAR: { min: 20, max: 2000000 },
        };
        const limit = limits[currency?.toUpperCase()];
        if (!limit) return amount;
        if (amount < limit.min) return limit.min;
        if (amount > limit.max) return limit.max;
        return amount;
    }

    async execute(userId, client, signal, accountParam) {
        const accountKey = client.email || userId;

        // 🔄 FORCE RELOAD account from database to get latest martingale state
        let account = accountParam;
        if (accountKey) {
            try {
                const freshAccount = await this.db.getAccountByEmail(accountKey);
                if (freshAccount) {
                    account = freshAccount;
                    logger.info(`📦 [${accountKey}] Reloaded account from DB. Martingale losses: ${account.martingale?.loss_streak || 0}, step: ${account.martingale?.current_step || 0}`);
                }
            } catch (err) {
                logger.warn(`⚠️ [${accountKey}] Could not reload account from DB: ${err.message}`);
            }
        }

        console.log(`🔍 Step 1: Checking connection status for ${accountKey}`);
        console.log(`🔍 Connected: ${client?.connected}, ws readyState: ${client?.ws?.readyState}`);

        const martingaleEnabled = account?.martingale_enabled !== false;
        const currency = client?.currency || account?.currency || 'USD';

        console.log(`🔍 Step 2: Currency = ${currency}, balance = ${client.balance}`);

        let tradeAmount;
        if (martingaleEnabled) {
            const baseAmount = account?.tradeAmount || 1500;
            const state = this.martingale.getState(accountKey, account, currency, baseAmount);
            tradeAmount = state.currentAmount;
            logger.info(`💰 [${accountKey}] Martingale step=${state.step}, losses=${state.losses}, amount=${tradeAmount}`);
        } else {
            tradeAmount = account?.tradeAmount || 1500;
        }

        // Apply currency min/max validation
        tradeAmount = this.validateAmount(tradeAmount, currency);

        console.log(`🔍 Step 3: Trade amount = ${tradeAmount}`);

        if (!client.balanceId) {
            console.log(`❌ User ${accountKey} has no balanceId, refreshing profile...`);
            client.refreshProfile();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (client.balance < tradeAmount) {
            return { success: false, error: `Insufficient balance: ${client.balance} < ${tradeAmount}` };
        }

        console.log(`🔍 Step 4: Placing trade for ${accountKey}...`);
        logger.info(`🚀 Account ${accountKey}: Placing ${signal.direction} trade - ${tradeAmount}`);

        const result = await client.placeTrade({
            asset: signal.asset,
            direction: signal.direction,
            amount: tradeAmount,
            duration: signal.duration
        });

        if (!result.success) {
            return { success: false, error: result.error };
        }

        // Store the open position only after successful placement
        this.openPositions.set(accountKey, result.tradeId);

        return {
            success: true,
            tradeId: result.tradeId,
            amount: tradeAmount,
            martingaleEnabled,
            email: client.email
        };
    }

    async handleResult(userId, position, tradeInfo, accountParam) {
        const accountKey = tradeInfo.email || userId;

        // 🔄 Reload account from DB to ensure we update the correct state
        let account = accountParam;
        if (accountKey) {
            try {
                const freshAccount = await this.db.getAccountByEmail(accountKey);
                if (freshAccount) account = freshAccount;
            } catch (err) {
                logger.warn(`⚠️ [${accountKey}] Could not reload account for result handling: ${err.message}`);
            }
        }

        const isWin = position.raw_event?.result === 'win' || position.close_reason === 'win';
        const investment = position.invest || tradeInfo.amount;

        logger.info(`📊 [${accountKey}] Trade result: isWin=${isWin}, investment=${investment}, profit=${position.close_profit || 0}`);

        this.openPositions.delete(accountKey);
        this.lastTradeCloseTime.set(accountKey, Date.now());

        const martingaleEnabled = account?.martingale_enabled !== false;

        if (martingaleEnabled) {
            const baseAmount = account?.tradeAmount || 1500;
            const state = this.martingale.getState(accountKey, account, tradeInfo.currency, baseAmount);

            if (isWin) {
                logger.info(`✅ [${accountKey}] Win detected. Resetting martingale.`);
                this.martingale.reset(accountKey, state);
            } else {
                logger.info(`❌ [${accountKey}] Loss detected. Advancing martingale.`);
                this.martingale.advance(accountKey, state);
            }

            const martingaleUpdate = {
                current_step: state.step,
                current_amount: state.currentAmount,
                loss_streak: state.losses,
                base_amount: state.baseAmount,
                initial_balance: state.initialBalance
            };

            if (tradeInfo.email) {
                await this.db.updateAccount(tradeInfo.email, { martingale: martingaleUpdate });
                logger.info(`💾 [${accountKey}] Saved martingale state to account: step=${state.step}, amount=${state.currentAmount}`);
            } else {
                await this.db.updateUser(userId, { martingale: martingaleUpdate });
                logger.info(`💾 [${accountKey}] Saved martingale state to user: step=${state.step}, amount=${state.currentAmount}`);
            }
        }

        const stats = account?.stats || { total_trades: 0, wins: 0, losses: 0, total_profit: 0 };
        stats.total_trades++;

        let profit = 0;
        if (isWin) {
            const totalPayout = position.close_profit || position.raw_event?.profit_amount || 0;
            profit = totalPayout > investment ? totalPayout - investment : totalPayout;
            stats.wins++;
            stats.total_profit += profit;
        } else {
            stats.losses++;
            stats.total_profit -= investment;
        }

        if (tradeInfo.email) {
            await this.db.updateAccount(tradeInfo.email, { stats });
        } else {
            await this.db.updateUser(userId, { stats });
        }

        if (this.telegramBot) {
            await this.telegramBot.handleTradeClosed(userId, {
                isWin,
                investment,
                profit,
                currency: tradeInfo.currency,
                asset: tradeInfo.asset,
                direction: tradeInfo.direction,
                tradeId: tradeInfo.tradeId
            }, tradeInfo.email);
        }

        return { isWin, investment, profit };
    }

    clearOpenPosition(accountKey) {
        this.openPositions.delete(accountKey);
    }
}

module.exports = TradeExecutor;