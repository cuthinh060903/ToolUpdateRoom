const axios = require("axios");
require("dotenv").config({ quiet: true });

const TELEGRAM_TARGETS = Object.freeze({
  mainUpdater: {
    label: "Telegram updater",
    botTokenEnv: "TELEGRAM_BOT_TOKEN",
    chatIdEnv: "TELEGRAM_CHAT_ID",
  },
  roomAudit: {
    label: "room audit Telegram",
    botTokenEnv: "ROOM_AUDIT_TELEGRAM_BOT_TOKEN",
    chatIdEnv: "ROOM_AUDIT_TELEGRAM_CHAT_ID",
  },
});

function normalizeConfigValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  return value.toString().trim();
}

function getTelegramTarget(targetKey = "mainUpdater") {
  const config = TELEGRAM_TARGETS[targetKey] || TELEGRAM_TARGETS.mainUpdater;

  return {
    key: targetKey,
    label: config.label,
    botToken: normalizeConfigValue(process.env[config.botTokenEnv]),
    chatId: normalizeConfigValue(process.env[config.chatIdEnv]),
    botTokenEnv: config.botTokenEnv,
    chatIdEnv: config.chatIdEnv,
  };
}

function getMainTelegramTarget() {
  return getTelegramTarget("mainUpdater");
}

function getRoomAuditTelegramTarget() {
  return getTelegramTarget("roomAudit");
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramMessage(message, options = {}) {
  const configuredTarget = getTelegramTarget(options.targetKey);
  const botToken =
    normalizeConfigValue(options.botToken) || configuredTarget.botToken;
  const chatId = normalizeConfigValue(options.chatId) || configuredTarget.chatId;
  const targetLabel =
    normalizeConfigValue(options.label) || configuredTarget.label || "Telegram";
  const throwOnError = options.throwOnError === true;
  const parseMode =
    Object.prototype.hasOwnProperty.call(options, "parseMode")
      ? options.parseMode
      : "HTML";
  const maxAttempts = Number.isFinite(options.maxAttempts)
    ? Math.max(1, options.maxAttempts)
    : 1;
  const retryBaseMs = Number.isFinite(options.retryBaseMs)
    ? Math.max(0, options.retryBaseMs)
    : 1500;

  if (!botToken || !chatId) {
    const error = new Error(
      `${targetLabel.toUpperCase().replace(/\s+/g, "_")}_CONFIG_MISSING`,
    );
    console.error(
      `[telegram] Thieu cau hinh ${targetLabel}. Can kiem tra ${configuredTarget.botTokenEnv} va ${configuredTarget.chatIdEnv}.`,
    );
    if (throwOnError) {
      throw error;
    }

    return {
      sent: false,
      reason: error.message,
    };
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: message,
  };

  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await axios.post(url, payload);
      console.log(`[telegram] Da gui tin nhan den ${targetLabel}`);
      return {
        sent: true,
        chatId,
        label: targetLabel,
      };
    } catch (error) {
      lastError = error;
      const status = Number(error?.response?.status || 0) || null;
      const retryAfterSeconds = Number(
        error?.response?.data?.parameters?.retry_after,
      );
      const canRetry = status === 429 && attempt < maxAttempts;

      console.error(
        `[telegram] Loi khi gui tin nhan den ${targetLabel}:`,
        error.message,
      );

      if (canRetry) {
        const delayMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : retryBaseMs * attempt;
        console.warn(
          `[telegram] ${targetLabel} bi rate limit, doi ${delayMs}ms roi gui lai (lan ${attempt}/${maxAttempts}).`,
        );
        await sleep(delayMs);
        continue;
      }

      if (throwOnError) {
        throw error;
      }

      return {
        sent: false,
        reason: error.message,
        status,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds
          : null,
      };
    }
  }

  if (throwOnError && lastError) {
    throw lastError;
  }

  return {
    sent: false,
    reason: lastError?.message || "TELEGRAM_SEND_FAILED",
    status: Number(lastError?.response?.status || 0) || null,
  };
}

module.exports = {
  TELEGRAM_TARGETS,
  getMainTelegramTarget,
  getTelegramTarget,
  getRoomAuditTelegramTarget,
  sendTelegramMessage,
};
