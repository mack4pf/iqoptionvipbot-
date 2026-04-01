const config = require('./src/config');
const TelegramBot = require('./src/telegram/bot');

async function test() {
    console.log("Test starting");
    const db = { dummy: true };
    const tradingBot = {};
    console.log("Creating bot");
    const bot = new TelegramBot(db, tradingBot);
    console.log("Bot created, calling start()");
    await bot.start();
    console.log("Start returned");
}

test().catch(console.error);