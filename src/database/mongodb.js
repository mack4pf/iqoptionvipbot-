const { MongoClient } = require('mongodb');
const config = require('../config');
const { encrypt, decrypt } = require('../utils/encryption');
const logger = require('../utils/logger');

class MongoDB {
    constructor() {
        this.uri = config.mongodb.uri;
        this.dbName = config.mongodb.dbName;
        this.client = null;
        this.db = null;
    }

    async connect() {
        try {
            this.client = new MongoClient(this.uri);
            await this.client.connect();
            this.db = this.client.db(this.dbName);
            await this.createIndexes();
            await this.ensureAdminUser();
            logger.info('✅ Connected to MongoDB');
            return this.db;
        } catch (error) {
            logger.error('❌ MongoDB connection failed:', error);
            throw error;
        }
    }

    async createIndexes() {
        const users = this.db.collection('users');
        const codes = this.db.collection('access_codes');
        const channels = this.db.collection('signal_channels');
        const trades = this.db.collection('trades');
        const settings = this.db.collection('settings');
        const accounts = this.db.collection('accounts');

        // Users collection indexes - with error handling
        try {
            await users.createIndex({ email: 1 }, { unique: false });
        } catch (err) {
            if (err.code !== 86) logger.warn('Email index error:', err.message);
        }

        try {
            await users.createIndex({ ssid: 1 }, { sparse: true });
        } catch (err) {
            if (err.code !== 86) logger.warn('SSID index error:', err.message);
        }

        try {
            await users.createIndex({ last_active: -1 });
        } catch (err) {
            if (err.code !== 86) logger.warn('Last active index error:', err.message);
        }

        try {
            await users.createIndex({ access_expires_at: 1 });
        } catch (err) {
            if (err.code !== 86) logger.warn('Access expires index error:', err.message);
        }

        // Access codes collection indexes
        try {
            await codes.createIndex({ code: 1 }, { unique: true });
        } catch (err) {
            if (err.code !== 86) logger.warn('Code index error:', err.message);
        }

        try {
            await codes.createIndex({ expires_at: 1 });
        } catch (err) {
            if (err.code !== 86) logger.warn('Code expires index error:', err.message);
        }

        try {
            await codes.createIndex({ used_by: 1 });
        } catch (err) {
            if (err.code !== 86) logger.warn('Code used_by index error:', err.message);
        }

        // Signal channels collection indexes
        try {
            await channels.createIndex({ channel_id: 1 }, { unique: true });
        } catch (err) {
            if (err.code !== 86) logger.warn('Channel ID index error:', err.message);
        }

        // Trades collection indexes
        try {
            await trades.createIndex({ user_id: 1, close_time: -1 });
        } catch (err) {
            if (err.code !== 86) logger.warn('User trades index error:', err.message);
        }

        try {
            await trades.createIndex({ trade_id: 1 }, { unique: true });
        } catch (err) {
            if (err.code !== 86) logger.warn('Trade ID index error:', err.message);
        }

        // Settings collection indexes
        try {
            await settings.createIndex({ key: 1 }, { unique: true });
        } catch (err) {
            if (err.code !== 86) logger.warn('Settings key index error:', err.message);
        }

        // Accounts collection indexes
        try {
            await accounts.createIndex({ owner_id: 1 });
            await accounts.createIndex({ email: 1 }, { unique: true });
        } catch (err) {
            if (err.code !== 86) logger.warn('Accounts index error:', err.message);
        }

        logger.info('✅ Database indexes verified');
    }

    async ensureAdminUser() {
        if (!config.telegram.adminIds || config.telegram.adminIds.length === 0) return;

        try {
            const users = this.db.collection('users');
            
            for (const adminId of config.telegram.adminIds) {
                if (!adminId) continue;
                
                const admin = await users.findOne({ _id: adminId });

                if (!admin) {
                    await users.insertOne({
                        _id: adminId,
                        email: 'admin@local',
                        password_encrypted: 'admin',
                        account_type: 'PRACTICE',
                        tradeAmount: 1500,
                        balance: 0,
                        copyAdminEnabled: false,
                        autoTraderEnabled: true,
                        connected: false,
                        created_at: new Date(),
                        last_active: new Date(),
                        is_admin: true,
                        access_expires_at: new Date('2099-12-31'),
                        ssid: null,
                        ssid_updated_at: null,
                        stats: { total_trades: 0, wins: 0, losses: 0, total_profit: 0 },
                        martingale: { current_step: 0, current_amount: null, loss_streak: 0, base_amount: null, initial_balance: 0 }
                    });
                    logger.info(`✅ Admin user created: ${adminId}`);
                } else if (!admin.is_admin) {
                    await users.updateOne(
                        { _id: adminId },
                        { $set: { is_admin: true, access_expires_at: new Date('2099-12-31') } }
                    );
                    logger.info(`✅ Admin privileges updated: ${adminId}`);
                }
            }
        } catch (error) {
            logger.error('Error ensuring admin users:', error.message);
        }
    }

