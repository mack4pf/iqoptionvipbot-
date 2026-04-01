const config = require('../../config');
const logger = require('../../utils/logger');

function authenticate(req, res, next) {
    const adminSecret = req.headers['x-admin-secret'];
    if (!adminSecret || adminSecret !== config.webhook.secret) {
        logger.warn(`Unauthorized webhook attempt from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

module.exports = { authenticate };
