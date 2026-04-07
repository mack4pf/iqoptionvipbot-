const WebSocket = require('ws');
const axios = require('axios');
const tunnel = require('tunnel');
const config = require('../config');
const logger = require('../utils/logger');
const { getAssetId } = require('./asset-map');

class IQOptionClient {
    constructor(email, password, chatId = null, db = null) {
        this.email = email;
        this.password = password;
        this.chatId = chatId;
        this.db = db;
        this.ws = null;
        this.ssid = null;
        this.connected = false;
        this.pingInterval = null;

        // Account info
        this.accountType = 'REAL';
        this.balance = 0;
        this.currency = 'USD';
        this.balanceId = null;

        // Store both balances
        this.realBalance = 0;
        this.realCurrency = 'USD';
        this.realBalanceId = null;

        this.practiceBalance = 0;
        this.practiceCurrency = 'USD';
        this.practiceBalanceId = null;

        // Callbacks
        this.onTradeOpened = null;
        this.onTradeClosed = null;
        this.onBalanceChanged = null;

        // Asset mapping
        this.assetMap = {
            1861: 'EURUSD',
            2: 'GBPUSD',
            3: 'USDJPY',
            4: 'AUDUSD',
            5: 'USDCAD',
            6: 'USDCHF',
            7: 'NZDUSD',
            76: 'EURUSD-OTC',
            77: 'GBPUSD-OTC',
            78: 'AUDUSD-OTC',
            79: 'USDCAD-OTC',
            80: 'USDCHF-OTC',
            81: 'NZDUSD-OTC',
            82: 'USDJPY-OTC',
            2301: 'PENUSD-OTC',
            1961: 'GOLD',
        };
    }

    // Try to restore session from stored SSID
    async restoreSession() {
        if (!this.db) return false;

        try {
            let ssid = null;
            if (this.chatId && !this.email.includes('@')) { // Backward compatibility
                ssid = await this.db.getUserSsid(this.chatId);
            } else {
                ssid = await this.db.getAccountSsid(this.email);
            }
            
            if (!ssid) return false;

            this.ssid = ssid;
            logger.info(`✅ Account ${this.email}: Session restored`);
            return true;
        } catch (error) {
            logger.warn(`⚠️ Account ${this.email}: Session restore failed: ${error.message}`);
            return false;
        }
    }

    // Get proxy config using tunnel
    getProxyConfig() {
        if (!config.proxy.host) return null;

        return tunnel.httpsOverHttp({
            proxy: {
                host: config.proxy.host,
                port: config.proxy.port,
                proxyAuth: `${config.proxy.username}:${config.proxy.password}`
            }
        });
    }

    async login(useProxy = true) {
        // Try to restore session first
        if (await this.restoreSession()) {
            this.connect();
            return true;
        }

        logger.info(`🔐 User ${this.chatId} logging in...`);

        try {
            let requestConfig = {
                method: 'post',
                url: 'https://auth.iqoption.com/api/v1.0/login',
                data: {
                    email: this.email,
                    password: this.password
                },
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            };

            // Add proxy if enabled
            if (useProxy) {
                const httpsAgent = this.getProxyConfig();
                if (httpsAgent) {
                    requestConfig.httpsAgent = httpsAgent;
                    requestConfig.proxy = false;
                    logger.info(`🔄 User ${this.chatId} using proxy for login`);
                }
            }

            const response = await axios(requestConfig);

            if (response.data && response.data.data && response.data.data.ssid) {
                this.ssid = response.data.data.ssid;

                // Store SSID in database
                if (this.db) {
                    if (this.chatId && !this.email.includes('@')) {
                        await this.db.storeUserSsid(this.chatId, this.ssid);
                    } else {
                        await this.db.storeAccountSsid(this.email, this.ssid);
                    }
                    logger.info(`💾 SSID stored for account ${this.email}`);
                }

                logger.info(`✅ Account ${this.email} login successful`);

                // Connect WebSocket
                this.connect();
                return true;
            }

            return false;

        } catch (error) {
            logger.error(`❌ User ${this.chatId} login failed: ${error.message}`);
            return false;
        }
    }

    async logout() {
        if (this.db) {
            if (this.chatId && !this.email.includes('@')) {
                await this.db.clearUserSsid(this.chatId);
            } else {
                await this.db.updateAccount(this.email, { ssid: null, connected: false });
            }
            logger.info(`🗑️ SSID cleared for account ${this.email}`);
        }

        if (this.ws) {
            // Remove event listeners before closing to prevent unwanted reconnection attempts
            this.ws.removeAllListeners('close');
            this.ws.close();
            this.connected = false;
        }

        logger.info(`👋 Account ${this.email} logged out`);
    }

