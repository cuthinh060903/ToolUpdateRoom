const {
  getRoomAuditTelegramTarget,
  sendTelegramMessage,
} = require("../../telegram_bot");

function normalizeMessageArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => item?.toString().trim()).filter(Boolean);
  }

  if (value === undefined || value === null) {
    return [];
  }

  const message = value.toString().trim();
  return message ? [message] : [];
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRoomAuditTarget(options = {}) {
  const configuredTarget = getRoomAuditTelegramTarget();
  return {
    ...configuredTarget,
    botToken: options.botToken || configuredTarget.botToken,
    chatId: options.chatId || configuredTarget.chatId,
  };
}

async function sendRoomAuditMessage(message, options = {}) {
  const target = resolveRoomAuditTarget(options);
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

  return sendTelegramMessage(message, {
    targetKey: "roomAudit",
    botToken: target.botToken,
    chatId: target.chatId,
    parseMode: false,
    maxAttempts: Number.isFinite(options.maxAttempts) ? options.maxAttempts : 5,
    retryBaseMs: Number.isFinite(options.retryBaseMs) ? options.retryBaseMs : 2000,
  });
}

async function sendAuditTelegramStart(options = {}) {
  if (!options?.enabled) {
    return {
      sent: false,
      reason: "SEND_TELEGRAM_DISABLED",
    };
  }

  const scopeText =
    Array.isArray(options.onlyIds) && options.onlyIds.length > 0
      ? `Phạm vi: CDT ${options.onlyIds.join(", ")}.`
      : "Phạm vi: toàn bộ dữ liệu.";
  const startMessage = `Bắt đầu cập nhật room audit...\n${scopeText}`;
  return sendRoomAuditMessage(startMessage, options);
}

async function sendAuditTelegramProgress(report, options = {}) {
  if (!options?.enabled) {
    return {
      sent: false,
      reason: "SEND_TELEGRAM_DISABLED",
    };
  }

  const message =
    (options.message || report?.telegram_progress_message || "").toString().trim();
  if (!message) {
    return {
      sent: false,
      reason: "PROGRESS_MESSAGE_EMPTY",
    };
  }

  return sendRoomAuditMessage(message, options);
}

async function sendAuditTelegramFailure(error, options = {}) {
  if (!options?.enabled) {
    return {
      sent: false,
      reason: "SEND_TELEGRAM_DISABLED",
    };
  }

  const errorMessage = error?.message || String(error);
  return sendRoomAuditMessage(
    `Room audit gặp lỗi.\nChi tiết: ${errorMessage}`,
    options,
  );
}

async function sendAuditTelegram(report, options = {}) {
  if (!options?.enabled) {
    return {
      sent: false,
      reason: "SEND_TELEGRAM_DISABLED",
    };
  }

  const messages = normalizeMessageArray(
    options.messages || options.message || report?.telegram_messages || report?.telegram_message,
  );
  if (messages.length === 0) {
    return {
      sent: false,
      reason: "MESSAGE_EMPTY",
    };
  }

  const delayMs = Number.isFinite(options?.delayMs) ? options.delayMs : 1200;
  let sentCount = 0;

  for (const [index, message] of messages.entries()) {
    const sendResult = await sendRoomAuditMessage(message, options);
    if (!sendResult?.sent) {
      return {
        sent: false,
        reason: sendResult?.reason || "ROOM_AUDIT_TELEGRAM_SEND_FAILED",
        messageIndex: index,
        sentCount,
      };
    }

    sentCount += 1;
    if (index < messages.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  if (options.skipFinishMessage) {
    return {
      sent: true,
      messageCount: messages.length,
      sentCount,
    };
  }

  const finishMessage =
    (options.finishMessage || "Hoàn thành").toString().trim() || "Hoàn thành";
  const finishResult = await sendRoomAuditMessage(finishMessage, options);
  if (!finishResult?.sent) {
    return {
      sent: false,
      reason: finishResult?.reason || "ROOM_AUDIT_TELEGRAM_FINISH_FAILED",
      sentCount,
    };
  }

  return {
    sent: true,
    messageCount: messages.length + 1,
    sentCount: messages.length + 1,
  };
}

module.exports = {
  sendAuditTelegram,
  sendAuditTelegramFailure,
  sendAuditTelegramProgress,
  sendAuditTelegramStart,
  sendRoomAuditMessage,
};
