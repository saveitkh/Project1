/**
 * Khmer Dubber bot: opens the Dubber Mini App and doubles as an emoji design studio
 * (photo/GIF/video -> custom emoji + every file format, Coding & Terminal icon sets,
 * terminal text badges). Long polling, so it needs no public URL and cannot fight the
 * other bot's webhook. Run: `node src/dubberBot.js`
 *
 * Env: DUBBER_BOT_TOKEN, DUBBING_STUDIO_URL (https), optional DUBBER_SUPPORT_URL.
 */
import * as studio from "./emojiStudio.js";

const TOKEN = (process.env.DUBBER_BOT_TOKEN || "").trim();
const STUDIO_URL = (process.env.DUBBING_STUDIO_URL || "").trim();
const SUPPORT_URL = (process.env.DUBBER_SUPPORT_URL || "").trim();
const API = (process.env.DUBBER_BOT_API || "https://api.telegram.org").replace(/\/$/, "");

if (!TOKEN) throw new Error("DUBBER_BOT_TOKEN is not set");
if (!/^https:\/\//i.test(STUDIO_URL)) throw new Error("DUBBING_STUDIO_URL must be an https:// URL (Telegram only opens https Mini Apps)");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ── Bot API client ── */
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
const callSoft = (method, body) => call(method, body).catch(() => null);
const form = async (method, body) =>
  (await fetch(`${API}/bot${TOKEN}/${method}`, { method: "POST", body, signal: AbortSignal.timeout(120_000) })).json().catch(() => ({}));
const api = { call: callSoft, form, fileUrl: (p) => `${API}/file/bot${TOKEN}/${p}`, username: "" };

/* ── Texts ── */
const TEXT = {
  welcome: (name) =>
    `សួស្តី <b>${esc(name || "មិត្ត")}</b> 👋\n\n` +
    `🎬 <b>Khmer Dubber</b> — បញ្ចូលសំឡេងខ្មែរលើវីដេអូ ដោយក្លូនសំឡេងតួនីមួយៗ\n` +
    `🎨 <b>Emoji Studio</b> — បង្កើត Emoji ដោយខ្លួនឯង\n\n` +
    `ជ្រើសខាងក្រោម 👇`,
  help:
    `📖 <b>របៀបប្រើ Dubber</b>\n\n` +
    `<b>១. វីដេអូ</b> — ជ្រើសវីដេអូ ឬបិទភ្ជាប់ Link។ AI ស្កេនឃ្លា បកប្រែ និងចែកតួ។\n` +
    `<b>២. តួ និងសំឡេង</b> — តួនីមួយៗមានសំឡេងតែមួយគ្រប់ឃ្លា។ ជ្រើស Auto សំឡេងពីធនាគារ ឬក្លូនពីវីដេអូ។\n` +
    `<b>៣. បង្កើតវីដេអូ</b> — ចុចម្ដង រង់ចាំ ហើយទាញយកក្នុងផ្ទាំង «វីដេអូ»។ អាចបិទ App បាន។\n\n` +
    `💡 ការក្លូនសំឡេងជាមុខងារ VIP។ គណនីឥតគិតថ្លៃប្រើសំឡេងខ្មែរ AI ធម្មតា។`,
  emoji:
    `🎨 <b>Emoji Maker</b>\n\n` +
    `ផ្ញើមកខ្ញុំ <b>រូបភាព · GIF · វីដេអូ · Sticker</b> ណាមួយ ហើយខ្ញុំនឹង៖\n` +
    `• ដាក់ចូល <b>កញ្ចប់ Emoji ផ្ទាល់ខ្លួន</b> របស់អ្នក (t.me/addemoji/…)\n` +
    `• ផ្ញើឯកសារ <b>គ្រប់ទម្រង់</b> មកវិញ៖ PNG 512 (ថ្លា) · WebP · PNG 100` +
    ` · សម្រាប់វីដេអូ/GIF៖ WebM 100 + GIF\n\n` +
    `✂️ រូបត្រូវបានកាត់យកការ៉េកណ្ដាល។ វីដេអូ/GIF ប្រើ ៣ វិនាទីដំបូង។\n` +
    `ℹ️ ប្រើ Emoji ក្នុងសារ ត្រូវការ Telegram Premium។ ឯកសារ PNG/GIF ប្រើបានគ្រប់ទីកន្លែង។`,
  coding:
    `💻 <b>Coding &amp; Terminal Emoji</b>\n\n` +
    `ឈុត <b>${studio.ICONS.length} icon</b> (<code>&gt;_</code> <code>{ }</code> <code>&lt;/&gt;</code> bug · git · ✓ ✗ · API · SQL · 404 …)\n` +
    `ជា <b>កញ្ចប់ Emoji</b> ក្នុងគណនីអ្នក + <b>ZIP</b> (PNG 512/100) សម្រាប់ប្រើក្នុង README, Discord, Slack, ឯកសារ project ផ្សេងៗ។\n\n` +
    `ជ្រើសពណ៌ធៀម 👇`,
  badgeHelp:
    `🏷 <b>Terminal Badge</b>\n\nផ្ញើពាក្យបញ្ជា៖\n<code>/badge npm run dev</code>\n<code>/badge dracula git push origin main</code>\n\n` +
    `ធៀម៖ <code>terminal</code> · <code>neon</code> · <code>dracula</code> · <code>light</code>`,
  busy: "⏳ កំពុងធ្វើមួយរួចហើយ សូមរង់ចាំបន្តិច។",
  working: "⏳ កំពុងបង្កើត…",
  fallback: "ចុចប៊ូតុងខាងក្រោម ឬផ្ញើរូបភាព/GIF/វីដេអូ ដើម្បីបង្កើត Emoji 👇",
  failed: (why) => `❌ មិនបានទេ៖ ${esc(why)}`,
  emojiDone: (link, count) =>
    `✅ រួចរាល់! Emoji ចូលក្នុងកញ្ចប់របស់អ្នក (${count})៖\n${link}\n\nបើកតំណដើម្បីបន្ថែមកញ្ចប់ ហើយផ្ញើរូបទៀតដើម្បីបន្ថែមបន្ត។`,
  codingDone: (link, count, created) =>
    `✅ ${created ? "បានបង្កើត" : "កញ្ចប់នេះមានរួចហើយ"} — ${count} icon៖\n${link}\n\n📦 ZIP សម្រាប់ project ផ្សេងៗត្រូវបានផ្ញើខាងលើ។`,
};

/* ── Keyboards ── */
const openButton = { text: "🎬 បើក Khmer Dubber", web_app: { url: STUDIO_URL } };
const homeKeyboard = () => ({
  inline_keyboard: [
    [openButton],
    [{ text: "🎨 Emoji Maker", callback_data: "emoji" }, { text: "💻 Coding Emoji", callback_data: "coding" }],
    [{ text: "🏷 Terminal Badge", callback_data: "badge" }, { text: "📖 របៀបប្រើ", callback_data: "help" }, ...(SUPPORT_URL ? [{ text: "💬 ជំនួយ", url: SUPPORT_URL }] : [])],
  ],
});
const backRow = [{ text: "⬅️ ត្រឡប់", callback_data: "home" }];
const themeKeyboard = (prefix) => ({
  inline_keyboard: [
    ...Object.entries(studio.THEMES).reduce((rows, [id, t], i) => {
      if (i % 2 === 0) rows.push([]);
      rows[rows.length - 1].push({ text: t.label, callback_data: `${prefix}:${id}` });
      return rows;
    }, []),
    backRow,
  ],
});

const VIEWS = {
  home: (from) => [TEXT.welcome(from?.first_name), homeKeyboard()],
  help: () => [TEXT.help, { inline_keyboard: [[openButton], backRow] }],
  emoji: () => [TEXT.emoji, { inline_keyboard: [backRow] }],
  coding: () => [TEXT.coding, themeKeyboard("code")],
  badge: () => [TEXT.badgeHelp, { inline_keyboard: [backRow] }],
};

/* ── Setup ── */
async function setup() {
  const me = await call("getMe");
  api.username = String(me.username || "").toLowerCase();
  console.log(`[dubber-bot] @${me.username} ready`);
  await call("deleteWebhook", { drop_pending_updates: false }); // long polling and a webhook cannot coexist
  const steps = [
    ["setMyCommands", { commands: [
      { command: "start", description: "បើក Khmer Dubber" },
      { command: "emoji", description: "Emoji Maker — បង្កើត Emoji ពីរូប/GIF/វីដេអូ" },
      { command: "coding", description: "Coding & Terminal Emoji" },
      { command: "badge", description: "Terminal Badge ពីអក្សរ" },
      { command: "help", description: "របៀបប្រើ" },
    ] }],
    ["setChatMenuButton", { menu_button: { type: "web_app", text: "🎬 Dubber", web_app: { url: STUDIO_URL } } }],
    ["setMyName", { name: "Khmer Dubber" }],
    ["setMyShortDescription", { short_description: "🎬 បញ្ចូលសំឡេងខ្មែរ (AI) · 🎨 Emoji Maker · 💻 Coding Emoji" }],
    ["setMyDescription", { description:
      "Khmer Dubber — បញ្ចូលសំឡេងខ្មែរលើវីដេអូចិន/Anime។\n\n" +
      "✅ AI ស្កេន បកប្រែ និងចែកតួ\n✅ តួនីមួយៗមានសំឡេងតែមួយ (ក្លូន VoxCPM2)\n" +
      "🎨 Emoji Maker: រូប/GIF/វីដេអូ → Emoji គ្រប់ទម្រង់\n💻 Coding & Terminal Emoji សម្រាប់ project\n\nចុច START ដើម្បីចាប់ផ្ដើម។" }],
  ];
  for (const [method, body] of steps) {
    // A cosmetic setting failing (rate limit, name cooldown) must not stop the bot
    await call(method, body).catch((e) => console.warn(`[dubber-bot] ${e.message}`));
  }
}

/* ── Handlers ── */
const send = (chat_id, text, reply_markup) =>
  call("sendMessage", { chat_id, text, parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } });

