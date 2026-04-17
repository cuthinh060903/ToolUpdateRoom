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

async function sendTelegramMessage(message, options = {}) {
  const configuredTarget = getTelegramTarget(options.targetKey);
  const botToken =
    normalizeConfigValue(options.botToken) || configuredTarget.botToken;
  const chatId = normalizeConfigValue(options.chatId) || configuredTarget.chatId;
  const targetLabel =
    normalizeConfigValue(options.label) || configuredTarget.label || "Telegram";
  const throwOnError = options.throwOnError === true;

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

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    });
    console.log(`[telegram] Da gui tin nhan den ${targetLabel}`);
    return {
      sent: true,
      chatId,
      label: targetLabel,
    };
  } catch (error) {
    console.error(
      `[telegram] Loi khi gui tin nhan den ${targetLabel}:`,
      error.message,
    );
    if (throwOnError) {
      throw error;
    }

    return {
      sent: false,
      reason: error.message,
    };
  }
}

module.exports = {
  TELEGRAM_TARGETS,
  getMainTelegramTarget,
  getTelegramTarget,
  getRoomAuditTelegramTarget,
  sendTelegramMessage,
};
