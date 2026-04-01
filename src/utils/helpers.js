function getCurrencySymbol(currency) {
    const symbols = { NGN: '₦', USD: '$', EUR: '€', GBP: '£', BRL: 'R$' };
    return symbols[(currency || '').toUpperCase()] || (currency + ' ');
}

function formatNumber(num) {
    return num.toLocaleString();
}

function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

module.exports = { getCurrencySymbol, formatNumber, escapeMarkdown };