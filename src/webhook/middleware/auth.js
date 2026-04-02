const config = require('../../config');
const logger = require('../../utils/logger');

function authenticate(req, res, next) {
    // Check Header, Query Parameter, or JSON Body for the secret code
    const adminSecret = req.headers['x-admin-secret'] || req.query.secret || req.body.secret;
    
    if (!adminSecret || adminSecret.toString() !== config.webhook.secret.toString()) {
        logger.warn(`Unauthorized webhook attempt from ${req.ip} - Provided secret: ${adminSecret}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

module.exports = { authenticate };
