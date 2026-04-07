const express = require('express');
const config = require('../config');
const logger = require('../utils/logger');
const { authenticate } = require('./middleware/auth');
const SignalHandler = require('./handlers/signal-handler');

class WebhookServer {
    constructor(tradingBot) {
        this.app = express();
        this.tradingBot = tradingBot;
        this.signalHandler = new SignalHandler(tradingBot);
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(express.json());
    }

    setupRoutes() {
        this.app.post('/api/tradingview', authenticate, async (req, res) => {
            try {
                const result = await this.signalHandler.handle(req.body);
                res.json(result);
            } catch (error) {
                logger.error('Error processing webhook:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', timestamp: new Date().toISOString() });
        });
    }

    start() {
        const port = config.webhook.port;
        console.log(`[DEBUG] Webhook server trying to start on port ${port}`);
        this.app.listen(port, '0.0.0.0', () => {
            logger.info(`��� TradingView webhook receiver listening on port ${port}`);
            logger.info(`   Endpoint: POST /api/tradingview`);
            logger.info(`   Health: GET /health`);
        });
    }
}

module.exports = WebhookServer;
