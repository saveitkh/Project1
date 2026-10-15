/**
 * Khmer Dubber bot: opens the Dubber Mini App and doubles as an emoji design studio
 * (photo/GIF/video -> custom emoji + every file format, Coding & Terminal icon sets,
 * terminal text badges). Long polling, so it needs no public URL and cannot fight the
 * other bot's webhook. Run: `node src/dubberBot.js`
 *
 * Env: DUBBER_BOT_TOKEN, DUBBING_STUDIO_URL (https), optional DUBBER_SUPPORT_URL.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as studio from "./emojiStudio.js";

const TOKEN = (process.env.DUBBER_BOT_TOKEN || "").trim();
const STUDIO_URL = (process.env.DUBBING_STUDIO_URL || "").trim();
const SUPPORT_URL = (process.env.DUBBER_SUPPORT_URL || "").trim();
const BUSINESS_URL = (process.env.DUBBER_BUSINESS_URL || "").trim();
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

/* ── Tiny store: members, referrals, download counts (a JSON file on a volume) ── */
const STORE_FILE = path.join(DATA_DIR, "dubber-bot.json");
let store = { users: {}, animationFileId: "" };
try {
  store = { ...store, ...JSON.parse(await fs.readFile(STORE_FILE, "utf8")) };
} catch {}
let saveTimer = null;
const saveStore = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(STORE_FILE + ".tmp", JSON.stringify(store));
      await fs.rename(STORE_FILE + ".tmp", STORE_FILE);
    } catch (e) {
      console.warn(`[dubber-bot] store not saved: ${e.message}`);
    }
  }, 500);
};
/** Finds or creates the member; a first /start?start=ref_<id> credits that member once (never yourself). */
function member(from, startPayload = "") {
  const id = String(from.id);
  let u = store.users[id];
  if (!u) {
    u = store.users[id] = { name: from.first_name || from.username || "", joined: Date.now(), downloads: 0, referred: 0, by: null };
    const ref = /^ref_(\d+)$/.exec(startPayload || "")?.[1];
    if (ref && ref !== id && store.users[ref]) {
      u.by = ref;
      store.users[ref].referred += 1;
      call("sendMessage", { chat_id: ref, text: `🎉 ${from.first_name || "មិត្ត"} បានចូលរួមតាមតំណណែនាំរបស់អ្នក!` }).catch(() => {});
    }
    saveStore();
  }
  return u;
}

/** yt-dlp -> one mp4 (or mp3) under Telegram's 50 MB bot upload limit. */
function ytdlp(url, audioOnly, dir) {
  const args = audioOnly
    ? ["-x", "--audio-format", "mp3", "--audio-quality", "5"]
    : ["-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[ext=mp4]/b", "--merge-output-format", "mp4"];
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", [...args, "--no-playlist", "--max-filesize", "49M", "--no-warnings", "-o", path.join(dir, "v.%(ext)s"), url]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 5 * 60_000);
    p.on("error", reject);
    p.on("close", async (code) => {
      clearTimeout(timer);
      const file = (await fs.readdir(dir)).find((f) => f.startsWith("v."));
      if (code === 0 && file) return resolve(path.join(dir, file));
      reject(new Error(/larger than max-filesize|File is larger/i.test(err) ? "ឯកសារធំជាង 50MB (កំណត់របស់ Telegram bot)" : (err.split("\n").filter(Boolean).pop() || "ទាញយកមិនបាន").slice(0, 160)));
    });
  });
}

