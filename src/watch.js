/**
 * "🎬 មើលរឿង" (Watch) -- Anime / Donghua / Movie, sold one episode at a time
 * inside the bot.
 *
 * Reuses this backend's existing mirroring pieces instead of building a
 * second one: a `groups` row is a source Telegram group (the VIP group with
 * Topics, one per show), `topics` are its Telegram forum topics, and
 * `episodes` are the numbered video messages scanner.js already finds in
 * it -- the same tables and scanner the dashboard's Groups page uses. This
 * module only adds what that schema doesn't have yet: a show's genre,
 * poster, status and per-episode price, and who has bought which episode.
 * That extra bit is kept as JSON in Supabase Storage (bucket
 * "watch-catalog"), the same way botConfig.js keeps the bot's payment
 * settings -- the SaveIt database itself has no migration path open to this
 * service right now, so a new column isn't an option, but Storage always
 * has been.
 *
 * Delivery is always botDeliver.deliverEpisode's forward-copy (the group
 * never needs downloading to R2 first) -- never an episode's own r2_key,
 * even as a fallback: this schema is shared with an unrelated mirror-
 * dashboard product, so a row's r2_key can be a leftover from that
 * pipeline and point at entirely different content. A failed forward is a
 * refund, never a guess at the right file.
 *
 * Payment: a top-up buys Watch Credit, exactly like the bot's existing
 * "Add Credit" buys downloads (bot_packages rows, KHQR, botPay.grant) --
 * these just carry the "watch_" id prefix instead of none, and grant Watch
 * Credit instead of paid_downloads. One episode costs a show's own
 * ep_credits (default 1); the $1-for-4 tier prices that at $0.25 each, the
 * number asked for.
 */
import { mainKeyboard } from "./botText.js";
import { config } from "./config.js";
import { db, fetchAll, nowIso, rows } from "./db.js";
import * as botDeliver from "./botDeliver.js";
import * as customEmoji from "./customEmoji.js";
import { call } from "./notifyBot.js";
import { parseEpNumber, scanGroup } from "./scanner.js";
import { parseTelegramLink } from "./telegram.js";

const BUCKET = "watch-catalog";
const SHOWS_FILE = "shows.json";
const WALLET_FILE = "wallet.json";
const CACHE_MS = 20_000;

export const WATCH_PACKAGE_PREFIX = "watch_";
export const isWatchPackage = (id) => String(id ?? "").startsWith(WATCH_PACKAGE_PREFIX);

export const KINDS = ["anime", "donghua", "movie"];
const KIND_NAME = {
  anime: { km: "Anime", en: "Anime" },
  donghua: { km: "Donghua និយាយខ្មែរ", en: "Donghua (Khmer dub)" },
  movie: { km: "ភាគយន្តនិយាយខ្មែរ", en: "Khmer-dubbed Movies" },
};
// Anime stays a valid tag (for /setshow), just not offered as a genre.
const SHOWN_KINDS = ["donghua", "movie"];
// The plain emoji a genre button shows, and the custom icon that takes its
// place wherever custom emoji render.
const KIND_EMOJI = { anime: "🎌", donghua: "🐉", movie: "🎬" };
const KIND_ICON = { anime: "sparkle", donghua: "fire", movie: "video" };

const DEFAULT_PRICE_USD = 0.25;

const PACKAGES = [
  { id: "watch_1", title_km: "{:video:} 4 Ep — $1", title_en: "{:video:} 4 Ep — $1", price_usd: 1, downloads: 4, sort: 201 },
  { id: "watch_5", title_km: "{:video:} 22 Ep (+2 ឥតគិតថ្លៃ) — $5", title_en: "{:video:} 22 Ep (+2 free) — $5", price_usd: 5, downloads: 22, sort: 202 },
  { id: "watch_10", title_km: "{:video:} 46 Ep (+6 ឥតគិតថ្លៃ) — $10", title_en: "{:video:} 46 Ep (+6 free) — $10", price_usd: 10, downloads: 46, sort: 203 },
];

/** Upserts the top-up tiers, called once at startup like khInvoice.announce(). */
export async function announce() {
  await db()
    .from("bot_packages")
    .upsert(
      PACKAGES.map((p) => ({ ...p, days: null, active: true })),
      { onConflict: "id" }
    );
}

// ------------------------------------------------------------ storage JSON
// One small file per concern, cached briefly, written back in full on every
// change -- the exact pattern botConfig.js already uses for payments.json.

const cache = new Map();

async function readJson(file, fallback) {
  const hit = cache.get(file);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  let data = fallback;
  try {
    const { data: blob, error } = await db().storage.from(BUCKET).download(file);
    if (error || !blob) throw error ?? new Error("missing");
    data = { ...fallback, ...JSON.parse(await blob.text()) };
  } catch {
    data = fallback;
  }
  cache.set(file, { data, at: Date.now() });
  return data;
}

async function writeJson(file, data) {
  const storage = db().storage;
  const body = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  let { error } = await storage.from(BUCKET).upload(file, body, { upsert: true, contentType: "application/json" });
  if (error && /bucket not found|not found/i.test(String(error.message ?? error))) {
    await storage.createBucket(BUCKET, { public: false });
    ({ error } = await storage.from(BUCKET).upload(file, body, { upsert: true, contentType: "application/json" }));
  }
  if (error) throw new Error(`Could not save the watch catalog: ${error.message ?? error}`);
  cache.set(file, { data, at: Date.now() });
  return data;
}

/** topicId -> { kind, status, ep_credits, poster_emoji, on_sale } */
async function showMeta() {
  return readJson(SHOWS_FILE, {});
}
async function saveShowMeta(topicId, patch) {
  const all = await showMeta();
  const next = { ...all, [topicId]: { on_sale: true, ep_credits: 1, status: "ongoing", ...all[topicId], ...patch } };
  await writeJson(SHOWS_FILE, next);
  return next[topicId];
}

/** telegramUserId -> { credits, bought: { episodeId: true } } */
async function wallets() {
  return readJson(WALLET_FILE, {});
}
async function walletFor(userId) {
  const all = await wallets();
  return all[userId] ?? { credits: 0, bought: {} };
}
async function saveWallet(userId, entry) {
  const all = await wallets();
  const next = { ...all, [userId]: entry };
  await writeJson(WALLET_FILE, next);
  return entry;
}

/** Adds Watch Credit from a paid top-up. Called from botPay.grant(). */
export async function grantTopUp(userId, credits) {
  const w = await walletFor(userId);
  const next = { ...w, credits: (w.credits ?? 0) + credits };
  await saveWallet(userId, next);
  return next.credits;
}

// ------------------------------------------------------------ texts

const SEP = "━━━━━━━━━━━━━━";

