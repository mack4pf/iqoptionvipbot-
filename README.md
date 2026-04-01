# IQ Option Trading Bot with TradingView Webhook

## Setup
1. Copy `.env.example` to `.env` and fill in your credentials
2. Run `npm install`
3. Run `npm start`

## Webhook URL
`POST http://your-server:3000/api/tradingview`

## TradingView JSON Format
```json
{
  "chat_id": "-1002495852516",
  "signal": "buy",
  "position": "1",
  "ticker": "EURUSD",
  "price": "1.0845",
  "result": "win"
}

---

### src/config/index.js

```bash
cat > src/config/index.js << 'EOF'
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
    }
};
