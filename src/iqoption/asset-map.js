const ASSET_MAP = {
    'EURUSD': 1861,
    'EURUSD-OTC': 76,
    'GBPUSD': 2,
    'USDJPY': 3,
    'AUDUSD': 4,
    'USDCAD': 5,
    'USDCHF': 6,
    'NZDUSD': 7,
    'EURGBP': 8,
    'EURJPY': 9,
    'GBPJPY': 10,
    'XAUUSD': 17,
    'BTCUSD': 67,
    'ETHUSD': 68,
    'BTCUSD-OTC': 91,
    'ETHUSD-OTC': 92
};

function getAssetId(symbol) {
    return ASSET_MAP[symbol] || ASSET_MAP['EURUSD-OTC'] || 76;
}

module.exports = { ASSET_MAP, getAssetId };
