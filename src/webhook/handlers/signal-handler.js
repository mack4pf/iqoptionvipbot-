const logger = require('../../utils/logger');

class SignalHandler {
    constructor(tradingBot) {
        this.tradingBot = tradingBot;
        // Global cache for all assets (not per user) to detect results
        this.recentSignals = new Map(); // key = ticker, value = timestamp
        this.resultWindowMinutes = 6; // configurable
    }

    async handle(signalData) {
        let { chat_id, signal, position, ticker, price, result } = signalData;

        // ❌ REMOVED the result field check entirely.
        // We rely on time-based deduplication instead.

        logger.info(`🚨 Incoming TradingView Webhook:`);
        logger.info(`   Raw Ticker: ${ticker} | Signal: ${signal} | Chat: ${chat_id}`);

        // Clean ticker
        if (ticker && ticker.includes(':')) {
            ticker = ticker.split(':').pop();
        }
        ticker = ticker?.toUpperCase().trim().replace(/\.|\s/g, '-');

        // Determine direction
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

        const now = Date.now();
        const windowMs = this.resultWindowMinutes * 60 * 1000;

        // 🔍 Check if this ticker had a recent alert (within 6 minutes)
        const lastTime = this.recentSignals.get(ticker);
        if (lastTime && (now - lastTime) < windowMs) {
            const secondsAgo = Math.round((now - lastTime) / 1000);
            logger.info(`⏸️ Ignoring result for ${ticker} (last alert was ${secondsAgo}s ago)`);
            // Still record this result to extend the window if needed? Optional.
            return { ignored: true, reason: 'result_detected' };
        }

        // ✅ It's a fresh signal – record it and proceed
        this.recentSignals.set(ticker, now);

        // Periodic cleanup to prevent memory bloat
        if (this.recentSignals.size > 100) {
            for (const [key, ts] of this.recentSignals) {
                if (now - ts > windowMs * 2) this.recentSignals.delete(key);
            }
        }

        // Get duration from DB
        const duration = await this.tradingBot.db.getGlobalSetting('trade_duration', 5);
        const signalId = `TV_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

        logger.info(`🚀 Processing ${direction} on ${ticker} (${duration}m)`);

        // Execute signal
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