const working = new Set();
/** One emoji job per chat at a time (they run ffmpeg and several Telegram calls). */
async function exclusive(chatId, fn) {
  if (working.has(chatId)) return send(chatId, TEXT.busy);
  working.add(chatId);
  try {
    await fn();
  } catch (e) {
    console.warn(`[dubber-bot] job failed: ${e.message}`);
    await send(chatId, TEXT.failed(e.message)).catch(() => {});
  } finally {
    working.delete(chatId);
  }
}

/** Shows "working…" while `job` runs and always removes it afterwards, success or failure. */
async function withProgress(chatId, job) {
  const note = await send(chatId, TEXT.working).catch(() => null);
  try {
    return await job();
  } finally {
    if (note) await call("deleteMessage", { chat_id: chatId, message_id: note.message_id }).catch(() => {});
  }
}

async function runMedia(msg) {
  const pack = await withProgress(msg.chat.id, () => studio.mediaToEmoji(api, msg));
  await send(msg.chat.id, TEXT.emojiDone(pack.link, pack.count));
}

async function runCoding(user, chatId, theme) {
  const r = await withProgress(chatId, () => studio.codingPack(api, user, chatId, theme));
  await send(chatId, TEXT.codingDone(r.link, r.count, r.created));
}

async function runBadge(msg, label, theme) {
  const pack = await withProgress(msg.chat.id, () => studio.badge(api, msg.from, msg.chat.id, label, theme));
  await send(msg.chat.id, TEXT.emojiDone(pack.link, pack.count));
}

