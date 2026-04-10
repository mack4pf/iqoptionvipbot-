const logger = require('../../utils/logger');

class SignalHandler {
    constructor(tradingBot) {
        this.tradingBot = tradingBot;
        this.lastSignalTime = new Map(); // key = `${chat_id}_${ticker}` → timestamp
        this.cooldownMinutes = 5; // adjustable
    }

    async handle(signalData) {
        let { chat_id, signal, position, ticker, price, result } = signalData;

        // 1. Ignore result messages
        if (result && result !== '') {
            logger.info(`⏸️ Ignoring result message (trade result): ${result}`);
            return { ignored: true, reason: 'result_message' };
        }

        logger.info(`🚨 Incoming TradingView Webhook:`);
        logger.info(`   Raw Ticker: ${ticker} | Signal: ${signal} | Chat: ${chat_id}`);

        // 2. Clean ticker
        if (ticker && ticker.includes(':')) {
            ticker = ticker.split(':').pop();
        }
        ticker = ticker?.toUpperCase().trim().replace(/\.|\s/g, '-');

        // 3. Determine direction
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

        // 4. Cooldown per (chat_id, asset)
        const key = `${chat_id || 'default'}_${ticker}`;
        const now = Date.now();
        const lastTime = this.lastSignalTime.get(key);
        const cooldownMs = this.cooldownMinutes * 60 * 1000;

        if (lastTime && (now - lastTime) < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - (now - lastTime)) / 1000);
            logger.info(`⏸️ Duplicate signal for ${key} ignored (${remaining}s remaining in cooldown)`);
            return { ignored: true, reason: 'cooldown' };
        }

        this.lastSignalTime.set(key, now);

        // 5. Get duration from DB
        const duration = await this.tradingBot.db.getGlobalSetting('trade_duration', 5);
        const signalId = `TV_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        logger.info(`🚀 Processing ${direction} on ${ticker} (${duration}m)`);

        // 6. Queue or execute
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