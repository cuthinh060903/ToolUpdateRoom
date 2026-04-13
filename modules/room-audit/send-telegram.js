const { sendTelegramMessage } = require("../../telegram_bot");

async function sendAuditTelegram(report, options = {}) {
  if (!options?.enabled) {
    return {
      sent: false,
      reason: "SEND_TELEGRAM_DISABLED",
    };
  }

  const message = options.message || report?.telegram_message;
  if (!message) {
    return {
      sent: false,
      reason: "MESSAGE_EMPTY",
    };
  }

  await sendTelegramMessage(message);
  return {
    sent: true,
    message,
  };
}

module.exports = {
  sendAuditTelegram,
};