    connect() {
        if (!this.ssid) {
            logger.error('❌ No SSID. Please login first.');
            return;
        }

        logger.info(`🔄 Connecting WebSocket for user ${this.chatId}...`);

        const wsUrl = `wss://ws.iqoption.com/echo/websocket?ssid=${this.ssid}`;
        const agent = this.getProxyConfig();
        const wsOptions = agent ? { agent } : {};
        
        if (agent) {
            logger.info(`🔄 User ${this.chatId} connecting WebSocket via Proxy`);
        }
        
        this.ws = new WebSocket(wsUrl, wsOptions);

        this.ws.on('open', () => {
            logger.info(`✅ WebSocket connected for user ${this.chatId}`);
            this.connected = true;
            this.send({ name: 'ssid', msg: this.ssid });

            // Heartbeat
            this.pingInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.send({ name: 'heartbeat', msg: Date.now() });
                } else {
                    logger.warn(`⚠️ User ${this.chatId} WebSocket not open (state: ${this.ws?.readyState}), reconnecting...`);
                    this.disconnect();
                    this.connect();
                }
            }, 30000);

            // Request profile
            this.refreshProfile();

            // Get balances
            setTimeout(() => {
                this.send({
                    name: 'sendMessage',
                    request_id: Date.now(),
                    msg: { name: 'get-balances', version: '1.0' }
                });
            }, 1000);

