/**
 * AI Credit: what SaveIt AI (ai.js) spends. Every answer, picture and song
 * costs the operator real money at OpenRouter / ElevenLabs, so each use is
 * paid for in AI Credit:
 *
 *   - everyone gets a few free Credit a day (AI_FREE_DAILY), spent first;
 *   - beyond that, Credit bought with the same KHQR flow as download Credit
 *     (bot_packages rows with the "ai_" prefix, granted by botPay.grant);
 *   - the operator is never charged.
 *
 * What each kind of use costs starts from AI_COSTS ("cheap=1,premium=3,
 * image=5,song=25") but the operator can raise or lower it live from the
 * bot with /setprices, once usage grows past what the env default
 * budgeted for -- no redeploy needed. Balances live in Supabase Storage
 * (bucket "ai-credits") as one JSON file, the same pattern watch.js uses
 * for Watch Credit -- this service has no migration path into the
 * database. Writes are queued in-process so two quick messages can't both
 * read the old balance.
 */
import { config } from "./config.js";
import { db, rows } from "./db.js";
import { call } from "./notifyBot.js";

const BUCKET = "ai-credits";
const FILE = "wallet.json";
const CACHE_MS = 20_000;

export const AI_PACKAGE_PREFIX = "ai_";
export const isAiPackage = (id) => String(id ?? "").startsWith(AI_PACKAGE_PREFIX);

// $1 ≈ 50 Credit at the base tier, a little more per dollar on bigger packs.
const PACKAGES = [
  { id: "ai_1", title_km: "{:sparkle:} 50 AI Credit — $1", title_en: "{:sparkle:} 50 AI Credit — $1", price_usd: 1, downloads: 50, sort: 301 },
  { id: "ai_5", title_km: "{:sparkle:} 275 AI Credit (+25 ឥតគិតថ្លៃ) — $5", title_en: "{:sparkle:} 275 AI Credit (+25 free) — $5", price_usd: 5, downloads: 275, sort: 302 },
  { id: "ai_10", title_km: "{:sparkle:} 600 AI Credit (+100 ឥតគិតថ្លៃ) — $10", title_en: "{:sparkle:} 600 AI Credit (+100 free) — $10", price_usd: 10, downloads: 600, sort: 303 },
];

const DEFAULT_COSTS = { cheap: 1, premium: 3, image: 5, song: 25 };
export const TIERS = Object.keys(DEFAULT_COSTS);

function envCosts() {
  const out = { ...DEFAULT_COSTS };
  for (const pair of String(config.aiCosts ?? "").split(",")) {
    const [k, v] = pair.split("=").map((x) => x?.trim());
    if (k in out && Number.isFinite(Number(v)) && Number(v) >= 0) out[k] = Number(v);
  }
  return out;
}

/** AI_COSTS, with whatever /setprices has overridden on top. */
export async function costs() {
  const overrides = await readPrices().catch((err) => {
    console.error("AI prices read failed, using env defaults:", err?.message ?? err);
    return {};
  });
  return { ...envCosts(), ...overrides };
}

const L = {
  km: {
    balance: (free, paid, freeDaily) =>
      `{:sparkle:} AI Credit\n` +
      `🎁 ឥតគិតថ្លៃថ្ងៃនេះ៖ ${free} / ${freeDaily}\n` +
      `{:credit:} Credit ដែលបានទិញ៖ ${paid}`,
    price: (c) =>
      `\n\n📌 តម្លៃក្នុងមួយដង\n` +
      `• 🚀 Gemini Flash · 🐋 DeepSeek — ${c.cheap} Credit\n` +
      `• 🧠 Claude · ⚡ ChatGPT · 💎 Gemini Pro · 🛰 Grok — ${c.premium} Credit\n` +
      `• 🎨 បង្កើតរូបភាព — ${c.image} Credit\n` +
      `• 🎵 បង្កើតចម្រៀង — ${c.song} Credit`,
    pick: "\n\n{:m_buy:} ជ្រើសរើសកញ្ចប់៖",
    back: "⬅️ ត្រឡប់ទៅ AI",
    granted: (n, left) => `{:party:} ការទូទាត់បានបញ្ជាក់! +${n} AI Credit\n{:sparkle:} AI Credit សរុប៖ ${left}\n\nអរគុណ! ចុច 🤖 SaveIt AI ដើម្បីប្រើបន្ត។`,
  },
  en: {
    balance: (free, paid, freeDaily) =>
      `{:sparkle:} AI Credit\n` +
      `🎁 Free today: ${free} / ${freeDaily}\n` +
      `{:credit:} Bought Credit: ${paid}`,
    price: (c) =>
      `\n\n📌 Cost per use\n` +
      `• 🚀 Gemini Flash · 🐋 DeepSeek — ${c.cheap} Credit\n` +
      `• 🧠 Claude · ⚡ ChatGPT · 💎 Gemini Pro · 🛰 Grok — ${c.premium} Credit\n` +
      `• 🎨 Create image — ${c.image} Credit\n` +
      `• 🎵 Create song — ${c.song} Credit`,
    pick: "\n\n{:m_buy:} Choose a package:",
    back: "⬅️ Back to AI",
    granted: (n, left) => `{:party:} Payment confirmed! +${n} AI Credit\n{:sparkle:} AI Credit now: ${left}\n\nThank you! Tap 🤖 SaveIt AI to keep going.`,
  },
};
const t = (language) => L[language] ?? L.km;

