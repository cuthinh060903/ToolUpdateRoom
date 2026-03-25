const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '8601640161:AAGCaCePgeRtfo1jqd9JCmrAoIuiY2LKPPk';
const TELEGRAM_CHAT_ID = '-5224515618';

async function sendTelegramMessage(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('✅ Đã gửi tin nhắn đến Telegram');
    } catch (error) {
        console.error('❌ Lỗi khi gửi tin nhắn Telegram:', error.message);
    }
}

module.exports = {
    sendTelegramMessage
};
