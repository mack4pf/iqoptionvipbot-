const config = require('../config');
const logger = require('../utils/logger');

class Martingale {
    constructor() {
        this.multipliers = config.trading.martingaleMultipliers;
        this.maxSteps = config.trading.maxSteps;
        this.activeStates = new Map();
    }

    getState(userId, user, currency, baseAmount) {        
        const memoryState = this.activeStates.get(userId);
        if (memoryState && memoryState.baseAmount === baseAmount) {
            return memoryState;
        }

        const dbState = user?.martingale || {};
        const losses = dbState.loss_streak || 0;
        const step = Math.min(losses, this.multipliers.length - 1);
        const amount = baseAmount * this.multipliers[step];

        const state = {
            step,
            losses,
            baseAmount,
            currentAmount: amount,
            currency,
            initialBalance: dbState.initial_balance || 0  
        };

        this.activeStates.set(userId, state);
        return state;
    }

    reset(userId, state) {
        logger.info(`🔄 User ${userId}: Resetting martingale to base ${state.baseAmount}`);
        state.step = 0;
        state.losses = 0;
        state.currentAmount = state.baseAmount;
        this.activeStates.set(userId, state);
        return state;
    }

    advance(userId, state) {
        state.losses++;
        
        if (state.losses >= this.maxSteps) {
            logger.info(`🚨 User ${userId}: ${this.maxSteps} losses reached - Safety reset`);
            return this.reset(userId, state);
        }

        state.step = Math.min(state.losses, this.multipliers.length - 1);
        state.currentAmount = state.baseAmount * this.multipliers[state.step];

        logger.info(`📉 User ${userId}: Next amount = ${state.currentAmount} (Step ${state.step + 1}/${this.maxSteps})`);
        this.activeStates.set(userId, state);
        return state;
    }

    clearState(userId) {
        this.activeStates.delete(userId);
    }
}

module.exports = Martingale;
