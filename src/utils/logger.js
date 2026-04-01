const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
const logFile = fs.createWriteStream(path.join(logDir, 'bot.log'), { flags: 'a' });

function formatMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const argsStr = args.length ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
    return `[${timestamp}] [${level}] ${message}${argsStr}\n`;
}

function logToFile(level, message, ...args) {
    const formatted = formatMessage(level, message, ...args);
    logFile.write(formatted);
    console.log(formatted.trim());
}

module.exports = {
    info: (message, ...args) => logToFile('INFO', message, ...args),
    error: (message, ...args) => logToFile('ERROR', message, ...args),
    warn: (message, ...args) => logToFile('WARN', message, ...args),
    debug: (message, ...args) => logToFile('DEBUG', message, ...args)
};