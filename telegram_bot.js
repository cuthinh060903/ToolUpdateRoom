const axios = require("axios");

const TELEGRAM_BOT_TOKEN = "8755377200:AAHQuvfRXRgxpda_t8MaCp0Z3c_L7CSTBlQ";
const TELEGRAM_CHAT_ID = "-1003871861944";

async function sendTelegramMessage(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    });
    console.log("✅ Đã gửi tin nhắn đến Telegram");
  } catch (error) {
    console.error("❌ Lỗi khi gửi tin nhắn Telegram:", error.message);
  }
}

module.exports = {
  sendTelegramMessage,
};
