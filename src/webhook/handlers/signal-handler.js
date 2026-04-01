const logger = require('../../utils/logger');

class SignalHandler {
    constructor(tradingBot) {
        this.tradingBot = tradingBot;
        this.recentSignals = new Map();
    }

    async handle(signalData) {
        let { chat_id, signal, position, ticker, price, result } = signalData;
        
        logger.info(`🚨 Incoming TradingView Webhook:`);
        logger.info(`   Raw Ticker: ${ticker} | Signal: ${signal} | Chat: ${chat_id}`);
        
        // 1. Clean the ticker (remove prefixes like "BINANCE:", "FX:", "OANDA:", or "COINBASE:")
        if (ticker && ticker.includes(':')) {
            ticker = ticker.split(':').pop();
        }
        
        // Normalize symbol format (ensure it's uppercase and dots/spaces become dashes)
        // This ensures "EURUSD.OTC" matches "EURUSD-OTC" in our asset map
        ticker = ticker?.toUpperCase().trim().replace(/\.|\s/g, '-');
        
        // 2. Determine the trade direction (support strategy terms and direct signals)
        let direction = null;
        const rawSignal = signal?.toLowerCase().trim();
        
        if (['buy', 'long', 'open_long', 'enter_long', 'call'].includes(rawSignal)) {
            direction = 'call';
        } else if (['sell', 'short', 'open_short', 'enter_short', 'put'].includes(rawSignal)) {
            direction = 'put';
        } else {
            logger.warn(`⚠️ Unknown signal type received: "${signal}" - ignoring webhook.`);
            return { error: 'Unknown signal type' };
        }
        
        // 3. Execution Logic
        const duration = await this.tradingBot.db.getGlobalSetting('trade_duration', 5);
        const signalId = `TV_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        
        logger.info(`🚀 Processing ${direction} on ${ticker} (${duration}m)`);
        
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
        
        return { success: true, ticker, direction, duration };
    }
}

module.exports = SignalHandler;
