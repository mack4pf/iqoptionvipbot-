const axios = require('axios');

const WEBAPP_URL = process.env.WEBAPP_URL;
const API_KEY = process.env.WEBAPP_API_KEY;
const BOT_ID = process.env.BOT_ID;

const subCache = new Map();
const settingsSyncCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;  // 5 minutes (was 1 min - caused too many calls)
const THROTTLE_TTL = 10000;        // 10 seconds throttle for settings
const API_TIMEOUT = 5000;          // 5 second timeout - CRITICAL: prevents event loop starvation

// Track in-flight subscription requests to avoid duplicate concurrent calls for same email
const inflightSubRequests = new Map();

async function callWebApp(endpoint, method = 'GET', data = null) {
  const url = `${WEBAPP_URL}/api/internal/bot/${BOT_ID}${endpoint}`;
  const headers = { 'X-Bot-API-Key': API_KEY, 'Content-Type': 'application/json' };
  const config = { method, url, headers, timeout: API_TIMEOUT };
  if (data) config.data = data;
  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errData = error.response?.data;
    if (typeof errData === 'string' && errData.includes('<html')) {
      console.error(`WebApp API error to ${endpoint}: ${error.response?.status} - HTML response (Server might be down or waking up).`);
    } else if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      console.error(`WebApp API timeout for ${endpoint} after ${API_TIMEOUT}ms`);
    } else {
      console.error(`WebApp API error to ${endpoint}:`, errData || error.message);
    }
    throw error;
  }
}

module.exports = {
  checkSubscription: async (email) => {
    const now = Date.now();

    // Serve from cache first (5 min TTL)
    if (subCache.has(email)) {
      const cached = subCache.get(email);
      if (now - cached.timestamp < CACHE_TTL) return cached.data;
    }

    // Deduplicate concurrent requests for the same email
    // If a request is already in-flight for this email, wait for it instead of firing a new one
    if (inflightSubRequests.has(email)) {
      return inflightSubRequests.get(email);
    }

    const requestPromise = callWebApp(`/user/${email}/subscription`)
      .then(data => {
        subCache.set(email, { data, timestamp: Date.now() });
        inflightSubRequests.delete(email);
        return data;
      })
      .catch(err => {
        inflightSubRequests.delete(email);
        // FAIL-OPEN: If we can't reach the server, allow trade to proceed
        // This prevents the bot from freezing 30 accounts just because Render is sleeping
        console.warn(`⚠️ Subscription check failed for ${email}, allowing trade (fail-open):`, err.message);
        return { valid: true, _failOpen: true };
      });

    inflightSubRequests.set(email, requestPromise);
    return requestPromise;
  },

  getCredentials: (email) => callWebApp(`/user/${email}/credentials`),

  updateSettings: (email, settings) => {
    // Throttle settings updates to prevent spamming the server (min 10s between syncs)
    const now = Date.now();
    const lastSync = settingsSyncCache.get(email) || 0;

    // Only allow if it's been at least 10 seconds
    if (now - lastSync < THROTTLE_TTL) {
      // If it's only a balance/currency update, silent drop is fine
      if (settings.balance !== undefined && Object.keys(settings).length <= 2) {
        return Promise.resolve();
      }
    }

    settingsSyncCache.set(email, now);
    return callWebApp(`/user/${email}/settings`, 'POST', settings).catch(err => {
      // Don't let settings sync errors crash anything
      console.warn(`⚠️ Settings sync failed for ${email}:`, err.message);
    });
  },
};
