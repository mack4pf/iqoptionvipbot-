const logger = require('../utils/logger');

class TradeExecutor {
    constructor(db, telegramBot, martingale) {
        this.db = db;
        this.telegramBot = telegramBot;
        this.martingale = martingale;
        this.openPositions = new Map();
        this.lastTradeCloseTime = new Map();
        this.cooldownSeconds = 10;
    }

    async execute(userId, client, signal, user) {
        if (this.openPositions.has(userId)) {
            logger.info(`‚è∏Ô∏è User ${userId}: Open position exists - blocking`);
            return { success: false, error: 'User has open position' };
        }
        
        if (this.lastTradeCloseTime.has(userId)) {
            const timeSince = Date.now() - this.lastTradeCloseTime.get(userId);
            if (timeSince < this.cooldownSeconds * 1000) {
                logger.info(`‚è∏Ô∏è User ${userId}: Cooldown active`);
                return { success: false, error: 'Cooldown active' };
            }
        }
        
        const martingaleEnabled = user?.martingale_enabled !== false;
        const currency = client?.currency || user?.currency || 'USD';
        
        let tradeAmount;
        
        if (martingaleEnabled) {
            const baseAmount = user?.tradeAmount || 1500;
            const state = this.martingale.getState(userId, user, currency, baseAmount);
            tradeAmount = state.currentAmount;
        } else {
            tradeAmount = user?.tradeAmount || 1500;
        }
        
        if (client.balance < tradeAmount) {
            return { success: false, error: `Insufficient balance: ${client.balance} < ${tradeAmount}` };
        }
        
        logger.info(`Ì≤∞ User ${userId}: Placing ${signal.direction} trade - ${tradeAmount}`);
        
        const result = await client.placeTrade({
            asset: signal.asset,
            direction: signal.direction,
            amount: tradeAmount,
            duration: signal.duration
        });
        
        if (!result.success) {
            return { success: false, error: result.error };
        }
        
        this.openPositions.set(userId, result.tradeId);
        
        return {
            success: true,
            tradeId: result.tradeId,
            amount: tradeAmount,
            martingaleEnabled
        };
    }
    
    async handleResult(userId, position, tradeInfo, user) {
        const isWin = position.raw_event?.result === 'win' || position.close_reason === 'win';
        const investment = position.invest || tradeInfo.amount;
        
        this.openPositions.delete(userId);
        this.lastTradeCloseTime.set(userId, Date.now());
        
        const martingaleEnabled = user?.martingale_enabled !== false;
        
        if (martingaleEnabled) {
            const baseAmount = user?.tradeAmount || 1500;
            const state = this.martingale.getState(userId, user, tradeInfo.currency, baseAmount);
            
            if (isWin) {
                this.martingale.reset(userId, state);
            } else {
                this.martingale.advance(userId, state);
            }
            
            await this.db.updateUser(userId, {
                martingale: {
                    current_step: state.step,
                    current_amount: state.currentAmount,
                    loss_streak: state.losses,
                    base_amount: state.baseAmount,
                    initial_balance: state.initialBalance
                }
            });
        }
        
        const stats = user?.stats || { total_trades: 0, wins: 0, losses: 0, total_profit: 0 };
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
        
        await this.db.updateUser(userId, { stats });
        
        if (this.telegramBot) {
            await this.telegramBot.sendTradeResult(userId, {
                isWin,
                investment,
                profit,
                currency: tradeInfo.currency,
                step: user?.martingale?.current_step || 0,
                losses: user?.martingale?.loss_streak || 0
            });
        }
        
        return { isWin, investment, profit };
    }
    
    clearOpenPosition(userId) {
        this.openPositions.delete(userId);
    }
}

module.exports = TradeExecutor;