/** Upserts the AI Credit packs, called once at startup like watch.announce(). */
export async function announce() {
  await db()
    .from("bot_packages")
    .upsert(PACKAGES.map((p) => ({ ...p, days: null, active: true })), { onConflict: "id" });
}

// ---------------------------------------------------------------- wallet

let cache = null;
let cachedAt = 0;

async function readAll() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const storage = db().storage.from(BUCKET);
  const { data: blob, error } = await storage.download(FILE);
  let data;
  if (blob && !error) {
    data = JSON.parse(await blob.text()) ?? {};
  } else {
    // Only a file that is really not there yet counts as "no balances" --
    // a passing read error must never be taken as empty and then written
    // back over everyone's Credit.
    const listed = await storage.list("", { search: FILE });
    const missing = listed.error
      ? /bucket not found/i.test(String(listed.error.message ?? listed.error))
      : !(listed.data ?? []).some((f) => f.name === FILE);
    if (!missing && !cache) throw new Error(`Could not read AI Credit: ${error?.message ?? error ?? "unknown"}`);
    data = missing ? {} : cache;
  }
  cache = data;
  cachedAt = Date.now();
  return cache;
}

async function writeAll(data) {
  const storage = db().storage;
  const body = new Blob([JSON.stringify(data)], { type: "application/json" });
  let { error } = await storage.from(BUCKET).upload(FILE, body, { upsert: true, contentType: "application/json" });
  if (error && /bucket not found|not found/i.test(String(error.message ?? error))) {
    await storage.createBucket(BUCKET, { public: false });
    ({ error } = await storage.from(BUCKET).upload(FILE, body, { upsert: true, contentType: "application/json" }));
  }
  if (error) throw new Error(`Could not save AI Credit: ${error.message ?? error}`);
  cache = data;
  cachedAt = Date.now();
}

