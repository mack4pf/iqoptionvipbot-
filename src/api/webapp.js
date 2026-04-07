const crypto = require('crypto');

class WebAppClient {
  constructor() {
    this.baseUrl = process.env.WEBAPP_URL;
    this.apiKey = process.env.WEBAPP_API_KEY;
    this.botId = process.env.WEBAPP_BOT_ID;
    this.encryptionKey = process.env.ENCRYPTION_KEY;
    this.enabled = this.baseUrl && this.apiKey && this.botId;
  }

  // Decrypt password received from web app
  decryptPassword(encryptedHex) {
    if (!encryptedHex || !this.encryptionKey) return null;
    try {
      const key = Buffer.from(this.encryptionKey, 'hex');
      const [ivHex, encrypted] = encryptedHex.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      console.log('❌ Decryption failed:', error.message);
      return null;
    }
  }

  // Fetch with timeout helper
  async fetchWithTimeout(url, options = {}, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      throw error;
    }
  }

  // Get user credentials and settings from web app
  async getUserSettings(email) {
    if (!this.enabled) return null;
    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/internal/bot/${this.botId}/user/${encodeURIComponent(email)}/credentials`,
        { headers: { 'X-Bot-API-Key': this.apiKey } },
        5000
      );
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      console.log('⚠️ Web app API error (using local settings):', error.message);
      return null;
    }
  }

  // Check subscription status
  async checkSubscription(email) {
    if (!this.enabled) return null;
    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/internal/bot/${this.botId}/user/${encodeURIComponent(email)}/subscription`,
        { headers: { 'X-Bot-API-Key': this.apiKey } },
        5000
      );
      if (!response.ok) return null;
      const data = await response.json();
      return data.valid === true;
    } catch (error) {
      console.log('⚠️ Web app subscription check failed (using local):', error.message);
      return null;
    }
  }

  // Sync settings when user changes via Telegram
  async syncUserSettings(email, settings) {
    if (!this.enabled) return false;
    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/internal/bot/${this.botId}/user/${encodeURIComponent(email)}/settings`,
        {
          method: 'POST',
          headers: { 'X-Bot-API-Key': this.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        },
        5000
      );
      return response.ok;
    } catch (error) {
      console.log('⚠️ Failed to sync settings to web app:', error.message);
      return false;
    }
  }

  // Get credentials for login (when user doesn't provide password)
  async getUserCredentials(email) {
    return this.getUserSettings(email);
  }
}

module.exports = new WebAppClient();
