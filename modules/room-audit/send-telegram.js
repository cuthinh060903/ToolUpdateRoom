const { getRoomAuditTelegramTarget, sendTelegramMessage } = require("../../telegram_bot");

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

  const configuredTarget = getRoomAuditTelegramTarget();
  const target = {
    ...configuredTarget,
    botToken: options.botToken || configuredTarget.botToken,
    chatId: options.chatId || configuredTarget.chatId,
  };

  if (!target.botToken || !target.chatId) {
    return {
      sent: false,
      reason: "ROOM_AUDIT_TELEGRAM_NOT_CONFIGURED",
      missing: {
        botToken: !target.botToken,
        chatId: !target.chatId,
      },
    };
  }

  const sendResult = await sendTelegramMessage(message, {
    targetKey: "roomAudit",
    botToken: target.botToken,
    chatId: target.chatId,
  });

  if (!sendResult?.sent) {
    return {
      sent: false,
      reason: sendResult?.reason || "ROOM_AUDIT_TELEGRAM_SEND_FAILED",
      message,
    };
  }

  return {
    sent: true,
    message,
  };
}

module.exports = {
  sendAuditTelegram,
};
