require("dotenv").config();

const ROOM_AUDIT_TELEGRAM_BOT_TOKEN = process.env.ROOM_AUDIT_TELEGRAM_BOT_TOKEN;
const ROOM_AUDIT_TELEGRAM_CHAT_ID = process.env.ROOM_AUDIT_TELEGRAM_CHAT_ID;

async function sendTelegramMessage(text) {
  if (!ROOM_AUDIT_TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing ROOM_AUDIT_TELEGRAM_BOT_TOKEN in .env");
  }

  if (!ROOM_AUDIT_TELEGRAM_CHAT_ID) {
    throw new Error("Missing ROOM_AUDIT_TELEGRAM_CHAT_ID in .env");
  }

  const url = `https://api.telegram.org/bot${ROOM_AUDIT_TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: ROOM_AUDIT_TELEGRAM_CHAT_ID,
      text,
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram send failed: ${JSON.stringify(data)}`);
  }

  return data;
}

if (require.main === module) {
  (async () => {
    try {
      const text = process.argv[2];
      if (!text) {
        throw new Error("Missing telegram text argument");
      }

      const result = await sendTelegramMessage(text);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  })();
}

module.exports = {
  sendTelegramMessage,
};
