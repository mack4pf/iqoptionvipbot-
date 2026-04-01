const logger = require('../../utils/logger');

class SignalHandler {
    constructor(tradingBot) {
        this.tradingBot = tradingBot;
        this.recentSignals = new Map();
    }

    async handle(signalData) {
        const { chat_id, signal, position, ticker, price, result } = signalData;
        
        logger.info(`��� TradingView webhook received:`);
        logger.info(`   chat_id: ${chat_id}`);
        logger.info(`   signal: ${signal}`);
        logger.info(`   ticker: ${ticker}`);
        
        let direction = null;
        const rawSignal = signal?.toLowerCase().trim();
        
        if (['buy', 'long', 'open_long', 'enter_long'].includes(rawSignal)) {
            direction = 'call';
        } else if (['sell', 'short', 'open_short', 'enter_short'].includes(rawSignal)) {
            direction = 'put';
        } else {
            logger.warn(`⚠️ Unknown signal: "${signal}" - ignoring`);
            return { error: 'Unknown signal type' };
        }
        
        const duration = await this.tradingBot.db.getGlobalSetting('trade_duration', 5);
        
        const signalId = `TV_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        
        logger.info(`🚨 Processing: ${direction} on ${ticker} for ${duration} min`);
        
        if (this.tradingBot && this.tradingBot.signalQueue) {
            this.tradingBot.signalQueue.addSignal({
                asset: ticker,
                direction: direction,
                duration: duration,
                price: price,
                signalId: signalId
            }).catch(err => logger.error('❌ Queue execution error:', err));
        } else if (this.tradingBot) {
            this.tradingBot.executeSignalForAllUsers({
                asset: ticker,
                direction: direction,
                duration: duration,
                price: price,
                signalId: signalId
            }).catch(err => logger.error('❌ Signal execution error:', err));
        }
        
        return { success: true, signalId, direction, duration };
    }
}

module.exports = SignalHandler;