// Every read-modify-write goes through this chain, one at a time.
let queue = Promise.resolve();
function update(fn) {
  const run = queue.then(async () => {
    const all = await readAll();
    const result = fn(all);
    await writeAll(all);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

// ----------------------------------------------------------------- prices

const PRICE_FILE = "prices.json";
const PRICE_CACHE_MS = 20_000;
let priceCache = null;
let priceCachedAt = 0;

/** The kind -> Credit overrides /setprices has saved, or {} once none are set. */
async function readPrices() {
  if (priceCache && Date.now() - priceCachedAt < PRICE_CACHE_MS) return priceCache;
  const storage = db().storage.from(BUCKET);
  const { data: blob, error } = await storage.download(PRICE_FILE);
  let data;
  if (blob && !error) {
    data = JSON.parse(await blob.text()) ?? {};
  } else {
    // Same rule as the wallet: a file that's genuinely missing is "no
    // overrides yet", but a passing read error must never be taken as
    // "clear every price back to the env default".
    const listed = await storage.list("", { search: PRICE_FILE });
    const missing = listed.error
      ? /bucket not found/i.test(String(listed.error.message ?? listed.error))
      : !(listed.data ?? []).some((f) => f.name === PRICE_FILE);
    if (!missing && !priceCache) throw new Error(`Could not read AI prices: ${error?.message ?? error ?? "unknown"}`);
    data = missing ? {} : priceCache;
  }
  priceCache = data;
  priceCachedAt = Date.now();
  return priceCache;
}

async function writePrices(data) {
  const storage = db().storage;
  const body = new Blob([JSON.stringify(data)], { type: "application/json" });
  let { error } = await storage.from(BUCKET).upload(PRICE_FILE, body, { upsert: true, contentType: "application/json" });
  if (error && /bucket not found|not found/i.test(String(error.message ?? error))) {
    await storage.createBucket(BUCKET, { public: false });
    ({ error } = await storage.from(BUCKET).upload(PRICE_FILE, body, { upsert: true, contentType: "application/json" }));
  }
  if (error) throw new Error(`Could not save AI prices: ${error.message ?? error}`);
  priceCache = data;
  priceCachedAt = Date.now();
}

/** /setprices <kind>=<credit>: sets one tier's price, live, no redeploy. */
export async function setPrice(kind, credit) {
  if (!TIERS.includes(kind)) throw new Error(`Unknown price kind "${kind}" (use ${TIERS.join(", ")})`);
  if (!Number.isFinite(credit) || credit < 0) throw new Error(`Price must be a number ≥ 0, got "${credit}"`);
  const next = { ...(await readPrices()), [kind]: credit };
  await writePrices(next);
}

/** /setprices reset: back to whatever AI_COSTS says. */
export async function resetPrices() {
  await writePrices({});
}

const today = () => new Date().toISOString().slice(0, 10);

/** { free, paid } left right now for one user. */
function standing(entry) {
  const free = entry?.day === today() ? Math.max(config.aiFreeDaily - (entry.freeUsed ?? 0), 0) : config.aiFreeDaily;
  return { free, paid: entry?.credits ?? 0 };
}

export async function balance(userId) {
  return standing((await readAll())[userId]);
}

const isAdmin = (chatId) => Boolean(config.telegramAdminChatId) && String(chatId) === String(config.telegramAdminChatId);

/**
 * Takes `cost` Credit, free first. Returns a receipt to hand to refund()
 * when the use then fails, or null when there isn't enough.
 */
export async function charge(chatId, userId, cost) {
  if (isAdmin(chatId) || cost <= 0) return { free: 0, paid: 0 };
  return update((all) => {
    const entry = all[userId] ?? { credits: 0 };
    if (entry.day !== today()) {
      entry.day = today();
      entry.freeUsed = 0;
    }
    const { free, paid } = standing(entry);
    if (free + paid < cost) return null;
    const fromFree = Math.min(free, cost);
    entry.freeUsed = (entry.freeUsed ?? 0) + fromFree;
    entry.credits = paid - (cost - fromFree);
    all[userId] = entry;
    return { free: fromFree, paid: cost - fromFree };
  });
}

export async function refund(userId, receipt) {
  if (!receipt || (!receipt.free && !receipt.paid)) return;
  await update((all) => {
    const entry = all[userId] ?? { credits: 0 };
    entry.credits = (entry.credits ?? 0) + receipt.paid;
    if (entry.day === today()) entry.freeUsed = Math.max((entry.freeUsed ?? 0) - receipt.free, 0);
    all[userId] = entry;
  });
}

/** Adds bought (or operator-given) Credit; returns the new paid balance. */
export async function grant(userId, credits) {
  return update((all) => {
    const entry = all[userId] ?? { credits: 0 };
    entry.credits = (entry.credits ?? 0) + credits;
    all[userId] = entry;
    return entry.credits;
  });
}

/** botPay.grant() calls this once an ai_* order is paid. */
export async function grantedText(language, credits, user) {
  const left = await grant(user.telegram_user_id, credits);
  return t(language).granted(credits, left);
}

/** The balance, prices and the packs to buy. */
export async function showTopUps(chatId, user) {
  const s = t(user?.language);
  const [{ free, paid }, c] = await Promise.all([balance(user.telegram_user_id), costs()]);
  const list = rows(await db().from("bot_packages").select("*").like("id", `${AI_PACKAGE_PREFIX}%`).eq("active", true).order("sort"));
  const keyboard = list.map((pkg) => [
    { text: user?.language === "en" ? pkg.title_en : pkg.title_km, emoji: "credit", style: "success", callback_data: `bot:buy:${pkg.id}` },
  ]);
  keyboard.push([{ text: s.back, callback_data: "ai:pick" }]);
  return call("sendMessage", {
    chat_id: chatId,
    text: s.balance(free, paid, config.aiFreeDaily) + s.price(c) + s.pick,
    reply_markup: { inline_keyboard: keyboard },
  });
}