    async getUser(chatId) {
        const users = this.db.collection('users');
        return await users.findOne({ _id: chatId.toString() });
    }

    async updateUser(chatId, updates) {
        const users = this.db.collection('users');
        updates.last_active = new Date();
        return await users.updateOne(
            { _id: chatId.toString() },
            { $set: updates }
        );
    }

    async getAllUsers() {
        const users = this.db.collection('users');
        return await users.find({}).toArray();
    }

    async deleteUser(chatId) {
        const users = this.db.collection('users');
        return await users.deleteOne({ _id: chatId.toString() });
    }

    async storeUserSsid(chatId, ssid) {
        const users = this.db.collection('users');
        return await users.updateOne(
            { _id: chatId.toString() },
            { $set: { ssid, ssid_updated_at: new Date(), connected: true } }
        );
    }

    async getUserSsid(chatId) {
        const users = this.db.collection('users');
        const user = await users.findOne({ _id: chatId.toString() });
        return user?.ssid || null;
    }

    async clearUserSsid(chatId) {
        const users = this.db.collection('users');
        return await users.updateOne(
            { _id: chatId.toString() },
            { $set: { ssid: null, connected: false } }
        );
    }

    // --- Account Management Methods ---

    async addAccount(ownerId, email, password, accountType = 'PRACTICE', tradeAmount = 1500) {
        const accounts = this.db.collection('accounts');
        const account = {
            owner_id: ownerId.toString(),
            email,
            password_encrypted: encrypt(password),
            account_type: accountType,
            tradeAmount,
            balance: 0,
            connected: false,
            created_at: new Date(),
            last_active: new Date(),
            ssid: null,
            ssid_updated_at: null,
            stats: { total_trades: 0, wins: 0, losses: 0, total_profit: 0 },
            martingale: { current_step: 0, current_amount: null, loss_streak: 0, base_amount: tradeAmount, initial_balance: 0 }
        };
        await accounts.updateOne(
            { email },
            { $set: account },
            { upsert: true }
        );
        return account;
    }

    async getAccounts(ownerId) {
        const accounts = this.db.collection('accounts');
        return await accounts.find({ owner_id: ownerId.toString() }).toArray();
    }

    async getAllAccounts() {
        const accounts = this.db.collection('accounts');
        return await accounts.find({}).toArray();
    }

    async updateAccount(email, updates) {
        const accounts = this.db.collection('accounts');
        updates.last_active = new Date();
        return await accounts.updateOne(
            { email },
            { $set: updates }
        );
    }

    async deleteAccount(email) {
        const accounts = this.db.collection('accounts');
        return await accounts.deleteOne({ email });
    }

    async storeAccountSsid(email, ssid) {
        const accounts = this.db.collection('accounts');
        return await accounts.updateOne(
            { email },
            { $set: { ssid, ssid_updated_at: new Date(), connected: true } }
        );
    }

    async getAccountSsid(email) {
        const accounts = this.db.collection('accounts');
        const acc = await accounts.findOne({ email });
        return acc?.ssid || null;
    }

    async hasValidSession(chatId) {
        const users = this.db.collection('users');
        const user = await users.findOne({ _id: chatId.toString() });
        if (!user || !user.ssid) return false;

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        if (user.ssid_updated_at && user.ssid_updated_at < thirtyDaysAgo) {
            await this.clearUserSsid(chatId);
            return false;
        }
        return true;
    }

    async createAccessCode(adminChatId, daysValid = 30) {
        const codes = this.db.collection('access_codes');
        const code = this.generateUniqueCode();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + daysValid);