const show = (chat_id, view, from) => {
  const [text, markup] = VIEWS[view](from);
  return send(chat_id, text, markup);
};

async function onMessage(msg) {
  if (msg.chat?.type !== "private") return;
  const chatId = msg.chat.id;
  const raw = (msg.text || msg.caption || "").trim();
  const [head, ...rest] = raw.split(/\s+/);
  const cmd = head.toLowerCase().replace(/@.*$/, "");
  const args = rest.join(" ");

  if (cmd === "/start") return show(chatId, "home", msg.from);
  if (cmd === "/help") return show(chatId, "help");
  if (cmd === "/coding") {
    const theme = args.toLowerCase();
    return studio.THEMES[theme] ? exclusive(chatId, () => runCoding(msg.from, chatId, theme)) : show(chatId, "coding");
  }
  if (cmd === "/badge") {
    const [first, ...others] = args.split(/\s+/);
    const themed = studio.THEMES[first?.toLowerCase()];
    const label = (themed ? others.join(" ") : args).trim();
    if (!label) return show(chatId, "badge");
    return exclusive(chatId, () => runBadge(msg, label, themed ? first.toLowerCase() : "terminal"));
  }
  if (studio.mediaOf(msg)) return exclusive(chatId, () => runMedia(msg));
  if (cmd === "/emoji") return show(chatId, "emoji");
  return send(chatId, TEXT.fallback, homeKeyboard());
}

async function onCallback(q) {
  const chatId = q.message?.chat?.id;
  const message_id = q.message?.message_id;
  await call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
  if (!chatId || !message_id) return;
  if (q.data?.startsWith("code:")) {
    const theme = q.data.slice(5);
    if (studio.THEMES[theme]) await exclusive(chatId, () => runCoding(q.from, chatId, theme));
    return;
  }
  const [text, markup] = (VIEWS[q.data] || VIEWS.home)(q.from);
  await call("editMessageText", { chat_id: chatId, message_id, text, parse_mode: "HTML", reply_markup: markup }).catch((e) => {
    if (!/not modified/i.test(e.message)) throw e; // the same button tapped twice
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
        // Not awaited per update: one slow emoji job must not freeze everyone else
        Promise.resolve()
          .then(() => (u.message ? onMessage(u.message) : u.callback_query ? onCallback(u.callback_query) : null))
          .catch((e) => console.warn(`[dubber-bot] update ${u.update_id}: ${e.message}`));
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