async function runDownload(chatId, from, url, audioOnly) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dl-"));
  try {
    const file = await withProgress(chatId, () => ytdlp(url, audioOnly, dir));
    const fd = new FormData();
    fd.set("chat_id", String(chatId));
    fd.set(audioOnly ? "audio" : "video", new Blob([await fs.readFile(file)]), path.basename(file));
    if (!audioOnly) fd.set("supports_streaming", "true");
    fd.set("caption", "✅ ទាញយករួច · ឥតគិតថ្លៃ");
    const r = await form(audioOnly ? "sendAudio" : "sendVideo", fd);
    if (!r.ok) throw new Error(r.description || "ផ្ញើមិនបាន");
    member(from).downloads += 1;
    saveStore();
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

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
  download:
    `⬇️ <b>ទាញយកវីដេអូ (ឥតគិតថ្លៃ)</b>\n\n` +
    `ផ្ញើ Link មកខ្ញុំ — YouTube · Facebook · TikTok · Instagram · X ឬ Link .mp4\n` +
    `បន្ថែមពាក្យ <code>audio</code> ក្រោយ Link ដើម្បីបានតែសំឡេង (MP3)។\n\n` +
    `ℹ️ ឯកសារត្រូវ ≤ 50MB (កំណត់របស់ Telegram)។ វីដេអូវែង សូមប្រើ Khmer Dubber។`,
  business:
    `🧾 <b>គ្រប់គ្រងអាជីវកម្ម</b>\n\nបង្កើតវិក្កយបត្រ ស្តុក និងរបាយការណ៍ក្នុង App តែមួយ។`,
  businessMissing: "🧾 មុខងារនេះមិនទាន់បើក (DUBBER_BUSINESS_URL មិនទាន់កំណត់)។",
  referral: (count, link) =>
    `👥 <b>ណែនាំមិត្ត</b>\n\nចែករំលែកតំណនេះ — ពេលមិត្តចុច និងចាប់ផ្ដើមប្រើ អ្នកទទួលបានភ្លាម។\n\n` +
    `📊 អ្នកបានណែនាំ៖ <b>${count}</b> នាក់\n🔗 <code>${link}</code>`,
  account: (from, u) =>
    `👤 <b>គណនី</b>\n\nឈ្មោះ៖ <b>${esc(from.first_name || from.username || "—")}</b>\nTelegram ID៖ <code>${from.id}</code>\n` +
    `⬇️ បានទាញយក៖ <b>${u.downloads}</b>\n👥 បានណែនាំ៖ <b>${u.referred}</b>\n\n` +
    `🎬 គម្រោង និងនាទី Khmer Dubber មើលក្នុង App → ការកំណត់។`,
  menuHint: "ជ្រើសម៉ឺនុយខាងក្រោម 👇",
  needUrl: "ផ្ញើ Link វីដេអូ (https://…) មកខ្ញុំ 👇",
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
const MENU = {
  download: "⬇️ ទាញយកវីដេអូ",
  business: "🧾 គ្រប់គ្រងអាជីវកម្ម",
  referral: "👥 ណែនាំមិត្ត",
  account: "👤 គណនី",
  emoji: "🎨 Emoji Maker",
  help: "📖 របៀបប្រើ",
};
const menuKeyboard = () => ({
  keyboard: [
    [{ text: "🎬 Khmer Dubber", web_app: { url: STUDIO_URL } }],
    [{ text: MENU.download }, { text: MENU.business }],
    [{ text: MENU.referral }, { text: MENU.account }],
    [{ text: MENU.emoji }, { text: MENU.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
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
      { command: "download", description: "ទាញយកវីដេអូ (ឥតគិតថ្លៃ)" },
      { command: "business", description: "គ្រប់គ្រងអាជីវកម្ម" },
      { command: "referral", description: "ណែនាំមិត្ត" },
      { command: "account", description: "គណនី" },
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

/** The logo spins one full turn forward (MP4), then the menu appears. */
async function welcome(msg, startPayload) {
  const chatId = msg.chat.id;
  member(msg.from, startPayload);
  const [text, markup] = VIEWS.home(msg.from);
  let sent = false;
  try {
    const fd = new FormData();
    fd.set("chat_id", String(chatId));
    if (store.animationFileId) fd.set("animation", store.animationFileId);
    else fd.set("animation", new Blob([await fs.readFile(path.join(ASSETS, "telescripts-spin.mp4"))]), "telescripts-spin.mp4");
    fd.set("width", "512");
    fd.set("height", "512");
    fd.set("caption", text);
    fd.set("parse_mode", "HTML");
    fd.set("reply_markup", JSON.stringify(markup));
    const r = await form("sendAnimation", fd);
    if (r.ok) {
      sent = true;
      const id = r.result?.animation?.file_id || r.result?.document?.file_id;
      if (id && id !== store.animationFileId) {
        store.animationFileId = id;
        saveStore();
      }
    } else if (store.animationFileId) {
      store.animationFileId = ""; // a stale file_id: next /start uploads it again
    }
  } catch (e) {
    console.warn(`[dubber-bot] logo animation: ${e.message}`);
  }
  if (!sent) await send(chatId, text, markup);
  await send(chatId, TEXT.menuHint, menuKeyboard());
}

const business = (chatId) =>
  BUSINESS_URL
    ? send(chatId, TEXT.business, { inline_keyboard: [[{ text: "🧾 បើក App អាជីវកម្ម", web_app: { url: BUSINESS_URL } }]] })
    : send(chatId, TEXT.businessMissing);

async function referral(msg) {
  const u = member(msg.from);
  const link = `https://t.me/${api.username}?start=ref_${msg.from.id}`;
  return send(msg.chat.id, TEXT.referral(u.referred, link), {
    inline_keyboard: [[{ text: "📤 ចែករំលែក", url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("🎬 Khmer Dubber — បញ្ចូលសំឡេងខ្មែរលើវីដេអូ")}` }]],
  });
}

const account = (msg) =>
  send(msg.chat.id, TEXT.account(msg.from, member(msg.from)), { inline_keyboard: [[openButton]] });

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

  if (cmd === "/start") return welcome(msg, args);
  const pick = Object.entries(MENU).find(([, label]) => label === raw)?.[0];
  if (pick === "download") return send(chatId, TEXT.download);
  if (pick === "business") return business(chatId);
  if (pick === "referral") return referral(msg);
  if (pick === "account") return account(msg);
  if (pick === "emoji") return show(chatId, "emoji");
  if (pick === "help") return show(chatId, "help");
  if (cmd === "/download") return send(chatId, TEXT.download);
  if (cmd === "/business") return business(chatId);
  if (cmd === "/referral") return referral(msg);
  if (cmd === "/account") return account(msg);
  const url = /https?:\/\/\S+/i.exec(raw)?.[0];
  if (url && !studio.mediaOf(msg)) {
    return exclusive(chatId, () => runDownload(chatId, msg.from, url, /\b(audio|mp3|សំឡេង)\b/i.test(raw.replace(url, ""))));
  }
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