const L = {
  km: {
    home: (credits) =>
      `{:donghua_badge:} Donghua និយាយខ្មែរ (សម្រាប់លក់)\n${SEP}\n` +
      `{:m_account:} Credit របស់អ្នក៖ ${credits}\n` +
      `{:credit:} 1 ភាគ = 1 Credit ($${DEFAULT_PRICE_USD.toFixed(2)})\n${SEP}\n` +
      `{:bulb:} ជ្រើសរើសប្រភេទរឿងខាងក្រោម៖`,
    noShows: (kind) => `{:${KIND_ICON[kind]}:} ${KIND_NAME[kind].km}\n\n{:warn:} មិនទាន់មានរឿងក្នុងប្រភេទនេះទេ។`,
    showList: (kind, total, page, pages, lines, firstN) =>
      `{:${KIND_ICON[kind]}:} ${KIND_NAME[kind].km}\n${SEP}\n` +
      `${lines.join("\n\n")}\n${SEP}\n` +
      `{:inv_summary:} ទំព័រ ${page}/${pages} · សរុប ${total} រឿង\n` +
      `{:bulb:} ចុចរឿងខាងក្រោម ឬវាយលេខរឿង (ឧ. ${firstN})`,
    showLine: (n, title, count, completed) =>
      `${n}. ${title}\n      ${completed ? "{:ok:} ចប់ហើយ" : "{:fire:} កំពុងចេញ"} · ${count} ភាគ`,
    allShows: (kind, total) => `{:${KIND_ICON[kind]}:} ${KIND_NAME[kind].km} — រឿងទាំងអស់ (${total})\n${SEP}`,
    allShowsHint: "{:bulb:} វាយលេខរឿង ដើម្បីបើកវា (ឧ. 5)",
    viewAll: "📋 មើលរឿងទាំងអស់",
    viewAllEps: "📋 មើលភាគទាំងអស់",
    epHint: (first) => `{:bulb:} វាយលេខ EP ដែលចង់ទិញ ឧ. ${first}`,
    allEps: (title, count) => `{:video:} ${title} — ភាគទាំងអស់ (${count})\n${SEP}\n{:ok:} = បានទិញ   {:lock:} = មិនទាន់ទិញ`,
    noSuchShow: (n, total) => `{:warn:} មិនមានរឿងលេខ ${n} ទេ — មានលេខ 1 ដល់ ${total}។`,
    epScreen: ({ title, count, completed, credits, balance, from, to, owned, example, rangeExample }) =>
      `{:video:} ${title}\n${SEP}\n` +
      `${completed ? "{:ok:} ចប់ហើយ" : "{:fire:} កំពុងចេញ"} · ${count} ភាគ\n` +
      `{:ticket:} EP ${from} ដល់ EP ${to}\n` +
      `{:credit:} 1 ភាគ = ${credits} Credit ($${(credits * DEFAULT_PRICE_USD).toFixed(2)})\n` +
      `{:m_account:} Credit របស់អ្នក៖ ${balance}\n` +
      (owned ? `{:ok:} បានទិញ៖ ${owned}\n` : "") +
      `${SEP}\n{:bulb:} វាយលេខ EP ដែលចង់ទិញ ក្នុងឆាត ឧ. ${example}${rangeExample ? ` ឬ ${rangeExample}` : ""}`,
    notFound: (want, from, to) => `{:warn:} រកមិនឃើញ EP ${want} ទេ — មាន EP ${from} ដល់ EP ${to}។`,
    tooMany: (max) => `{:warn:} ទិញបានម្ដងច្រើនបំផុត ${max} ភាគ។`,
    noEpisodes: (title) => `{:video:} ${title}\n\n{:warn:} មិនទាន់មានភាគសម្រាប់លក់ទេ។`,
    needMore: (need, have) => `{:warn:} Credit មិនគ្រប់ទេ — ត្រូវការ ${need} ប៉ុន្តែមាន ${have}។\n\n{:credit:} សូមបន្ថែម Watch Credit ខាងក្រោម៖`,
    needMoreToast: "Credit មិនគ្រប់ — សូមបន្ថែម Credit",
    delivering: (label) => `⏳ កំពុងផ្ញើ EP ${label}…`,
    delivered: (title, label) => `{:video:} ${title}\n{:ticket:} EP ${label}`,
    deliverFailed: "{:fail:} មិនអាចផ្ញើវីដេអូនេះបានទេ (Credit មិនត្រូវបានកាត់ទេ)។ សូមទាក់ទងអ្នកគ្រប់គ្រង។",
    topUpTitle: (credits) =>
      `{:credit:} បន្ថែម Watch Credit\n\n` +
      `{:credit:} Credit បច្ចុប្បន្ន៖ ${credits}\n` +
      `{:ticket:} 1 Credit = 1 ភាគ\n\n` +
      `{:bulb:} ជ្រើសរើសកញ្ចប់ រួចបង់តាម KHQR៖`,
    granted: (n, left) => `{:party:} ការទូទាត់បានបញ្ជាក់! +${n} Watch Credit\n{:credit:} Watch Credit នៅសល់៖ ${left}\n\n{:video:} ចូល រឿងនិយាយខ្មែរ ដើម្បីទិញភាគ។`,
    back: "⬅️ ត្រឡប់",
    mainMenu: "⬅️ ម៉ឺនុយដើម",
    topUp: "💲 បញ្ចូល Credit សម្រាប់ទិញវីដេអូ EP",
    dlCredit: "📥 បញ្ចូល Credit សម្រាប់ Download Private",
    prevPage: "◀️ ថយក្រោយ",
    nextPage: "▶️ បន្ត",
    manage: "🙈 លាក់រឿង (Admin)",
    manageDone: "✅ រួចរាល់",
    manageHint: "\n\n{:warn:} Admin: ចុចលើរឿងណាមួយ ដើម្បីលាក់វា។",
    posterBtn: "🖼 ដាក់ Poster (Admin)",
    posterAsk: (title) => `{:camera:} ផ្ញើរូប poster សម្រាប់ «${title}» ឥឡូវនេះ (រូបភាព មិនមែន file)។`,
    hidden: "🙈 បានលាក់រឿងនេះ",
    epUnit: "ភាគ",
  },
  en: {
    home: (credits) =>
      `{:donghua_badge:} Donghua in Khmer (for sale)\n${SEP}\n` +
      `{:m_account:} Your Credit: ${credits}\n` +
      `{:credit:} 1 episode = 1 Credit ($${DEFAULT_PRICE_USD.toFixed(2)})\n${SEP}\n` +
      `{:bulb:} Pick a genre below:`,
    noShows: (kind) => `{:${KIND_ICON[kind]}:} ${KIND_NAME[kind].en}\n\n{:warn:} No shows in this genre yet.`,
    showList: (kind, total, page, pages, lines, firstN) =>
      `{:${KIND_ICON[kind]}:} ${KIND_NAME[kind].en}\n${SEP}\n` +
      `${lines.join("\n\n")}\n${SEP}\n` +
      `{:inv_summary:} Page ${page}/${pages} · ${total} shows\n` +
      `{:bulb:} Tap a show below, or type its number (e.g. ${firstN})`,
    showLine: (n, title, count, completed) =>
      `${n}. ${title}\n      ${completed ? "{:ok:} Completed" : "{:fire:} Ongoing"} · ${count} episodes`,
    allShows: (kind, total) => `{:${KIND_ICON[kind]}:} ${KIND_NAME[kind].en} — all shows (${total})\n${SEP}`,
    allShowsHint: "{:bulb:} Type a show's number to open it (e.g. 5)",
    viewAll: "📋 View all shows",
    viewAllEps: "📋 View all episodes",
    epHint: (first) => `{:bulb:} Type the EP you want to buy, e.g. ${first}`,
    allEps: (title, count) => `{:video:} ${title} — all episodes (${count})\n${SEP}\n{:ok:} = bought   {:lock:} = not bought`,
    noSuchShow: (n, total) => `{:warn:} No show number ${n} — numbers go from 1 to ${total}.`,
    epScreen: ({ title, count, completed, credits, balance, from, to, owned, example, rangeExample }) =>
      `{:video:} ${title}\n${SEP}\n` +
      `${completed ? "{:ok:} Completed" : "{:fire:} Ongoing"} · ${count} episodes\n` +
      `{:ticket:} EP ${from} to EP ${to}\n` +
      `{:credit:} 1 episode = ${credits} Credit ($${(credits * DEFAULT_PRICE_USD).toFixed(2)})\n` +
      `{:m_account:} Your Credit: ${balance}\n` +
      (owned ? `{:ok:} Bought: ${owned}\n` : "") +
      `${SEP}\n{:bulb:} Type the EP you want to buy in the chat, e.g. ${example}${rangeExample ? ` or ${rangeExample}` : ""}`,
    notFound: (want, from, to) => `{:warn:} No EP ${want} — this show has EP ${from} to EP ${to}.`,
    tooMany: (max) => `{:warn:} At most ${max} episodes at a time.`,
    noEpisodes: (title) => `{:video:} ${title}\n\n{:warn:} No episodes on sale yet.`,
    needMore: (need, have) => `{:warn:} Not enough Credit — need ${need}, you have ${have}.\n\n{:credit:} Add Watch Credit below:`,
    needMoreToast: "Not enough Credit — please top up",
    delivering: (label) => `⏳ Sending EP ${label}…`,
    delivered: (title, label) => `{:video:} ${title}\n{:ticket:} EP ${label}`,
    deliverFailed: "{:fail:} Could not send that video (no Credit was taken). Please contact the operator.",
    topUpTitle: (credits) =>
      `{:credit:} Add Watch Credit\n\n` +
      `{:credit:} Current Credit: ${credits}\n` +
      `{:ticket:} 1 Credit = 1 episode\n\n` +
      `{:bulb:} Pick a pack, then pay with KHQR:`,
    granted: (n, left) => `{:party:} Payment confirmed! +${n} Watch Credit\n{:credit:} Watch Credit left: ${left}\n\n{:video:} Open Khmer-dubbed Shows to buy episodes.`,
    back: "⬅️ Back",
    mainMenu: "⬅️ Main menu",
    topUp: "💲 Add Credit to buy episodes",
    dlCredit: "📥 Add Credit for Private Downloads",
    prevPage: "◀️ Previous",
    nextPage: "▶️ Next",
    manage: "🙈 Hide shows (Admin)",
    manageDone: "✅ Done",
    manageHint: "\n\n{:warn:} Admin: tap a show to hide it.",
    posterBtn: "🖼 Set poster (Admin)",
    posterAsk: (title) => `{:camera:} Send the poster for “${title}” now (as a photo, not a file).`,
    hidden: "🙈 Show hidden",
    epUnit: "EP",
  },
};
const tx = (language) => L[language] ?? L.km;