            // Subscribe to position changes
            setTimeout(() => {
                this.send({
                    name: 'subscribeMessage',
                    msg: {
                        name: 'position-changed',
                        version: '2.0',
                        params: {}
                    }
                });
                logger.info(`👂 Listening for trades for user ${this.chatId}`);
            }, 2000);
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                this.handleMessage(message);
            } catch (err) {
                // Ignore parse errors
            }
        });

        this.ws.on('error', (error) => {
            logger.error(`❌ WebSocket error for user ${this.chatId}: ${error.message}`);
            this.connected = false;
        });

        this.ws.on('close', () => {
            logger.warn(`🔌 WebSocket closed for user ${this.chatId}`);
            this.connected = false;
            if (this.pingInterval) clearInterval(this.pingInterval);
            setTimeout(() => {
                logger.info(`🔄 Reconnecting user ${this.chatId}...`);
                this.connect();
            }, 5000);
        });
    }

    handleMessage(message) {
        switch (message.name) {
            case 'profile':
                this.handleProfile(message);
                break;
            case 'balances':
                this.handleBalances(message);
                break;
            case 'position':
            case 'position-changed':
                this.handlePositionUpdate(message.msg);
                break;
            case 'balance-changed':
                this.refreshProfile();
                break;
        }
    }

    handleProfile(message) {
        const profile = message.msg;
        const real = profile.balances?.find(b => b.type === 1);
        const practice = profile.balances?.find(b => b.type === 4);

        if (real) {
            this.realBalance = real.amount;
            this.realCurrency = real.currency;
            this.realBalanceId = real.id;
        }

        if (practice) {
            this.practiceBalance = practice.amount;
            this.practiceCurrency = practice.currency;
            this.practiceBalanceId = practice.id;
        }

        // Set active balance based on accountType
        if (this.accountType === 'REAL' && real) {
            this.balance = real.amount;
            this.currency = real.currency;
            this.balanceId = real.id;
        } else if (practice) {
            this.balance = practice.amount;
            this.currency = practice.currency;
            this.balanceId = practice.id;
        }

        logger.info(`💰 User ${this.chatId} - REAL Balance: ${this.realCurrency} ${this.realBalance}`);
        logger.info(`💰 User ${this.chatId} - PRACTICE Balance: ${this.practiceCurrency} ${this.practiceBalance}`);
        logger.info(`🎯 Active for trading: ${this.accountType} (${this.currency}) - ID: ${this.balanceId}`);

        if (this.onBalanceChanged) {
            this.onBalanceChanged({
                amount: this.balance,
                currency: this.currency,
                type: this.accountType
            });
        }
    }

    handleBalances(message) {
        const balances = message.msg;
        const realBal = balances.find(b => b.type === 1);
        const practiceBal = balances.find(b => b.type === 4);

        if (realBal) {
            this.realBalance = realBal.amount;
            this.realCurrency = realBal.currency;
            this.realBalanceId = realBal.id;
        }

        if (practiceBal) {
            this.practiceBalance = practiceBal.amount;
            this.practiceCurrency = practiceBal.currency;
            this.practiceBalanceId = practiceBal.id;
        }

        if (this.accountType === 'REAL' && realBal) {
            this.balance = realBal.amount;
            this.currency = realBal.currency;
            this.balanceId = realBal.id;
        } else if (practiceBal) {
            this.balance = practiceBal.amount;
            this.currency = practiceBal.currency;
            this.balanceId = practiceBal.id;
        }
    }

    handlePositionUpdate(position) {
        const activeId = position.active_id || position.instrument_id;
        const asset = this.getAssetName(activeId);

        let direction = 'Unknown';
        let displayDirection = 'UNKNOWN';
        let directionEmoji = '⚪';

        if (position.raw_event?.direction) {
            direction = position.raw_event.direction;
        } else if (position.direction) {
            direction = position.direction;
        }

        if (direction === 'call' || direction === 'buy') {
            displayDirection = 'CALL';
            directionEmoji = '🟢';
        } else if (direction === 'put' || direction === 'sell') {
            displayDirection = 'PUT';
            directionEmoji = '🔴';
        }

        if (position.status === 'open') {
            const tradeId = position.id || position.external_id;
            this.knownTradeIds = this.knownTradeIds || new Set();
            this.openDurations = this.openDurations || new Map();
            
            if (!this.knownTradeIds.has(tradeId)) {
                this.knownTradeIds.add(tradeId);

                const amount = position.invest || position.raw_event?.amount || 0;
                const duration = position.duration || this.openDurations.get(tradeId) || '?';
                
                const tradeData = {
                    asset,
                    direction: displayDirection,
                    amount,
                    duration,
                    tradeId,
                    openTime: position.open_time || position.raw_event?.open_time_millisecond
                };
                logger.info(`\n${directionEmoji} User ${this.chatId} TRADE OPENED: ${asset} ${this.currency}${amount}`);
                if (this.onTradeOpened) this.onTradeOpened(tradeData);
            }
        }

        if (position.status === 'closed') {
            const investment = position.invest || position.raw_event?.amount || 0;
            let profit = 0;
            const isWin = position.raw_event?.result === 'win' || position.close_reason === 'win';

            if (isWin) {
                const totalPayout = position.close_profit || position.raw_event?.profit_amount || 0;
                profit = totalPayout > investment ? totalPayout - investment : totalPayout;
            }

            const tradeResult = {
                asset,
                direction: displayDirection,
                investment,
                profit,
                isWin,
                tradeId: position.id || position.external_id
            };
            
            if (this.openDurations) this.openDurations.delete(tradeResult.tradeId);
            if (this.knownTradeIds) this.knownTradeIds.delete(tradeResult.tradeId);
            
            logger.info(`\n${isWin ? '✅' : '❌'} User ${this.chatId} TRADE CLOSED: ${asset} Profit: ${this.currency}${profit.toFixed(2)}`);
            if (this.onTradeClosed) this.onTradeClosed(tradeResult);

            this.refreshProfile();
        }
    }

    refreshProfile() {
        this.send({ name: 'sendMessage', request_id: Date.now(), msg: { name: 'get-profile', version: '1.0' } });
    }

    getAssetName(activeId) {
        return this.assetMap[activeId] || `Unknown-ID:${activeId}`;
    }

    async placeTrade(params) {
        return new Promise((resolve) => {
            const { asset, direction, amount, duration } = params;
            const requestId = Date.now();

            let activeId = 1861; // default to EURUSD
            for (const [id, name] of Object.entries(this.assetMap)) {
                if (name === asset) {
                    activeId = parseInt(id);
                    break;
                }
            }

            if (!this.balanceId) {
                logger.error('❌ No balance ID yet');
                return resolve({ success: false, error: 'Balance not ready' });
            }

            const now = Math.floor(Date.now() / 1000);
            const expiration = now + (duration * 60);
            const durationSeconds = duration * 60;

            const tradeMessage = {
                name: "binary-options.open-option",
                version: "1.0",
                body: {
                    active_id: activeId,
                    option_type_id: 12,
                    option_type: "blitz",
                    direction: direction.toLowerCase(),
                    expired: expiration,
                    price: amount,
                    user_balance_id: this.balanceId,
                    expiration_size: durationSeconds
                }
            };

            this.send({ name: 'sendMessage', request_id: requestId, msg: tradeMessage });

            const messageListener = (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.name === 'option-opened' && msg.msg?.option_id) {
                        this.ws?.removeListener('message', messageListener);
                        this.openDurations = this.openDurations || new Map();
                        this.openDurations.set(msg.msg.option_id, duration);
                        resolve({ success: true, tradeId: msg.msg.option_id });
                    }
                    if (msg.name === 'option' && msg.msg?.message) {
                        this.ws?.removeListener('message', messageListener);
                        resolve({ success: false, error: msg.msg.message });
                    }
                } catch (e) { }
            };

            this.ws?.on('message', messageListener);
            setTimeout(() => {
                this.ws?.removeListener('message', messageListener);
                resolve({ success: false, error: 'Timeout' });
            }, 10000);
        });
    }

    send(data) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.connected = false;
        }
        if (this.pingInterval) clearInterval(this.pingInterval);
    }
}

module.exports = IQOptionClient;