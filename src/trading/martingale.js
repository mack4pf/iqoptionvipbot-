const config = require('../config');
const logger = require('../utils/logger');

class Martingale {
    constructor() {
        this.multipliers = config.trading.martingaleMultipliers;
        this.maxSteps = config.trading.maxSteps;
        this.activeStates = new Map();
        logger.info(`📊 Martingale initialized with multipliers: [${this.multipliers}] (maxSteps=${this.maxSteps})`);
    }

    buildState(dbState, currency, baseAmount) {
        const losses = Number(dbState.loss_streak) || 0;
        const step = Math.min(losses, this.multipliers.length - 1);

        return {
            step,
            losses,
            baseAmount,
            currentAmount: baseAmount * this.multipliers[step],
            currency,
            initialBalance: dbState.initial_balance || 0
        };
    }

    getState(userId, user, currency, baseAmount) {
        const key = userId;
        const dbState = user?.martingale || {};
        const resolvedState = this.buildState(dbState, currency, baseAmount);
        const memoryState = this.activeStates.get(key);

        if (
            memoryState &&
            memoryState.baseAmount === resolvedState.baseAmount &&
            memoryState.losses === resolvedState.losses &&
            memoryState.step === resolvedState.step &&
            memoryState.currentAmount === resolvedState.currentAmount
        ) {
            logger.info(`📊 [${key}] Using memory state: losses=${memoryState.losses}, step=${memoryState.step}, amount=${memoryState.currentAmount}`);
            return memoryState;
        }

        this.activeStates.set(key, resolvedState);
        logger.info(`📊 [${key}] DB loaded state: losses=${resolvedState.losses}, step=${resolvedState.step}, amount=${resolvedState.currentAmount}, base=${baseAmount}`);
        return resolvedState;
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