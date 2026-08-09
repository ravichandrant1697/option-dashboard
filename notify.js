/**
 * NOTIFY — console + optional Telegram alerts.
 * Alert failures never break the trading loop.
 */
const axios = require("axios");
const { TG } = require("./config");

// Log a message and, when TG_BOT_TOKEN/TG_CHAT_ID are set, push it to
// Telegram.
async function notify(msg) {
  console.log(msg);
  if (!TG.token || !TG.chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG.token}/sendMessage`, {
      chat_id: TG.chatId,
      text: msg
    });
  } catch (e) {
    console.error("Telegram alert failed:", e.message);
  }
}

module.exports = { notify };