// Small pages keep the list on one phone screen and far under Telegram's
// reply markup size limit however big the catalog gets.
const SHOWS_PER_PAGE = 3; // three shows at a time, then ▶️ for the next

const pad = (n) => String(n).padStart(2, "0");
const isAdmin = (chatId) => Boolean(config.telegramAdminChatId) && String(chatId) === String(config.telegramAdminChatId);

// ------------------------------------------------------------ screens

/**
 * Draws one screen. From a button tap it edits the tapped message in place
 * (text to text, photo to photo), so paging and going back never make the
 * list jump or disappear; only when the kind of message changes (a text
 * list to a show's poster, say) is the old one deleted and a new one sent.
 */
async function render(chatId, cq, { photo = null, text, keyboard }) {
  const reply_markup = { inline_keyboard: keyboard };
  if (photo && text.length > 1024) photo = null; // Telegram's photo caption limit
  const msg = cq?.message;
  if (msg) {
    const isPhoto = Boolean(msg.photo?.length);
    let res = null;
    if (photo && isPhoto) {
      res = await call("editMessageMedia", {
        chat_id: chatId,
        message_id: msg.message_id,
        media: { type: "photo", media: photo, caption: text },
        reply_markup,
      });
    } else if (!photo && !isPhoto) {
      res = await call("editMessageText", { chat_id: chatId, message_id: msg.message_id, text, reply_markup });
    }
    if (res?.ok || /not modified/i.test(String(res?.description ?? ""))) return msg.message_id;
    await clearScreen(cq);
  }
  if (photo) {
    const sent = await call("sendPhoto", { chat_id: chatId, photo, caption: text, reply_markup });
    if (sent?.ok) return sent.result?.message_id;
  }
  const sent = await call("sendMessage", { chat_id: chatId, text, reply_markup });
  return sent?.result?.message_id;
}

/** Removes the button screen that was tapped. */
async function clearScreen(cq) {
  const chatId = cq?.message?.chat?.id;
  const messageId = cq?.message?.message_id;
  if (!chatId || !messageId) return;
  await call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});
}

