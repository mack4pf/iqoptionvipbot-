const logger = require('../utils/logger');

class TradeExecutor {
    constructor(db, telegramBot, martingale) {
        this.db = db;
        this.telegramBot = telegramBot;
        this.martingale = martingale;
        this.openPositions = new Map();
        this.lastTradeCloseTime = new Map();
        this.cooldownSeconds = 10;

        // Clear any stale open positions on startup (prevents false "open position" blocks)
        this.openPositions.clear();
        this.lastTradeCloseTime.clear();
    }

    async execute(userId, client, signal, account) {
        const accountKey = client.email || userId;

        console.log(`🔍 Step 1: Checking open position for ${accountKey}`);
        if (this.openPositions.has(accountKey)) {
            logger.info(`⏸️ Account ${accountKey}: Open position exists - blocking`);
            return { success: false, error: 'Account has open position' };
        }

        console.log(`🔍 Step 2: Checking cooldown for ${accountKey}`);
        if (this.lastTradeCloseTime.has(accountKey)) {
            const timeSince = Date.now() - this.lastTradeCloseTime.get(accountKey);
            if (timeSince < this.cooldownSeconds * 1000) {
                logger.info(`⏸️ Account ${accountKey}: Cooldown active`);
                return { success: false, error: 'Cooldown active' };
            }
        }

        console.log(`🔍 Step 3: Checking connection status for ${accountKey}`);
        console.log(`🔍 Connected: ${client?.connected}, ws readyState: ${client?.ws?.readyState}`);

        const martingaleEnabled = account?.martingale_enabled !== false;
        const currency = client?.currency || account?.currency || 'USD';

        console.log(`🔍 Step 4: Currency = ${currency}, balance = ${client.balance}`);

        let tradeAmount;
        if (martingaleEnabled) {
            const baseAmount = account?.tradeAmount || 1500;
            const state = this.martingale.getState(accountKey, account, currency, baseAmount);
            tradeAmount = state.currentAmount;
        } else {
            tradeAmount = account?.tradeAmount || 1500;
        }

        console.log(`🔍 Step 5: Trade amount = ${tradeAmount}`);

        if (!client.balanceId) {
            console.log(`❌ User ${accountKey} has no balanceId, refreshing profile...`);
            client.refreshProfile();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (client.balance < tradeAmount) {
            return { success: false, error: `Insufficient balance: ${client.balance} < ${tradeAmount}` };
        }

        console.log(`🔍 Step 6: Placing trade for ${accountKey}...`);
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

        this.openPositions.set(accountKey, result.tradeId);

        return {
            success: true,
            tradeId: result.tradeId,
            amount: tradeAmount,
            martingaleEnabled,
            email: client.email
        };
    }

    async handleResult(userId, position, tradeInfo, account) {
        const accountKey = tradeInfo.email || userId;
        const isWin = position.raw_event?.result === 'win' || position.close_reason === 'win';
        const investment = position.invest || tradeInfo.amount;

        this.openPositions.delete(accountKey);
        this.lastTradeCloseTime.set(accountKey, Date.now());

        const martingaleEnabled = account?.martingale_enabled !== false;

        if (martingaleEnabled) {
            const baseAmount = account?.tradeAmount || 1500;
            const state = this.martingale.getState(accountKey, account, tradeInfo.currency, baseAmount);

            if (isWin) {
                this.martingale.reset(accountKey, state);
            } else {
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
            } else {
                await this.db.updateUser(userId, { martingale: martingaleUpdate });
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