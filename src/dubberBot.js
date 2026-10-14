/**
 * Khmer Dubber bot: a small, separate bot whose only job is to open the Dubber
 * Mini App. Long polling, so it needs no public URL and cannot fight the other
 * bot's webhook. Run: `node src/dubberBot.js`
 *
 * Env: DUBBER_BOT_TOKEN, DUBBING_STUDIO_URL (https), optional DUBBER_SUPPORT_URL.
 */

const TOKEN = (process.env.DUBBER_BOT_TOKEN || "").trim();
const STUDIO_URL = (process.env.DUBBING_STUDIO_URL || "").trim();
const SUPPORT_URL = (process.env.DUBBER_SUPPORT_URL || "").trim();
const API = (process.env.DUBBER_BOT_API || "https://api.telegram.org").replace(/\/$/, "");

if (!TOKEN) throw new Error("DUBBER_BOT_TOKEN is not set");
if (!/^https:\/\//i.test(STUDIO_URL)) throw new Error("DUBBING_STUDIO_URL must be an https:// URL (Telegram only opens https Mini Apps)");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TEXT = {
  welcome: (name) =>
    `សួស្តី <b>${esc(name || "មិត្ត")}</b> 👋\n\n` +
    `🎬 <b>Khmer Dubber</b>\n` +
    `បញ្ចូលសំឡេងខ្មែរលើវីដេអូ ដោយក្លូនសំឡេងតួនីមួយៗ\n\n` +
    `<b>៣ ជំហានសាមញ្ញ</b>\n` +
    `១️⃣ ជ្រើសវីដេអូ\n` +
    `២️⃣ ពិនិត្យតួ និងសំឡេង\n` +
    `៣️⃣ ចុច «បង្កើតវីដេអូ»\n\n` +
    `ចុចប៊ូតុងខាងក្រោមដើម្បីចាប់ផ្ដើម 👇`,
  help:
    `📖 <b>របៀបប្រើ</b>\n\n` +
    `<b>១. វីដេអូ</b> — ជ្រើសវីដេអូ ឬបិទភ្ជាប់ Link។ AI ស្កេនឃ្លា បកប្រែ និងចែកតួ។\n\n` +
    `<b>២. តួ និងសំឡេង</b> — តួនីមួយៗមានសំឡេងតែមួយដូចគ្នាគ្រប់ឃ្លា។ ជ្រើស Auto ឬសំឡេងពីធនាគារ ឬក្លូនពីវីដេអូ។ AI ចែកតួខុស? ប្ដូរឃ្លា ឬបញ្ចូលតួ។\n\n` +
    `<b>៣. បង្កើតវីដេអូ</b> — ចុចម្ដង រង់ចាំ ហើយទាញយកក្នុងផ្ទាំង «វីដេអូ»។ អាចបិទ App បាន។\n\n` +
    `💡 ការក្លូនសំឡេងជាមុខងារ VIP។ គណនីឥតគិតថ្លៃប្រើសំឡេងខ្មែរ AI ធម្មតា។`,
  fallback: "ចុចប៊ូតុងខាងក្រោមដើម្បីបើក Khmer Dubber 👇",
};

const openButton = { text: "🎬 បើក Khmer Dubber", web_app: { url: STUDIO_URL } };
const mainKeyboard = () => ({
  inline_keyboard: [
    [openButton],
    [{ text: "📖 របៀបប្រើ", callback_data: "help" }, ...(SUPPORT_URL ? [{ text: "💬 ជំនួយ", url: SUPPORT_URL }] : [])],
  ],
});
const helpKeyboard = () => ({ inline_keyboard: [[openButton], [{ text: "⬅️ ត្រឡប់", callback_data: "home" }]] });

async function call(method, body = {}) {
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method}: ${json.description || res.status}`);
  return json.result;
}

async function setup() {
  const me = await call("getMe");
  console.log(`[dubber-bot] @${me.username} ready`);
  // Long polling and a webhook cannot coexist
  await call("deleteWebhook", { drop_pending_updates: false });
  const steps = [
    ["setMyCommands", { commands: [{ command: "start", description: "បើក Khmer Dubber" }, { command: "help", description: "របៀបប្រើ" }] }],
    ["setChatMenuButton", { menu_button: { type: "web_app", text: "🎬 Dubber", web_app: { url: STUDIO_URL } } }],
    ["setMyName", { name: "Khmer Dubber" }],
    ["setMyShortDescription", { short_description: "🎬 បញ្ចូលសំឡេងខ្មែរលើវីដេអូ ដោយក្លូនសំឡេងតួ (AI)" }],
    [
      "setMyDescription",
      {
        description:
          "Khmer Dubber — បញ្ចូលសំឡេងខ្មែរលើវីដេអូចិន/Anime។\n\n" +
          "✅ AI ស្កេន បកប្រែ និងចែកតួ\n✅ តួនីមួយៗមានសំឡេងតែមួយ (ក្លូន VoxCPM2)\n✅ បង្កើតវីដេអូដោយប៊ូតុងតែមួយ\n\nចុច START ដើម្បីចាប់ផ្ដើម។",
      },
    ],
  ];
  for (const [method, body] of steps) {
    // A cosmetic setting failing (rate limit, name cooldown) must not stop the bot
    await call(method, body).catch((e) => console.warn(`[dubber-bot] ${e.message}`));
  }
}

const send = (chat_id, text, reply_markup) =>
  call("sendMessage", { chat_id, text, parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } });

async function onMessage(msg) {
  if (msg.chat?.type !== "private") return;
  const cmd = (msg.text || "").trim().split(/\s|@/)[0].toLowerCase();
  if (cmd === "/help") return send(msg.chat.id, TEXT.help, helpKeyboard());
  if (cmd === "/start") return send(msg.chat.id, TEXT.welcome(msg.from?.first_name), mainKeyboard());
  return send(msg.chat.id, TEXT.fallback, mainKeyboard());
}

async function onCallback(q) {
  const chat_id = q.message?.chat?.id;
  const message_id = q.message?.message_id;
  await call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
  if (!chat_id || !message_id) return;
  const view = q.data === "help" ? [TEXT.help, helpKeyboard()] : [TEXT.welcome(q.from?.first_name), mainKeyboard()];
  await call("editMessageText", { chat_id, message_id, text: view[0], parse_mode: "HTML", reply_markup: view[1] }).catch((e) => {
    // "message is not modified" when the same button is tapped twice
    if (!/not modified/i.test(e.message)) throw e;
  });
}

async function poll() {
  let offset = 0;
  let backoff = 1000;
  for (;;) {
    try {
      const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
      backoff = 1000;
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.message) await onMessage(u.message);
          else if (u.callback_query) await onCallback(u.callback_query);
        } catch (e) {
          console.warn(`[dubber-bot] update ${u.update_id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`[dubber-bot] ${e.message} — retry in ${backoff / 1000}s`);
      if (/Unauthorized|terminated by other getUpdates/i.test(e.message)) {
        console.error("[dubber-bot] token revoked or another instance is polling the same bot");
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

await setup();
await poll();
