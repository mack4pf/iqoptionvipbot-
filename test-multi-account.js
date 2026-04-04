require('dotenv').config();
const MongoDB = require('./src/database/mongodb');
const logger = require('./src/utils/logger');

async function testMultiAccount() {
    const db = new MongoDB();
    await db.connect();

    const adminId = '7683045804'; // Your ID from .env
    
    logger.info('🧪 Starting Multi-Account Test Setup');

    // 1. Add some dummy accounts to DB
    const testAccounts = [
        { email: 'test1@example.com', pass: 'pass123' },
        { email: 'test2@example.com', pass: 'pass456' },
        { email: 'test3@example.com', pass: 'pass789' }
    ];

    for (const acc of testAccounts) {
        logger.info(`📝 Adding test account: ${acc.email}`);
        await db.addAccount(adminId, acc.email, acc.pass);
        
        // Mock a connection status for testing picking up from DB
        await db.updateAccount(acc.email, { 
            connected: true, 
            ssid: 'mock-ssid-' + Math.random().toString(36).substring(7),
            tradeAmount: 1000 + Math.floor(Math.random() * 500)
        });
    }

    // 2. List accounts
    const accounts = await db.getAccounts(adminId);
    logger.info(`✅ Successfully added and retrieved ${accounts.length} accounts for admin ${adminId}`);
    
    accounts.forEach((acc, i) => {
        logger.info(`   [${i+1}] ${acc.email} | Amount: ${acc.tradeAmount} | Connected: ${acc.connected}`);
    });

    // 3. Clean up (optional)
    // for (const acc of testAccounts) {
    //     await db.deleteAccount(acc.email);
    // }

    logger.info('🚀 Setup complete. You can now run the bot and see it try to connect these accounts.');
    logger.info('💡 Note: Real connections will fail unless you provide real credentials in the script.');
    
    process.exit(0);
}

testMultiAccount().catch(err => {
    logger.error('❌ Test failed:', err);
    process.exit(1);
});
