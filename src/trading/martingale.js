const config = require('../config');
const logger = require('../utils/logger');

class Martingale {
    constructor() {
        this.multipliers = config.trading.martingaleMultipliers;
        this.maxSteps = config.trading.maxSteps;
        this.activeStates = new Map();
        logger.info(`📊 Martingale initialized with multipliers: [${this.multipliers}] (maxSteps=${this.maxSteps})`);
    }

    getState(userId, user, currency, baseAmount) {
        const key = userId;
        const memoryState = this.activeStates.get(key);
        if (memoryState && memoryState.baseAmount === baseAmount) {
            logger.info(`📊 [${key}] Using memory state: losses=${memoryState.losses}, step=${memoryState.step}, amount=${memoryState.currentAmount}`);
            return memoryState;
        }

        const dbState = user?.martingale || {};
        let losses = dbState.loss_streak || 0;
        // FIX: step = losses (capped) – after 2 losses, step=2 → multiplier[2]=2
        let step = Math.min(losses, this.multipliers.length - 1);
        let amount = baseAmount * this.multipliers[step];

        const state = {
            step,
            losses,
            baseAmount,
            currentAmount: amount,
            currency,
            initialBalance: dbState.initial_balance || 0
        };

        this.activeStates.set(key, state);
        logger.info(`📊 [${key}] DB loaded state: losses=${state.losses}, step=${state.step}, amount=${state.currentAmount}, base=${baseAmount}`);
        return state;
    }

    reset(userId, state) {
        const key = userId;
        logger.info(`🔄 [${key}] Resetting martingale from losses=${state.losses}, step=${state.step}, amount=${state.currentAmount} to base ${state.baseAmount}`);
        state.step = 0;
        state.losses = 0;
        state.currentAmount = state.baseAmount;
        this.activeStates.set(key, state);
        return state;
    }

    advance(userId, state) {
        const key = userId;
        logger.info(`📈 [${key}] Advancing martingale: current losses=${state.losses}, step=${state.step}, amount=${state.currentAmount}`);
        state.losses++;

        if (state.losses >= this.maxSteps) {
            logger.info(`🚨 [${key}] ${this.maxSteps} losses reached - Safety reset`);
            return this.reset(userId, state);
        }

        // NEW STEP = LOSSES (not losses-1)
        const newStep = Math.min(state.losses, this.multipliers.length - 1);
        const newAmount = state.baseAmount * this.multipliers[newStep];
        logger.info(`📈 [${key}] New step=${newStep}, multiplier=${this.multipliers[newStep]}, new amount=${newAmount}`);

        state.step = newStep;
        state.currentAmount = newAmount;
        this.activeStates.set(key, state);
        return state;
    }

    clearState(userId) {
        this.activeStates.delete(userId);
    }
}

module.exports = Martingale;