// A forum's built-in "General" topic and topics with no videos aren't shows.
// A topic named only by a number or code ("1", "5", "S5", "EP 3") is a
// season/sub-thread, not a show: a show's title starts with its name.
const isShowTopic = (topic) => {
  const title = String(topic.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (/^general$/i.test(title) || (topic.total_episodes ?? 0) <= 0) return false;
  if (!/^\p{L}/u.test(title)) return false; // starts with a digit
  return (title.match(/\p{L}/gu) ?? []).length >= 3 && !/^(s|ep|e|season|part|vol)\s*\d+$/i.test(title);
};

async function showsInKind(kind) {
  const meta = await showMeta();
  const topicIds = Object.entries(meta)
    .filter(([, m]) => m.kind === kind && m.on_sale !== false)
    .map(([id]) => id);
  if (!topicIds.length) return [];
  const topics = rows(await db().from("topics").select("id, title, total_episodes").in("id", topicIds));
  return topics
    .filter(isShowTopic)
    .map((topic) => ({ topic, meta: meta[topic.id] }))
    .sort((a, b) => a.topic.title.localeCompare(b.topic.title));
}

/** The genre picker -- the section's home screen. */
export async function showGenres(chatId, user, cq = null) {
  const t = tx(user?.language);
  const w = await walletFor(user?.telegram_user_id);
  // The home screen's own actions live on the bottom keyboard now (like
  // "the buttons below" the operator asked for), not as inline chat
  // buttons -- so entering it always clears whatever inline screen was
  // open (a show or kind list) and sends a fresh message.
  if (cq) await clearScreen(cq);
  await call("sendMessage", {
    chat_id: chatId,
    text: t.home(w.credits ?? 0),
    reply_markup: sectionKeyboard(user?.language),
  });
}

/** The keyboard under the message box while browsing "រឿងនិយាយខ្មែរ". */
function sectionKeyboard(language) {
  const t = tx(language);
  return {
    keyboard: [
      ...SHOWN_KINDS.map((kind) => [
        { text: `${KIND_EMOJI[kind]} ${KIND_NAME[kind][language] ?? KIND_NAME[kind].km}`, emoji: KIND_ICON[kind], style: "primary" },
      ]),
      [{ text: t.topUp, emoji: "credit", style: "success" }],
      [{ text: t.dlCredit, emoji: "dl" }],
      [{ text: t.mainMenu, emoji: "inv_back" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// Section buttons arrive as plain text (the reply keyboard above), in
// either language; a logo icon drops a label's own leading emoji
// (customEmoji.js), so a tap may arrive either way.
const SECTION_ACTIONS = new Map();
const bareLabel = (label) => label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");
/** Matches a tapped reply-keyboard button against a known label, either way. */
const hits = (trimmed, bare, label) => trimmed === label || bare === bareLabel(label);
for (const language of ["km", "en"]) {
  const t = tx(language);
  const items = [
    ...SHOWN_KINDS.map((kind) => [`${KIND_EMOJI[kind]} ${KIND_NAME[kind][language] ?? KIND_NAME[kind].km}`, `kind:${kind}`]),
    [t.topUp, "topup"],
    [t.dlCredit, "dlcredit"],
    [t.mainMenu, "exit"],
  ];
  for (const [label, action] of items) {
    SECTION_ACTIONS.set(label, action);
    SECTION_ACTIONS.set(bareLabel(label), action);
  }
}

/**
 * A tap on the section's keyboard (a genre, Add Credit, or Back). Returns
 * true when handled here, "dlcredit" when the caller should open the
 * Credit-for-downloads packages instead (botPay already imports this
 * module for grant(), so that one case is left to the caller rather than
 * import botPay back and create a cycle).
 */
export async function handleSectionButton(chatId, user, text) {
  const action = SECTION_ACTIONS.get(String(text ?? "").trim());
  if (!action) return false;
  viewing.delete(String(chatId)); // leaving whatever show was open, if any
  if (action === "dlcredit") return "dlcredit";
  if (action === "topup") {
    await showTopUps(chatId, user);
    return true;
  }
  if (action === "exit") {
    await call("sendMessage", {
      chat_id: chatId,
      text: user.language === "en" ? "{:inv_back:} Main menu" : "{:inv_back:} ម៉ឺនុយដើម",
      reply_markup: mainKeyboard(user.language),
    });
    return true;
  }
  return showKindList(chatId, user, action.slice(5)).then(() => true);
}

// Show lists are drawn on the bottom keyboard, not as chat buttons -- a
// reply-keyboard button carries only its label text (no id), so a tap is
// matched back against this page recomputed fresh from the same data.
const listSessions = new Map();

/** A show's button label: its number in the whole list and its title. */
function showLabel(n, title, manage) {
  return `${manage ? "🙈" : "🎬"} ${n}. ${title}`;
}

async function showKindList(chatId, user, kind, page = 0, manage = false) {
  const t = tx(user.language);
  if (!KINDS.includes(kind)) return showGenres(chatId, user);
  const all = await showsInKind(kind);
  if (!all.length) {
    listSessions.delete(String(chatId));
    await call("sendMessage", {
      chat_id: chatId,
      text: t.noShows(kind),
      reply_markup: { keyboard: [[{ text: t.back, emoji: "inv_back" }]], resize_keyboard: true },
    });
    return;
  }

  const pages = Math.ceil(all.length / SHOWS_PER_PAGE);
  page = Math.min(Math.max(page, 0), pages - 1);
  // Manage mode (operator only): the same list, but a tap hides the show --
  // for topics that aren't really shows (a season sub-topic, a chat thread).
  manage = manage && isAdmin(chatId);
  const start = page * SHOWS_PER_PAGE;
  const list = all.slice(start, start + SHOWS_PER_PAGE);
  // Numbers run across the whole list (not per page), so "type 5" and
  // "View all" agree with what the buttons say.
  const keyboard = list.map((entry, i) => [
    manage
      ? { text: showLabel(start + i + 1, entry.topic.title, true), style: "danger" }
      : { text: showLabel(start + i + 1, entry.topic.title, false), emoji: entry.meta.poster_emoji || KIND_ICON[kind], style: "primary" },
  ]);
  const nav = [];
  if (page > 0) nav.push({ text: t.prevPage, emoji: "inv_back" });
  if (start + SHOWS_PER_PAGE < all.length) nav.push({ text: t.nextPage, emoji: "inv_summary" });
  if (nav.length) keyboard.push(nav);
  if (all.length > SHOWS_PER_PAGE) keyboard.push([{ text: t.viewAll, emoji: "inv_summary" }]);
  if (isAdmin(chatId)) keyboard.push([manage ? { text: t.manageDone, emoji: "ok", style: "success" } : { text: t.manage }]);
  keyboard.push([{ text: t.back, emoji: "inv_back" }]);

  const lines = list.map((entry, i) =>
    t.showLine(start + i + 1, entry.topic.title, entry.topic.total_episodes, entry.meta.status === "completed")
  );
  listSessions.set(String(chatId), { kind, page, manage });
  await call("sendMessage", {
    chat_id: chatId,
    text: t.showList(kind, all.length, page + 1, pages, lines, start + 1) + (manage ? t.manageHint : ""),
    reply_markup: { keyboard, resize_keyboard: true, is_persistent: true },
  });
}

/** Every show of the genre as one numbered list (split to fit a message). */
async function showAllShows(chatId, user, kind) {
  const t = tx(user.language);
  const all = await showsInKind(kind);
  const lines = all.map((entry, i) =>
    `${i + 1}. ${entry.topic.title} · ${entry.topic.total_episodes} ${t.epUnit}${entry.meta.status === "completed" ? " ✅" : ""}`
  );
  await sendChunks(chatId, t.allShows(kind, all.length), lines, t.allShowsHint);
}

/** Sends a header + lines + footer, split under Telegram's 4096-char limit. */
async function sendChunks(chatId, header, lines, footer) {
  const LIMIT = 3500;
  let chunk = header;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > LIMIT) {
      await call("sendMessage", { chat_id: chatId, text: chunk });
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  chunk += `\n${SEP}\n${footer}`;
  await call("sendMessage", { chat_id: chatId, text: chunk });
}

/**
 * A tap while a show list is open (a show, a page arrow, View all, the hide
 * toggle, back) or a show's number typed in. Returns true when handled.
 */
export async function handleListButton(chatId, user, text) {
  const session = listSessions.get(String(chatId));
  if (!session) return false;
  const t = tx(user.language);
  const trimmed = String(text ?? "").trim();
  const bare = bareLabel(trimmed);
  const is = (label) => hits(trimmed, bare, label);

  if (is(t.back)) {
    listSessions.delete(String(chatId));
    await showGenres(chatId, user);
    return true;
  }
  if (is(t.prevPage)) return showKindList(chatId, user, session.kind, session.page - 1, session.manage).then(() => true);
  if (is(t.nextPage)) return showKindList(chatId, user, session.kind, session.page + 1, session.manage).then(() => true);
  if (is(t.viewAll)) return showAllShows(chatId, user, session.kind).then(() => true);
  if (isAdmin(chatId) && is(t.manage)) return showKindList(chatId, user, session.kind, session.page, true).then(() => true);
  if (isAdmin(chatId) && is(t.manageDone)) return showKindList(chatId, user, session.kind, session.page, false).then(() => true);

  // A show's button ("🎬 5. Title") or just its number typed in ("5", "៥").
  const digits = bare.replace(/[\u17E0-\u17E9]/g, (d) => String(d.charCodeAt(0) - 0x17e0));
  const m = /^(\d{1,4})(?:\.\s|$)/.exec(digits);
  if (!m) return false;
  const all = await showsInKind(session.kind);
  const n = Number(m[1]);
  const entry = all[n - 1];
  if (!entry) {
    await call("sendMessage", { chat_id: chatId, text: t.noSuchShow(n, all.length) });
    return true;
  }
  const page = Math.floor((n - 1) / SHOWS_PER_PAGE);
  if (session.manage && isAdmin(chatId)) {
    const saved = await saveShowMeta(entry.topic.id, { on_sale: false });
    await call("sendMessage", { chat_id: chatId, text: t.hidden });
    await showKindList(chatId, user, saved.kind, session.page, true);
  } else {
    listSessions.delete(String(chatId));
    await showEpisodeList(chatId, user, entry.topic.id, page);
  }
  return true;
}

/** A show's episodes, numbered and in order, whatever the scan stored. */
async function orderedEpisodes(topicId) {
  const list = await fetchAll(() =>
    db().from("episodes").select("id, ep_number, title, file_name, message_id").eq("topic_id", topicId).order("id")
  );
  const numbered = list.map((ep) => ({ ...ep, num: ep.ep_number ?? parseEpNumber(ep.title, ep.file_name) }));
  numbered.sort(
    (a, b) => (a.num ?? Infinity) - (b.num ?? Infinity) || Number(a.message_id ?? 0) - Number(b.message_id ?? 0)
  );
  return numbered.map((ep, i) => ({ ...ep, label: ep.num != null ? pad(ep.num) : `#${i + 1}` }));
}

/** Every EP of a show, bought ones marked, 5 to a line. */
async function showAllEpisodes(chatId, user, topicId) {
  const t = tx(user.language);
  const [topic] = rows(await db().from("topics").select("title").eq("id", topicId).limit(1));
  const episodes = await orderedEpisodes(topicId);
  const w = await walletFor(user.telegram_user_id);
  const cells = episodes.map((ep) => `${w.bought?.[ep.id] ? "✅" : "🔒"} ${ep.label}`);
  const lines = [];
  for (let i = 0; i < cells.length; i += 5) lines.push(cells.slice(i, i + 5).join("   "));
  const first = (episodes[0]?.label ?? "1").replace(/^#/, "");
  await sendChunks(chatId, t.allEps(topic?.title ?? "", episodes.length), lines, t.epHint(first));
}

// The show a chat is looking at, so a number typed next ("190", "EP 190",
// "190-192") buys that episode. In memory: after a restart the person just
// opens the show again.
const viewing = new Map();
const VIEW_MS = 30 * 60 * 1000;
const MAX_AT_ONCE = 5;

/** Forgets the open show (another menu section was opened). */
export function cancelPending(chatId) {
  viewing.delete(String(chatId));
}

/**
 * A show: its poster, EP range, price and balance -- no grid of episode
 * buttons; the buyer types the EP they want (see handleText).
 */
async function showEpisodeList(chatId, user, topicId, listPage = 0) {
  const t = tx(user.language);
  const [topic] = rows(await db().from("topics").select("id, title").eq("id", topicId).limit(1));
  if (!topic) return showGenres(chatId, user);
  const meta = (await showMeta())[topicId] ?? {};
  const backRow = [{ text: t.back, emoji: "inv_back" }];
  const episodes = await orderedEpisodes(topicId);
  if (!episodes.length) {
    viewing.delete(String(chatId));
    await call("sendMessage", {
      chat_id: chatId,
      text: t.noEpisodes(topic.title),
      reply_markup: { keyboard: [backRow], resize_keyboard: true },
    });
    return;
  }

  const w = await walletFor(user.telegram_user_id);
  const numbered = episodes.filter((ep) => ep.num != null);
  const first = (numbered[0] ?? episodes[0]).label;
  const last = (numbered[numbered.length - 1] ?? episodes[episodes.length - 1]).label;
  const ownedLabels = episodes.filter((ep) => w.bought?.[ep.id]).map((ep) => ep.label);
  const owned = ownedLabels.length > 12 ? `${ownedLabels.slice(0, 12).join(", ")} … (+${ownedLabels.length - 12})` : ownedLabels.join(", ");
  // What to actually TYPE to buy: real EP numbers when the source had them,
  // else the show's own 1..N order (its label reads "#3", but a "#" doesn't
  // parse as a number -- typing that exact hint used to buy nothing).
  const toType = (label) => label.replace(/^#/, "");

  const keyboard = [
    [{ text: t.viewAllEps, emoji: "inv_summary", style: "primary" }],
    [{ text: t.topUp, emoji: "credit", style: "success" }],
  ];
  if (isAdmin(chatId)) keyboard.push([{ text: t.posterBtn, emoji: "camera" }]);
  keyboard.push(backRow);
  const text = t.epScreen({
    title: topic.title,
    count: episodes.length,
    completed: meta.status === "completed",
    credits: meta.ep_credits ?? 1,
    balance: w.credits ?? 0,
    from: first,
    to: last,
    owned,
    example: toType(first),
    rangeExample: numbered.length > 2 ? `${toType(numbered[0].label)}-${toType(numbered[2].label)}` : null,
  });
  const reply_markup = { keyboard, resize_keyboard: true, is_persistent: true };
  let messageId;
  if (meta.poster_file_id && text.length <= 1024) {
    const sent = await call("sendPhoto", { chat_id: chatId, photo: meta.poster_file_id, caption: text, reply_markup });
    messageId = sent?.result?.message_id;
  }
  if (!messageId) {
    const sent = await call("sendMessage", { chat_id: chatId, text, reply_markup });
    messageId = sent?.result?.message_id;
  }
  viewing.set(String(chatId), { topicId, kind: meta.kind, listPage, messageId, at: Date.now() });
}

/**
 * Text typed while a show is open: its own keyboard buttons (Back, Add
 * Credit, Set poster), or an EP number/range to buy. Returns true when
 * handled, false to let the rest of the bot see it.
 */
export async function handleText(chatId, user, text) {
  const open = viewing.get(String(chatId));
  if (!open || Date.now() - open.at > VIEW_MS) return false;
  const t = tx(user.language);
  const trimmed = String(text ?? "").trim();
  const bare = bareLabel(trimmed);

  if (hits(trimmed, bare, t.back)) {
    viewing.delete(String(chatId));
    await showKindList(chatId, user, open.kind, open.listPage);
    return true;
  }
  if (hits(trimmed, bare, t.topUp)) {
    await showTopUps(chatId, user);
    return true;
  }
  if (hits(trimmed, bare, t.viewAllEps)) {
    await showAllEpisodes(chatId, user, open.topicId);
    return true;
  }
  if (isAdmin(chatId) && hits(trimmed, bare, t.posterBtn)) {
    const [topic] = rows(await db().from("topics").select("title").eq("id", open.topicId).limit(1));
    pendingPoster.set(String(chatId), open.topicId);
    await call("sendMessage", { chat_id: chatId, text: t.posterAsk(topic?.title ?? "") });
    return true;
  }

  // "#" too -- the hint text and a show's own EP label both show one
  // ("#3" for a show whose source never numbered its episodes at all).
  const src = trimmed.replace(/[០-៩]/g, (d) => String(d.charCodeAt(0) - 0x17e0));
  const m = /^(?:ep\s*)?#?\s*0*(\d{1,4})(?:\s*(?:-|–|ដល់|to)\s*(?:ep\s*)?#?\s*0*(\d{1,4}))?$/i.exec(src);
  if (!m) return false;
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  const episodes = await orderedEpisodes(open.topicId);
  const numbered = episodes.filter((ep) => ep.num != null);
  // A show whose source never had recognizable EP numbers ("#1", "#2", …)
  // is bought by its position in the list instead -- otherwise nothing
  // typed could ever match and every episode was silently unbuyable.
  const wanted = numbered.length
    ? numbered.filter((ep) => ep.num >= Math.min(lo, hi) && ep.num <= Math.max(lo, hi))
    : episodes.slice(Math.max(0, Math.min(lo, hi) - 1), Math.max(lo, hi));
  // Only one copy per number (a re-upload of the same EP is still one EP).
  const seen = new Set();
  const picks = wanted.filter((ep) => !seen.has(ep.id) && seen.add(ep.id));
  if (!picks.length) {
    const from = (numbered[0] ?? episodes[0])?.label ?? "?";
    const to = (numbered[numbered.length - 1] ?? episodes[episodes.length - 1])?.label ?? "?";
    await call("sendMessage", { chat_id: chatId, text: t.notFound(m[2] ? `${m[1]}-${m[2]}` : m[1], from, to) });
    return true;
  }
  if (picks.length > MAX_AT_ONCE) {
    await call("sendMessage", { chat_id: chatId, text: t.tooMany(MAX_AT_ONCE) });
    return true;
  }
  let sent = 0;
  for (const ep of picks) {
    const r = await purchase(chatId, user, ep.id, ep.label);
    if (r === "ok") sent += 1;
    if (r === "no-credit") break;
  }
  // The show screen moves under the new video(s), balance updated.
  if (sent) {
    if (open.messageId) await call("deleteMessage", { chat_id: chatId, message_id: open.messageId }).catch(() => {});
    await showEpisodeList(chatId, user, open.topicId, open.listPage);
  }
  return true;
}

/** Charges (unless already bought) and delivers one episode. */
async function purchase(chatId, user, episodeId, label) {
  const t = tx(user.language);
  const [episode] = rows(
    await db().from("episodes").select("id, topic_id").eq("id", episodeId).limit(1)
  );
  if (!episode) return "missing";
  const meta = (await showMeta())[episode.topic_id] ?? {};
  const [topic] = rows(await db().from("topics").select("title").eq("id", episode.topic_id).limit(1));
  const credits = meta.ep_credits ?? 1;
  const w = await walletFor(user.telegram_user_id);
  const already = Boolean(w.bought?.[episodeId]);

  if (!already && (w.credits ?? 0) < credits) {
    await showTopUps(chatId, user, null, t.needMore(credits, w.credits ?? 0));
    return "no-credit";
  }
  if (!already) {
    await saveWallet(user.telegram_user_id, {
      ...w,
      credits: w.credits - credits,
      bought: { ...w.bought, [episodeId]: true },
    });
  }
  await call("sendChatAction", { chat_id: chatId, action: "upload_video" }).catch(() => {});

  const caption = t.delivered(topic?.title ?? "", label);
  // Only ever forward the real source message: it's fetched by this
  // episode's own group + message_id, so it can never be the wrong show.
  // r2_key used to be tried as a fallback, but this schema is shared with
  // an unrelated mirror-dashboard product -- a row's r2_key can be a
  // leftover from that pipeline and point at completely different content
  // (a customer was once delivered another show's video this way). Wrong
  // content is worse than none, so a failed forward is now a refund, never
  // a guess.
  const delivered = await botDeliver.deliverEpisode({ userChatId: chatId, episodeId: episode.id, caption });
  if (!delivered.ok) {
    console.error(`Watch delivery failed for episode ${episode.id}: ${delivered.reason ?? "?"} ${delivered.error ?? ""}`);
    if (!already) {
      const fresh = await walletFor(user.telegram_user_id);
      const bought = { ...fresh.bought };
      delete bought[episodeId];
      await saveWallet(user.telegram_user_id, { ...fresh, credits: (fresh.credits ?? 0) + credits, bought });
    }
    // The detailed reason used to only ever reach a *separate* admin chat --
    // when the person hitting the failure IS the admin (testing their own
    // bot, say), that message was skipped as redundant and they were left
    // with only the generic "contact the operator" text, unable to contact
    // anyone more informed than themselves. Now the admin gets the reason
    // inline instead.
    const detail = `${delivered.reason ?? "?"}${delivered.error ? ` -- ${delivered.error}` : ""}`;
    const isAdminChat = Boolean(config.telegramAdminChatId) && String(config.telegramAdminChatId) === String(chatId);
    await call("sendMessage", { chat_id: chatId, text: isAdminChat ? `${t.deliverFailed}\n\n🔧 ${detail}` : t.deliverFailed });
    if (config.telegramAdminChatId && !isAdminChat) {
      await call("sendMessage", {
        chat_id: config.telegramAdminChatId,
        text: `⚠️ Watch delivery failed\nShow: ${topic?.title ?? episode.topic_id}\nEP: ${label}\nEpisode id: ${episode.id}\nReason: ${detail}`,
      }).catch(() => {});
    }
    return "failed";
  }
  return "ok";
}

async function showTopUps(chatId, user, cq = null, lead = null) {
  const t = tx(user?.language);
  const w = await walletFor(user?.telegram_user_id);
  const list = rows(await db().from("bot_packages").select("*").like("id", `${WATCH_PACKAGE_PREFIX}%`).eq("active", true).order("sort"));
  const keyboard = list.map((pkg) => [
    { text: user?.language === "en" ? pkg.title_en : pkg.title_km, emoji: "credit", style: "success", callback_data: `bot:buy:${pkg.id}` },
  ]);
  keyboard.push([{ text: t.back, emoji: "inv_back", callback_data: "watch:home" }]);
  await render(chatId, cq, { text: lead ?? t.topUpTitle(w.credits ?? 0), keyboard });
}

/** botPay.grant() calls this once a watch_* order is paid. */
export async function grantedText(language, credits, user) {
  const left = await grantTopUp(user.telegram_user_id, credits);
  return tx(language).granted(credits, left);
}

/** `watch:...` callback data. Returns true when it handled the tap. */
export async function handleCallback(cq, user) {
  const data = String(cq?.data ?? "");
  if (!data.startsWith("watch:")) return false;
  const chatId = cq.message?.chat?.id;
  if (!chatId) return true;
  const [, action, a, b, c] = data.split(":");
  const num = (v) => Number(v) || 0;

  if (action === "ep") {
    // An EP button from an older screen still in someone's chat.
    await call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    const [ep] = rows(await db().from("episodes").select("topic_id").eq("id", a).limit(1));
    if (!ep) return true;
    const label = (await orderedEpisodes(ep.topic_id)).find((x) => x.id === a)?.label ?? "";
    await purchase(chatId, user, a, label);
    await showEpisodeList(chatId, user, ep.topic_id, num(c));
    return true;
  }
  if (action === "hide" && isAdmin(chatId)) {
    const saved = await saveShowMeta(a, { on_sale: false });
    await call("answerCallbackQuery", { callback_query_id: cq.id, text: tx(user.language).hidden });
    await clearScreen(cq);
    await showKindList(chatId, user, saved.kind, num(b), true);
    return true;
  }
  if (action === "poster" && isAdmin(chatId)) {
    const [topic] = rows(await db().from("topics").select("title").eq("id", a).limit(1));
    pendingPoster.set(String(chatId), a);
    await call("answerCallbackQuery", { callback_query_id: cq.id });
    await call("sendMessage", { chat_id: chatId, text: tx(user.language).posterAsk(topic?.title ?? "") });
    return true;
  }
  await call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  if (action === "home") await showGenres(chatId, user, cq);
  else if (action === "topup") await showTopUps(chatId, user, cq);
  else if (action === "kind") {
    await clearScreen(cq);
    await showKindList(chatId, user, a, num(b), c === "m");
  } else if (action === "show") {
    await clearScreen(cq);
    await showEpisodeList(chatId, user, a, num(c));
  } else if (action === "exit") {
    await clearScreen(cq);
    await call("sendMessage", {
      chat_id: chatId,
      text: user.language === "en" ? "{:inv_back:} Main menu" : "{:inv_back:} ម៉ឺនុយដើម",
      reply_markup: mainKeyboard(user.language),
    });
  }
  return true;
}

// ------------------------------------------------------------ admin tooling

// The show whose poster the operator was just asked for (🖼 button), so the
// next photo they send becomes it -- no /setshow and topic id to copy.
const pendingPoster = new Map();

/** The show waiting for a poster in this chat, cleared as it's read. */
export function takePendingPoster(chatId) {
  const topicId = pendingPoster.get(String(chatId)) ?? null;
  pendingPoster.delete(String(chatId));
  return topicId;
}

/** Sets a show's poster (photo + custom emoji), keeping its other settings. */
export async function setPoster(topicId, posterBuffer, posterFileId) {
  const meta = (await showMeta())[topicId] ?? {};
  return setShow(topicId, meta.kind ?? "donghua", meta.status, meta.ep_credits, posterBuffer, posterFileId);
}

/**
 * Registers (or re-scans) a VIP source group by chat id, and lists its
 * topics with a #index for /setshow to reference. One-time setup per group.
 */
export async function addOrScanGroup(chatId) {
  // A -100… id, an @username, or any message link copied out of the group
  // (t.me/c/…/…) all name the same chat; store the plain id so the group
  // isn't registered twice under two spellings.
  const id = String(parseTelegramLink(chatId).chatId);
  let [group] = rows(await db().from("groups").select("*").eq("chat_id", id).limit(1));
  if (!group) {
    [group] = rows(await db().from("groups").insert({ chat_id: id, title: id }).select("*"));
  }
  const result = await scanGroup(group.id);
  const topics = rows(await db().from("topics").select("id, title, total_episodes").eq("group_id", group.id).order("title"));
  const lines = topics.map((topic, i) => `${i + 1}. ${topic.title} (${topic.total_episodes} ep) — ${topic.id}`);
  return (
    `✅ Scanned: ${result.new_episodes} new episode(s), ${result.topics} topic(s).\n\n` +
    (lines.length ? lines.join("\n") : "No topics found (is it a forum group?).")
  );
}

/**
 * /setshow <topic id> <anime|donghua|movie> [ongoing|completed] [credits]
 * A poster attached to the same command (photo, or forwarded from anywhere)
 * is converted into a custom emoji and stored on the show.
 */
export async function setShow(topicId, kind, status, credits, posterBuffer, posterFileId) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const patch = { kind, on_sale: true }; // re-shows a show hidden with 🙈
  if (status) patch.status = status;
  if (credits) patch.ep_credits = Math.max(1, Math.round(Number(credits)));
  if (posterBuffer) {
    // The photo alone is still worth saving if the emoji pack refuses it.
    patch.poster_emoji = await customEmoji.addPosterEmoji(posterBuffer).catch((err) => {
      console.error("Poster emoji failed:", err?.message ?? err);
      return undefined;
    });
    if (!patch.poster_emoji) delete patch.poster_emoji;
    // The original photo's own file_id, reused as-is (no re-upload) to show
    // the real poster above a show's episode list -- Telegram keeps a
    // photo's file_id valid indefinitely once it's been sent once.
    if (posterFileId) patch.poster_file_id = posterFileId;
  }
  const saved = await saveShowMeta(topicId, patch);
  return `✅ Show set: kind=${saved.kind} status=${saved.status} ep_credits=${saved.ep_credits}${posterBuffer ? " (poster emoji + photo added)" : ""}`;
}

/**
 * Merges two topics that are really the same show (Telegram split it across
 * two threads -- a re-upload, a continued season, whatever the reason):
 * every episode of `dropId` moves under `keepId`, keep's total_episodes
 * absorbs drop's, and drop is hidden from listings (🙈, the same on_sale
 * flag the admin "hide show" button uses) rather than deleted, so nothing
 * about it is lost if this turns out to be the wrong call.
 */
export async function mergeTopic(keepId, dropId) {
  if (keepId === dropId) throw new Error("that's the same topic twice");
  const [keep] = rows(await db().from("topics").select("id, title, total_episodes").eq("id", keepId).limit(1));
  const [drop] = rows(await db().from("topics").select("id, title, total_episodes").eq("id", dropId).limit(1));
  if (!keep) throw new Error(`no topic ${keepId}`);
  if (!drop) throw new Error(`no topic ${dropId}`);

  await db().from("episodes").update({ topic_id: keepId, updated_at: nowIso() }).eq("topic_id", dropId);
  const combined = (keep.total_episodes ?? 0) + (drop.total_episodes ?? 0);
  await db().from("topics").update({ total_episodes: combined, updated_at: nowIso() }).eq("id", keepId);
  await db().from("topics").update({ total_episodes: 0, updated_at: nowIso() }).eq("id", dropId);
  await saveShowMeta(dropId, { on_sale: false });

  return `✅ Merged "${drop.title}" (${drop.total_episodes ?? 0} ep) into "${keep.title}" -- now ${combined} ep total. "${drop.title}" is hidden (🙈), not deleted.`;
}

/** /shows -- topic index for /setshow, across every registered group. */
export async function listAllTopics() {
  const topics = await fetchAll(() => db().from("topics").select("id, title, total_episodes").order("title"));
  const meta = await showMeta();
  if (!topics.length) return "No topics yet. Use /watchgroup <chat id> first.";
  return topics
    .map((topic) => {
      const m = meta[topic.id];
      const tag = m ? `[${m.kind}/${m.status}/${m.ep_credits}cr${m.on_sale === false ? "/hidden" : ""}]` : "[unset]";
      return `${topic.title} (${topic.total_episodes} ep) ${tag}\n${topic.id}`;
    })
    .join("\n\n");
}

/** What /watchgroup and /setshow say when sent without (valid) arguments. */
export const ADMIN_HELP =
  "🎬 ការរៀបចំផ្នែក រឿងនិយាយខ្មែរ (Admin)\n\n" +
  "1️⃣ /watchgroup <link ឬ chat id>\n" +
  "   ចុចសង្កត់សារណាមួយក្នុង Group VIP → Copy Link → ផ្ញើ៖\n" +
  "   /watchgroup https://t.me/c/1234567890/55\n" +
  "   (ឬ /watchgroup -1001234567890)\n" +
  "   Bot នឹង scan Topic និង EP ទាំងអស់ដោយស្វ័យប្រវត្តិ។\n" +
  "   ⚠️ គណនី userbot ត្រូវតែជាសមាជិក Group នោះ ហើយ Group ត្រូវបើក Topics។\n\n" +
  "2️⃣ /setgroup <link ឬ chat id> <anime|donghua|movie> [ongoing|completed] [credit]\n" +
  "   ដាក់លក់រឿងទាំងអស់ក្នុង Group ក្នុងពេលតែមួយ ឧ. /setgroup -1004468850700 donghua\n\n" +
  "   /shows — បង្ហាញរឿង (Topic) ទាំងអស់ ជាមួយ id របស់វា\n\n" +
  "3️⃣ /setshow <topic id> <anime|donghua|movie> [ongoing|completed] [credit]\n" +
  "   ផ្ញើជា caption លើរូប poster (forward ពី @AnimetioMini_bot ក៏បាន)\n" +
  "   → poster ក្លាយជា emoji របស់រឿងនោះ\n" +
  "   ឧ. /setshow 9f2c…e1 anime ongoing\n\n" +
  "4️⃣ រឿងដែលមិនមែនជារឿង (Topic ជជែក, វគ្គរង…) ចុច 🙈 ក្បែររឿងនោះក្នុងបញ្ជីរឿង ដើម្បីលាក់\n" +
  "   (ឃើញតែក្នុងឆាតអ្នកគ្រប់គ្រង) · /setshow ម្ដងទៀត ដើម្បីបង្ហាញវាវិញ។ Topic «General» និង Topic គ្មានវីដេអូ ត្រូវលាក់ដោយស្វ័យប្រវត្តិ។\n\n" +
  "ចំណាំ៖ ដើម្បីផ្ញើ EP ពី Group ត្រូវកំណត់ storage channel (/setstorage) ជាមុនសិន ហើយគណនី userbot ដែលនៅក្នុង Group VIP ត្រូវនៅក្នុង storage channel ដែរ។";

/**
 * /setgroup <link|chat id> <anime|donghua|movie> [ongoing|completed] [credits]
 * Puts every topic of one registered group on sale at once, keeping any
 * poster a show already has. One write for the whole group.
 */
export async function setGroupKind(chatId, kind, status, credits) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const id = String(parseTelegramLink(chatId).chatId);
  const [group] = rows(await db().from("groups").select("id, title").eq("chat_id", id).limit(1));
  if (!group) throw new Error("Group not registered yet -- send /watchgroup with it first.");
  const topics = await fetchAll(() => db().from("topics").select("id").eq("group_id", group.id).order("id"));
  if (!topics.length) throw new Error("That group has no topics yet -- run /watchgroup on it.");

  const all = await showMeta();
  const next = { ...all };
  for (const topic of topics) {
    next[topic.id] = {
      on_sale: true,
      ep_credits: 1,
      status: "ongoing",
      ...all[topic.id],
      kind,
      ...(status ? { status } : {}),
      ...(credits ? { ep_credits: Math.max(1, Math.round(Number(credits))) } : {}),
    };
  }
  await writeJson(SHOWS_FILE, next);
  return `✅ ${topics.length} រឿងក្នុង «${group.title}» ដាក់លក់ជា ${kind}${status ? ` (${status})` : ""}${credits ? `, ${credits} Credit/EP` : ""}។\nអ្នកប្រើឃើញភ្លាមក្នុង 🎬 រឿងនិយាយខ្មែរ។`;
}
