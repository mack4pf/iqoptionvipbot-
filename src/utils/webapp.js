const axios = require('axios');

const WEBAPP_URL = process.env.WEBAPP_URL;
const API_KEY = process.env.WEBAPP_API_KEY;
const BOT_ID = process.env.BOT_ID;

const subCache = new Map();
const settingsSyncCache = new Map();
const CACHE_TTL = 60000; // 1 minute
const THROTTLE_TTL = 10000; // 10 seconds throttle for settings

async function callWebApp(endpoint, method = 'GET', data = null) {
  const url = `${WEBAPP_URL}/api/internal/bot/${BOT_ID}${endpoint}`;
  const headers = { 'X-Bot-API-Key': API_KEY, 'Content-Type': 'application/json' };
  const config = { method, url, headers };
  if (data) config.data = data;
  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errData = error.response?.data;
    if (typeof errData === 'string' && errData.includes('<html')) {
      console.error(`WebApp API error to ${endpoint}: ${error.response?.status} - HTML response (Server might be down or waking up).`);
    } else {
      console.error(`WebApp API error to ${endpoint}:`, errData || error.message);
    }
    throw error;
  }
}

module.exports = {
  checkSubscription: async (email) => {
    const now = Date.now();
    if (subCache.has(email)) {
      const cached = subCache.get(email);
      if (now - cached.timestamp < CACHE_TTL) return cached.data;
    }
    const data = await callWebApp(`/user/${email}/subscription`);
    subCache.set(email, { data, timestamp: now });
    return data;
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
    return callWebApp(`/user/${email}/settings`, 'POST', settings);
  },
};
