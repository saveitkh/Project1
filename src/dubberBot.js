/**
 * Khmer Dubber bot: opens the Dubber Mini App and doubles as an emoji design studio
 * (photo/GIF/video -> custom emoji + every file format, Coding & Terminal icon sets,
 * terminal text badges). Long polling, so it needs no public URL and cannot fight the
 * other bot's webhook. Run: `node src/dubberBot.js`
 *
 * Design: Khmer button names, a TeleScripts logo that spins 360° on /start, and 3D icons that
 * spin 360° as Telegram custom emoji on the buttons and in the messages. The admin builds the
 * emoji pack once with /makeemoji (files in assets/brand/emoji); until then plain emoji are shown.
 *
 * Env: DUBBER_BOT_TOKEN, DUBBING_STUDIO_URL (https), optional DUBBER_SUPPORT_URL,
 * DUBBER_BUSINESS_URL, DUBBER_ADMIN_IDS (who may run /makeemoji).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as studio from "./emojiStudio.js";

const TOKEN = (process.env.DUBBER_BOT_TOKEN || "").trim();
const STUDIO_URL = (process.env.DUBBING_STUDIO_URL || "").trim();
const SUPPORT_URL = (process.env.DUBBER_SUPPORT_URL || "").trim();
const BUSINESS_URL = (process.env.DUBBER_BUSINESS_URL || "").trim();
const ADMIN_IDS = new Set((process.env.DUBBER_ADMIN_IDS || "").split(",").map((x) => x.trim()).filter(Boolean));
const DATA_DIR = process.env.DUBBER_DATA_DIR || "/srv/data";
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "brand");
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

/* ── Store: the logo animation's file_id and the custom emoji ids ── */
const STORE_FILE = path.join(DATA_DIR, "dubber-bot.json");
let store = { animationFileId: "", animationFile: "", emoji: {}, emojiPack: "" };
try {
  store = { ...store, ...JSON.parse(await fs.readFile(STORE_FILE, "utf8")) };
} catch {}
const saveStore = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STORE_FILE, JSON.stringify(store));
  } catch (e) {
    console.warn(`[dubber-bot] store not saved: ${e.message}`);
  }
};

/* ── Icons: 3D spinning custom emoji, with a plain emoji fallback ── */
// key -> [file in assets/brand/emoji (.webm 100x100, spins 360°), plain emoji]
const ICON = {
  logo: ["logo", "✈️"],
  dubber: ["dubber", "🎬"],
  business: ["business", "🧾"],
  emoji: ["emoji", "🎨"],
  coding: ["coding", "💻"],
  badge: ["badge", "🏷"],
  help: ["help", "📖"],
  back: ["back", "⬅️"],
  ok: ["ok", "✅"],
  wait: ["wait", "⏳"],
};
const LOGO_MP4 = "telescripts-360.mp4";
// Telegram refuses custom emoji when the bot's owner has no Premium (or the pack is gone):
// then everything goes out with plain emoji for a while instead of failing.
let plainUntil = 0;
const usePlain = () => Date.now() < plainUntil || !Object.keys(store.emoji).length;
const emojiId = (key) => (usePlain() ? null : store.emoji[key] || null);

/** {:key:} in a text -> <tg-emoji> (custom, spinning) or the plain emoji. */
const deco = (text) =>
  String(text).replace(/\{:([a-z]+):\}/g, (m, key) => {
    const icon = ICON[key];
    if (!icon) return m;
    const id = emojiId(key);
    return id ? `<tg-emoji emoji-id="${id}">${icon[1]}</tg-emoji>` : icon[1];
  });

/** Buttons written as { text, icon }: the icon becomes icon_custom_emoji_id, or a leading plain emoji. */
const decoMarkup = (markup) => {
  if (!markup) return markup;
  const map = (rows) =>
    rows.map((row) =>
      row.map(({ icon, ...b }) => {
        if (!icon || !ICON[icon]) return b;
        const id = emojiId(icon);
        return id ? { ...b, icon_custom_emoji_id: id } : { ...b, text: `${ICON[icon][1]} ${b.text}` };
      })
    );
  if (markup.inline_keyboard) return { ...markup, inline_keyboard: map(markup.inline_keyboard) };
  if (markup.keyboard) return { ...markup, keyboard: map(markup.keyboard) };
  return markup;
};
const emojiRefused = (msg) => /custom.?emoji|icon_custom|ENTITY|DOCUMENT_INVALID|STICKER|premium/i.test(String(msg));

