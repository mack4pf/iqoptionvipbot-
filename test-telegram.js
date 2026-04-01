const { Telegraf } = require('telegraf');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error("No TELEGRAM_BOT_TOKEN found in .env");
    process.exit(1);
}
console.log("Token length:", token.length);
const bot = new Telegraf(token);
bot.telegram.getMe().then(info => {
    console.log("Bot info:", info);
    process.exit(0);
}).catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
});