        await codes.insertOne({
            code,
            created_by: adminChatId.toString(),
            created_at: new Date(),
            expires_at: expiresAt,
            used_by: null,
            used_at: null,
            active: true
        });
        return code;
    }

    async validateAccessCode(code) {
        const codes = this.db.collection('access_codes');
        return await codes.findOne({
            code,
            active: true,
            used_by: null,
            expires_at: { $gt: new Date() }
        });
    }

    async useAccessCode(code, userChatId) {
        const codes = this.db.collection('access_codes');
        const result = await codes.updateOne(
            { code, used_by: null },
            { $set: { used_by: userChatId.toString(), used_at: new Date(), active: false } }
        );
        return result.modifiedCount > 0;
    }

    async getActiveCodes() {
        const codes = this.db.collection('access_codes');
        return await codes.find({ active: true, expires_at: { $gt: new Date() } }).toArray();
    }

    generateUniqueCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const segments = [];
        for (let i = 0; i < 3; i++) {
            let segment = '';
            for (let j = 0; j < 4; j++) {
                segment += chars[Math.floor(Math.random() * chars.length)];
            }
            segments.push(segment);
        }
        return `IQ-${segments.join('-')}`;
    }

    async registerUserWithCode(chatId, email, password, code) {
        const accessCode = await this.validateAccessCode(code);
        if (!accessCode) throw new Error('Invalid or expired access code');
        await this.useAccessCode(code, chatId);

        const users = this.db.collection('users');
        const existing = await users.findOne({ _id: chatId.toString() });
        if (existing) throw new Error('User already registered');

        const user = {
            _id: chatId.toString(),
            email,
            password_encrypted: encrypt(password),
            account_type: 'PRACTICE',
            tradeAmount: 1500,
            copyAdminEnabled: false,
            autoTraderEnabled: true,
            balance: 0,
            connected: false,
            created_at: new Date(),
            last_active: new Date(),
            access_code: code,
            access_expires_at: accessCode.expires_at,
            is_admin: false,
            stats: { total_trades: 0, wins: 0, losses: 0, total_profit: 0 },
            martingale: { current_step: 0, current_amount: null, loss_streak: 0, base_amount: null, initial_balance: 0 },
            ssid: null,
            ssid_updated_at: null
        };
        await users.insertOne(user);
        return user;
    }

    async hasValidAccess(chatId) {
        const users = this.db.collection('users');
        const user = await users.findOne({ _id: chatId.toString() });
        if (!user) return false;
        if (user.is_admin) return true;
        return user.access_expires_at && new Date(user.access_expires_at) > new Date();
    }

    async addSignalChannel(adminChatId, channelId, channelName) {
        const channels = this.db.collection('signal_channels');
        await channels.insertOne({
            channel_id: channelId,
            channel_name: channelName,
            added_by: adminChatId.toString(),
            added_at: new Date(),
            active: true,
            signal_count: 0
        });
    }

    async removeSignalChannel(channelId) {
        const channels = this.db.collection('signal_channels');
        return await channels.deleteOne({ channel_id: channelId });
    }

    async getActiveChannels() {
        const channels = this.db.collection('signal_channels');
        return await channels.find({ active: true }).toArray();
    }

    async incrementChannelSignalCount(channelId) {
        const channels = this.db.collection('signal_channels');
        return await channels.updateOne(
            { channel_id: channelId },
            { $inc: { signal_count: 1 } }
        );
    }

    async saveTrade(tradeData) {
        const trades = this.db.collection('trades');
        await trades.insertOne(tradeData);
    }

    async getGlobalSetting(key, defaultValue = 5) {
        const settings = this.db.collection('settings');
        const setting = await settings.findOne({ key });
        if (setting) return setting.value;

        await settings.updateOne(
            { key },
            { $set: { value: defaultValue, updated_at: new Date() } },
            { upsert: true }
        );
        return defaultValue;
    }

    async setGlobalSetting(key, value) {
        const settings = this.db.collection('settings');
        await settings.updateOne(
            { key },
            { $set: { value, updated_at: new Date() } },
            { upsert: true }
        );
        return true;
    }

    async close() {
        if (this.client) await this.client.close();
    }
}

module.exports = MongoDB;