/* ── Texts (Khmer). {:key:} = a spinning 3D icon ── */
const TEXT = {
  welcome: (name) =>
    `{:logo:} <b>TeleScripts</b> · សួស្តី <b>${esc(name || "មិត្ត")}</b>\n\n` +
    `{:dubber:} <b>បញ្ចូលសំឡេងខ្មែរ</b> — AI ស្កេន បកប្រែ ចែកតួ ហើយក្លូនសំឡេងតួនីមួយៗ\n` +
    `{:business:} <b>គ្រប់គ្រងអាជីវកម្ម</b> — វិក្កយបត្រ ស្តុក របាយការណ៍\n` +
    `{:emoji:} <b>បង្កើត Emoji</b> — រូប/GIF/វីដេអូ → Emoji ផ្ទាល់ខ្លួន\n\n` +
    `ជ្រើសខាងក្រោម 👇`,
  help:
    `{:help:} <b>របៀបប្រើ</b>\n\n` +
    `<b>១. វីដេអូ</b> — ជ្រើសវីដេអូ ឬបិទភ្ជាប់ Link។ AI ស្កេនឃ្លា បកប្រែ និងចែកតួ។\n` +
    `<b>២. តួ និងសំឡេង</b> — តួនីមួយៗមានសំឡេងតែមួយគ្រប់ឃ្លា។ ជ្រើស Auto ឬក្លូនពីវីដេអូ។\n` +
    `<b>៣. បង្កើតវីដេអូ</b> — ចុចម្ដង រង់ចាំ ហើយទាញយកក្នុងផ្ទាំង «វីដេអូ»។ អាចបិទ App បាន។\n\n` +
    `💡 វីដេអូមួយ ≤ ១០ នាទី។ វីដេអូវែង (Pro) បំបែកជាផ្នែក ហើយភ្ជាប់វិញបាន។`,
  emoji:
    `{:emoji:} <b>បង្កើត Emoji</b>\n\n` +
    `ផ្ញើមកខ្ញុំ <b>រូបភាព · GIF · វីដេអូ · Sticker</b> ណាមួយ ហើយខ្ញុំនឹង៖\n` +
    `• ដាក់ចូល <b>កញ្ចប់ Emoji ផ្ទាល់ខ្លួន</b> របស់អ្នក (t.me/addemoji/…)\n` +
    `• ផ្ញើឯកសារ <b>គ្រប់ទម្រង់</b> មកវិញ៖ PNG 512 (ថ្លា) · WebP · PNG 100 · វីដេអូ/GIF៖ WebM 100 + GIF\n\n` +
    `✂️ រូបត្រូវបានកាត់យកការ៉េកណ្ដាល។ វីដេអូ/GIF ប្រើ ៣ វិនាទីដំបូង។\n` +
    `ℹ️ ប្រើ Emoji ក្នុងសារ ត្រូវការ Telegram Premium។`,
  coding:
    `{:coding:} <b>Emoji សម្រាប់កូដ</b>\n\n` +
    `ឈុត <b>${studio.ICONS.length} icon</b> (<code>&gt;_</code> <code>{ }</code> <code>&lt;/&gt;</code> bug · git · ✓ ✗ · API · SQL · 404 …)\n` +
    `ជា <b>កញ្ចប់ Emoji</b> + <b>ZIP</b> (PNG 512/100) សម្រាប់ README, Discord, Slack។\n\nជ្រើសពណ៌ 👇`,
  badgeHelp:
    `{:badge:} <b>ស្លាកអក្សរ Terminal</b>\n\nផ្ញើពាក្យបញ្ជា៖\n<code>/badge npm run dev</code>\n<code>/badge dracula git push origin main</code>\n\n` +
    `ពណ៌៖ <code>terminal</code> · <code>neon</code> · <code>dracula</code> · <code>light</code>`,
  business: `{:business:} <b>គ្រប់គ្រងអាជីវកម្ម</b>\n\nបង្កើតវិក្កយបត្រ គ្រប់គ្រងស្តុក និងមើលរបាយការណ៍ ក្នុង App តែមួយ។`,
  businessMissing: "{:business:} មុខងារនេះមិនទាន់បើក (DUBBER_BUSINESS_URL មិនទាន់កំណត់)។",
  menuHint: "{:logo:} ម៉ឺនុយនៅខាងក្រោម 👇",
  busy: "{:wait:} កំពុងធ្វើមួយរួចហើយ សូមរង់ចាំបន្តិច។",
  working: "{:wait:} កំពុងបង្កើត…",
  fallback: "ចុចប៊ូតុងខាងក្រោម ឬផ្ញើរូបភាព/GIF/វីដេអូ ដើម្បីបង្កើត Emoji 👇",
  failed: (why) => `❌ មិនបានទេ៖ ${esc(why)}`,
  emojiDone: (link, count) =>
    `{:ok:} រួចរាល់! Emoji ចូលក្នុងកញ្ចប់របស់អ្នក (${count})៖\n${link}\n\nបើកតំណដើម្បីបន្ថែមកញ្ចប់ ហើយផ្ញើរូបទៀតដើម្បីបន្ថែមបន្ត។`,
  codingDone: (link, count, created) =>
    `{:ok:} ${created ? "បានបង្កើត" : "កញ្ចប់នេះមានរួចហើយ"} — ${count} icon៖\n${link}\n\n📦 ZIP ត្រូវបានផ្ញើខាងលើ។`,
};

