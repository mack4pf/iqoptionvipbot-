require('dotenv').config();

module.exports = {
    mongodb: {
        uri: process.env.MONGODB_URI,
        dbName: 'trading_bot'
    },
    encryption: {
        key: process.env.ENCRYPTION_KEY
    },
    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN,
        adminId: process.env.ADMIN_CHAT_ID
    },
    webhook: {
        secret: process.env.SIGNAL_SECRET,
        port: process.env.API_PORT || 3000
    },
    iqoption: {
        loginUrl: 'https://auth.iqoption.com/api/v1.0/login',
        wsUrl: 'wss://ws.iqoption.com/echo/websocket',
        email: process.env.IQ_EMAIL,
        password: process.env.IQ_PASSWORD
    },
    proxy: {
        host: process.env.IPROYAL_HOST,
        port: parseInt(process.env.IPROYAL_PORT),
        username: process.env.IPROYAL_USERNAME,
        password: process.env.IPROYAL_PASSWORD,
        protocol: process.env.IPROYAL_PROTOCOL
    },
    trading: {
        martingaleMultipliers: [1, 1, 1, 1, 4, 8, 16, 32],
        maxSteps: 8,
        cooldownSeconds: 10,
        defaultDuration: 5,
        currencyLimits: {
            NGN: { min: 1500, max: 50000000 },
            USD: { min: 1, max: 10000000 },
            EUR: { min: 1, max: 100000 },
            GBP: { min: 1, max: 100000 },
            BRL: { min: 5, max: 500000 }
        }
    },
    redis: {
        url: process.env.REDIS_URL,
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined
    }
};