/* ── Buttons (Khmer names; icon = spinning 3D custom emoji) ── */
const LABEL = {
  dubber: "បញ្ចូលសំឡេងខ្មែរ",
  business: "គ្រប់គ្រងអាជីវកម្ម",
  emoji: "បង្កើត Emoji",
  coding: "Emoji កូដ",
  badge: "ស្លាកអក្សរ",
  help: "របៀបប្រើ",
  back: "ត្រឡប់",
  support: "ជំនួយ",
};
const openButton = { text: LABEL.dubber, icon: "dubber", web_app: { url: STUDIO_URL } };
const homeKeyboard = () => ({
  inline_keyboard: [
    [openButton],
    ...(BUSINESS_URL ? [[{ text: LABEL.business, icon: "business", web_app: { url: BUSINESS_URL } }]] : []),
    [{ text: LABEL.emoji, icon: "emoji", callback_data: "emoji" }, { text: LABEL.coding, icon: "coding", callback_data: "coding" }],
    [{ text: LABEL.badge, icon: "badge", callback_data: "badge" }, { text: LABEL.help, icon: "help", callback_data: "help" }],
    ...(SUPPORT_URL ? [[{ text: `💬 ${LABEL.support}`, url: SUPPORT_URL }]] : []),
  ],
});
// The reply keyboard under the message box. Old labels keep working for people with an old keyboard.
const MENU = {
  business: [LABEL.business],
  emoji: [LABEL.emoji, "Emoji Maker"],
  help: [LABEL.help],
};
const menuKeyboard = () => ({
  keyboard: [
    [{ text: LABEL.dubber, icon: "dubber", web_app: { url: STUDIO_URL } }],
    [{ text: LABEL.business, icon: "business" }],
    [{ text: LABEL.emoji, icon: "emoji" }, { text: LABEL.help, icon: "help" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
});
const bare = (t) => String(t).replace(/^[\p{Extended_Pictographic}️‍\s]+/u, "").trim();
const menuPick = (raw) => Object.entries(MENU).find(([, labels]) => labels.includes(bare(raw)))?.[0];
const backRow = [{ text: LABEL.back, icon: "back", callback_data: "home" }];
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

/* ── Profile: name, descriptions, commands (all Khmer) ── */
const PROFILE = {
  name: "TeleScripts",
  short:
    "🎬 បញ្ចូលសំឡេងខ្មែរលើវីដេអូ (AI ក្លូនសំឡេង) · 🧾 គ្រប់គ្រងអាជីវកម្ម · 🎨 បង្កើត Emoji",
  description:
    "✈️ TeleScripts — Bot ជំនួយការងារ ជាភាសាខ្មែរ\n\n" +
    "🎬 បញ្ចូលសំឡេងខ្មែរ\n• AI ស្កេនវីដេអូ បកប្រែ និងចែកតួ\n• តួនីមួយៗមានសំឡេងផ្ទាល់ (ក្លូន VoxCPM2)\n• វីដេអូវែង បំបែក ហើយភ្ជាប់វិញ\n\n" +
    "🧾 គ្រប់គ្រងអាជីវកម្ម — វិក្កយបត្រ ស្តុក របាយការណ៍\n" +
    "🎨 បង្កើត Emoji — រូប/GIF/វីដេអូ → Emoji ផ្ទាល់ខ្លួន\n\n" +
    "👇 ចុច «ចាប់ផ្ដើម» ដើម្បីប្រើ",
  commands: [
    { command: "start", description: "🏠 ម៉ឺនុយដើម" },
    { command: "dub", description: "🎬 បញ្ចូលសំឡេងខ្មែរ" },
    { command: "business", description: "🧾 គ្រប់គ្រងអាជីវកម្ម" },
    { command: "emoji", description: "🎨 បង្កើត Emoji ពីរូប/GIF/វីដេអូ" },
    { command: "coding", description: "💻 Emoji សម្រាប់កូដ" },
    { command: "badge", description: "🏷 ស្លាកអក្សរ Terminal" },
    { command: "help", description: "📖 របៀបប្រើ" },
  ],
};

/* ── Setup ── */
async function setup() {
  const me = await call("getMe");
  api.username = String(me.username || "").toLowerCase();
  console.log(`[dubber-bot] @${me.username} ready`);
  await call("deleteWebhook", { drop_pending_updates: false }); // long polling and a webhook cannot coexist
  const steps = [
    ["setMyCommands", { commands: PROFILE.commands }],
    ["setChatMenuButton", { menu_button: { type: "web_app", text: "🎬 Dubber", web_app: { url: STUDIO_URL } } }],
    ["setMyName", { name: PROFILE.name }],
    ["setMyShortDescription", { short_description: PROFILE.short }],
    ["setMyDescription", { description: PROFILE.description }],
  ];
  for (const [method, body] of steps) {
    // A cosmetic setting failing (rate limit, name cooldown) must not stop the bot
    await call(method, body).catch((e) => console.warn(`[dubber-bot] ${e.message}`));
  }
}

/* ── Sending: custom emoji first, plain emoji if Telegram refuses them ── */
async function send(chat_id, text, reply_markup) {
  const body = (plain) => {
    if (plain) plainUntil = Math.max(plainUntil, Date.now() + 10 * 60_000);
    return { chat_id, text: deco(text), parse_mode: "HTML", reply_markup: decoMarkup(reply_markup), link_preview_options: { is_disabled: true } };
  };
  try {
    return await call("sendMessage", body(false));
  } catch (e) {
    if (usePlain() || !emojiRefused(e.message)) throw e;
    console.warn(`[dubber-bot] custom emoji refused (${e.message}) — plain emoji for 10 min`);
    return call("sendMessage", body(true));
  }
}

async function edit(chat_id, message_id, text, reply_markup) {
  const body = () => ({ chat_id, message_id, text: deco(text), parse_mode: "HTML", reply_markup: decoMarkup(reply_markup) });
  try {
    await call("editMessageText", body());
  } catch (e) {
    if (/not modified/i.test(e.message)) return; // the same button tapped twice
    if (usePlain() || !emojiRefused(e.message)) throw e;
    plainUntil = Date.now() + 10 * 60_000;
    await call("editMessageText", body());
  }
}

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

/** The TeleScripts logo spins 360° (MP4) with the welcome, then the menu appears. */
async function welcome(msg) {
  const chatId = msg.chat.id;
  const [text, markup] = VIEWS.home(msg.from);
  let sent = false;
  for (const plain of [false, true]) {
    if (sent || (plain && usePlain())) break;
    if (plain) plainUntil = Date.now() + 10 * 60_000;
    try {
      const cached = store.animationFile === LOGO_MP4 ? store.animationFileId : "";
      const fd = new FormData();
      fd.set("chat_id", String(chatId));
      if (cached) fd.set("animation", cached);
      else fd.set("animation", new Blob([await fs.readFile(path.join(ASSETS, LOGO_MP4))]), LOGO_MP4);
      fd.set("width", "512");
      fd.set("height", "512");
      fd.set("caption", deco(text));
      fd.set("parse_mode", "HTML");
      fd.set("reply_markup", JSON.stringify(decoMarkup(markup)));
      const r = await form("sendAnimation", fd);
      if (r.ok) {
        sent = true;
        const id = r.result?.animation?.file_id || r.result?.document?.file_id;
        if (id && id !== store.animationFileId) {
          Object.assign(store, { animationFileId: id, animationFile: LOGO_MP4 });
          await saveStore();
        }
      } else if (cached && !emojiRefused(r.description)) {
        store.animationFileId = ""; // a stale file_id: upload it again next time
      } else if (!emojiRefused(r.description)) break;
    } catch (e) {
      console.warn(`[dubber-bot] logo animation: ${e.message}`);
      break;
    }
  }
  if (!sent) await send(chatId, text, markup);
  await send(chatId, TEXT.menuHint, menuKeyboard());
}

const business = (chatId) =>
  BUSINESS_URL
    ? send(chatId, TEXT.business, { inline_keyboard: [[{ text: `បើក App ${LABEL.business}`, icon: "business", web_app: { url: BUSINESS_URL } }]] })
    : send(chatId, TEXT.businessMissing);

const dub = (chatId) => send(chatId, `{:dubber:} <b>${LABEL.dubber}</b>\n\nចុចប៊ូតុងខាងក្រោម ដើម្បីបើក App។`, { inline_keyboard: [[openButton]] });

const show = (chat_id, view, from) => {
  const [text, markup] = VIEWS[view](from);
  return send(chat_id, text, markup);
};

/* ── Admin: build the spinning 3D emoji pack used on the buttons ── */
async function makeEmojiPack(msg) {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.has(String(msg.from.id))) return send(chatId, "⛔ សម្រាប់ Admin ប៉ុណ្ណោះ (DUBBER_ADMIN_IDS)។");
  const name = `tsui_by_${api.username}`;
  const keys = Object.keys(ICON);
  const fd = new FormData();
  fd.set("user_id", String(msg.from.id));
  fd.set("name", name);
  fd.set("title", "TeleScripts · 3D Icons");
  fd.set("sticker_type", "custom_emoji");
  const list = [];
  for (const key of keys) {
    const file = path.join(ASSETS, "emoji", `${ICON[key][0]}.webm`);
    fd.set(`f_${key}`, new Blob([await fs.readFile(file)], { type: "video/webm" }), `${key}.webm`);
    list.push({ sticker: `attach://f_${key}`, format: "video", emoji_list: [ICON[key][1].replace("️", "")] });
  }
  fd.set("stickers", JSON.stringify(list));
  await send(chatId, "{:wait:} កំពុងបង្កើតកញ្ចប់ Emoji 3D…");
  // Rebuild from scratch so the order (and so every id) matches ICON
  await call("deleteStickerSet", { name }).catch(() => {});
  const r = await form("createNewStickerSet", fd);
  if (!r.ok) return send(chatId, TEXT.failed(r.description || "createNewStickerSet"));
  const set = await call("getStickerSet", { name });
  const emoji = {};
  set.stickers.forEach((st, i) => keys[i] && st.custom_emoji_id && (emoji[keys[i]] = st.custom_emoji_id));
  Object.assign(store, { emoji, emojiPack: name });
  plainUntil = 0;
  await saveStore();
  await send(
    chatId,
    `{:ok:} កញ្ចប់ Emoji 3D រួចរាល់ (${Object.keys(emoji).length})\n${keys.map((k) => `{:${k}:}`).join(" ")}\n\nhttps://t.me/addemoji/${name}\n\n` +
      `ℹ️ បើប៊ូតុងនៅតែបង្ហាញ emoji ធម្មតា គណនីម្ចាស់ Bot ត្រូវមាន Telegram Premium។`,
    menuKeyboard()
  );
}

async function onMessage(msg) {
  if (msg.chat?.type !== "private") return;
  const chatId = msg.chat.id;
  const raw = (msg.text || msg.caption || "").trim();
  const [head, ...rest] = raw.split(/\s+/);
  const cmd = head.toLowerCase().replace(/@.*$/, "");
  const args = rest.join(" ");

  if (cmd === "/start") return welcome(msg);
  if (cmd === "/makeemoji") return makeEmojiPack(msg);
  const pick = menuPick(raw);
  if (pick === "business" || cmd === "/business") return business(chatId);
  if (pick === "emoji" || cmd === "/emoji") return show(chatId, "emoji");
  if (pick === "help" || cmd === "/help") return show(chatId, "help");
  if (cmd === "/dub") return dub(chatId);
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
  // The welcome is an animation with a caption: answer with a fresh message instead of editing text
  if (q.message.animation || q.message.caption !== undefined) return send(chatId, text, markup);
  await edit(chatId, message_id, text, markup);
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
