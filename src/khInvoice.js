/**
 * KH Invoice inside the SaveIt bot.
 *
 * KH Invoice is a separate app with its own Supabase project. This module is
 * the bot's side of the link between them:
 *
 *   - it checks Telegram signatures (Mini App initData) for the app, since only
 *     this service holds the bot token -- see POST /api/kh-invoice/verify;
 *   - it calls the app's `telegram-bridge` edge function (shared secret) to
 *     read a shop's numbers, record income/expense, confirm sign-ins and
 *     switch on a paid plan;
 *   - it draws the "{:inv_create:} KH Invoice" screen and its buttons.
 *
 * Payment reuses botPay's KHQR orders: the plans are bot_packages rows with
 * ids "inv_*", and botPay.grant hands those to activatePlan() below.
 */
import crypto from "node:crypto";

import { config } from "./config.js";
import { db, rows } from "./db.js";
import { call } from "./notifyBot.js";
import { progressBar } from "./botText.js";

export const INVOICE_PACKAGE_PREFIX = "inv_";

// Prices must match the edge function's PLANS -- it is the one that decides
// how many months a plan adds; these rows only set what the QR charges.
const PACKAGES = [
  { id: "inv_1m", plan: "1m", title_km: "{:inv_create:} KH Invoice Pro ១ ខែ", title_en: "{:inv_create:} KH Invoice Pro 1 month", price_usd: 3, days: 30, sort: 101 },
  { id: "inv_2m", plan: "2m", title_km: "{:inv_create:} KH Invoice Pro ២ ខែ", title_en: "{:inv_create:} KH Invoice Pro 2 months", price_usd: 5, days: 60, sort: 102 },
  { id: "inv_3m", plan: "3m", title_km: "{:inv_create:} KH Invoice Pro ៣ ខែ", title_en: "{:inv_create:} KH Invoice Pro 3 months", price_usd: 7, days: 90, sort: 103 },
  { id: "inv_1y", plan: "1y", title_km: "{:inv_create:} KH Invoice Pro ១២ ខែ {:star:}", title_en: "{:inv_create:} KH Invoice Pro 12 months {:star:}", price_usd: 25, days: 365, sort: 104 },
];
// Plans that were sold before and must no longer be offered.
const RETIRED_PACKAGES = ["inv_6m"];

export const isInvoicePackage = (id) => String(id ?? "").startsWith(INVOICE_PACKAGE_PREFIX);
export const enabled = () => Boolean(config.khInvoiceBridgeUrl && config.khInvoiceBridgeSecret);

// ------------------------------------------------------------ signatures

/**
 * Checks Telegram Mini App initData the way Telegram documents it: an HMAC of
 * the sorted fields, keyed by HMAC("WebAppData", bot token). Returns the
 * Telegram user, or null when the data is forged, stale or from another bot.
 */
export function verifyInitData(initData, maxAgeSeconds = 24 * 60 * 60) {
  const token = config.telegramLoginBotToken;
  if (!token || typeof initData !== "string" || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const expected = crypto.createHmac("sha256", secret).update(checkString).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > maxAgeSeconds) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null");
    if (!user?.id) return null;
    return { id: user.id, username: user.username ?? null, first_name: user.first_name ?? null };
  } catch {
    return null;
  }
}

/** Constant-time check of the shared secret the edge function sends. */
export function bridgeSecretMatches(presented) {
  const expected = config.khInvoiceBridgeSecret;
  if (!expected || typeof presented !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------ bridge io

async function bridge(action, payload = {}) {
  const res = await fetch(config.khInvoiceBridgeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Secret": config.khInvoiceBridgeSecret },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `KH Invoice bridge ${action} failed (${res.status})`);
  return body;
}

const tgOf = (user) => ({
  id: user.telegram_user_id,
  username: user.username ?? null,
  first_name: user.first_name ?? null,
});

/**
 * On startup: tell the app which bot it belongs to (for its t.me links) and
 * make sure the plan rows exist for botPay to build orders from.
 */
export async function announce() {
  if (!enabled()) return;
  try {
    await db().from("bot_packages").upsert(
      PACKAGES.map(({ plan: _plan, ...row }) => ({ ...row, downloads: null, active: true })),
      { onConflict: "id" }
    );
    await db().from("bot_packages").update({ active: false }).in("id", RETIRED_PACKAGES);
    const me = await call("getMe", {});
    const username = me?.result?.username;
    if (username) await bridge("hello", { bot_username: username });
    console.log(`KH Invoice bridge ready${username ? ` (@${username})` : ""}.`);
  } catch (err) {
    console.error("KH Invoice bridge setup failed:", err?.message ?? err);
  }
}

/** Called by botPay once an inv_* order is paid. Returns the new expiry. */
export async function activatePlan(order, user) {
  const pkg = PACKAGES.find((p) => p.id === order.package_id);
  if (!pkg) throw new Error(`Unknown KH Invoice package ${order.package_id}`);
  const result = await bridge("activate", { telegram: tgOf(user), plan: pkg.plan, ref: `saveit:${order.ticket}` });
  return result.subscription_expires_at ?? null;
}

// ------------------------------------------------------------ text

const L = {
  km: {
    title: "{:inv_app:} KH Invoice",
    tagline: "វិក្កយបត្រ · ចំណូលចំណាយ · ស្តុក · បំណុល — ក្នុង Telegram",
    notLinked:
      "{:inv_create:} KH Invoice — គ្រប់គ្រងហាងរបស់អ្នកពីទូរស័ព្ទ\n\n" +
      "{:ok:} ចេញវិក្កយបត្រស្អាតៗ ផ្ញើជារូបភាព\n" +
      "{:ok:} កត់ចំណូល / ចំណាយ ដុល្លារ និង រៀល\n" +
      "{:ok:} ស្តុកទំនិញ + ជូនដំណឹងពេលជិតអស់\n" +
      "{:ok:} បំណុលអតិថិជន និង អ្នកផ្គត់ផ្គង់\n" +
      "{:ok:} របាយការណ៍ចំណេញ ប្រចាំថ្ងៃ/ខែ\n\n" +
      "{:gift:} សាកល្បងឥតគិតថ្លៃ ១៥ ថ្ងៃ — ចុចប៊ូតុងខាងក្រោម គណនីបង្កើតស្វ័យប្រវត្តិ មិនបាច់លេខសម្ងាត់ទេ។\n\n" +
      "មានគណនីលេខទូរស័ព្ទរួចហើយ? បើកកម្មវិធី → គណនី → «ភ្ជាប់ Telegram»។",
    start: "🚀 ចាប់ផ្ដើមឥតគិតថ្លៃ ១៥ ថ្ងៃ",
    open: "📱 បើក KH Invoice",
    income: "➕ ចំណូល",
    expense: "➖ ចំណាយ",
    unpaid: "🧾 មិនទាន់បង់",
    refresh: "🔄 ថ្មី",
    buy: "👑 ទិញ Pro",
    trial: (bar, left, total) => `{:gift:} សាកល្បង: ${bar} នៅសល់ ${left}/${total} ថ្ងៃ`,
    trialOver: "{:fail:} ការសាកល្បងបានផុតកំណត់ — ចុច {:m_pro:} ទិញ Pro ដើម្បីបន្ត",
    pro: (until) => `{:m_pro:} Pro សកម្ម រហូតដល់ ${until}`,
    today: "📅 ថ្ងៃនេះ",
    month: "🗓 ខែនេះ",
    inc: "{:inv_in:} ចំណូល",
    exp: "{:inv_out:} ចំណាយ",
    bal: "{:credit:} នៅសល់",
    unpaidLine: (n, amount) => `{:inv_unpaid:} វិក្កយបត្រមិនទាន់បង់: ${n}${n ? ` · ${amount}` : ""}`,
    lowStock: (n) => `{:inv_stock:} ទំនិញជិតអស់: ${n}`,
    tip: "{:bulb:} ឆាប់ៗ: វាយ +25 លក់កាហ្វេ ឬ -10000៛ ថ្លៃទឹក ដើម្បីកត់ភ្លាមៗ",
    askAmount: (type) =>
      `${type === "income" ? "{:inv_in:} ចំណូល" : "{:inv_out:} ចំណាយ"} — វាយចំនួន និងពិពណ៌នា\n\nឧទាហរណ៍៖\n• 25 លក់កាហ្វេ\n• 15000៛ ថ្លៃដឹក\n• $3.5 ទឹកកក`,
    badAmount: "{:fail:} មិនស្គាល់ចំនួនទឹកប្រាក់ទេ។ ឧទាហរណ៍៖ 25 លក់កាហ្វេ ឬ 15000៛ ថ្លៃដឹក",
    saved: (type, amount, desc) => `{:ok:} បានកត់${type === "income" ? "ចំណូល" : "ចំណាយ"} ${amount} — ${desc}`,
    needLink: "{:link:} មិនទាន់មានគណនី KH Invoice ទេ — ចុច «ចាប់ផ្ដើម» នៅខាងក្រោមជាមុនសិន។",
    locked: "{:lock:} គណនី KH Invoice របស់អ្នកត្រូវបានចាក់សោ។ សូមទាក់ទងអ្នកគ្រប់គ្រង។",
    unpaidTitle: "{:inv_create:} វិក្កយបត្រមិនទាន់បង់",
    unpaidNone: "{:party:} គ្មានវិក្កយបត្រជំពាក់ទេ!",
    plans: "{:m_pro:} KH Invoice Pro — ជ្រើសរើសគម្រោង\n\n{:ok:} ប្រើមុខងារទាំងអស់ គ្មានដែនកំណត់\n{:ok:} ស្កេនដោយ App ធនាគារណាមួយ (KHQR)\n{:ok:} បើកដំណើរការភ្លាមៗ ក្រោយបង់",
    loginAsk:
      "{:lock:} ចូល KH Invoice តាម Telegram?\n\nមាននរណាម្នាក់ (សង្ឃឹមថាអ្នក) កំពុងចូល KH Invoice នៅលើកម្មវិធីរុករក។\n{:warn:} ចុច «បាទ/ចាស» លុះត្រាតែអ្នកទើបតែចុច «ចូលតាម Telegram» ដោយខ្លួនឯង។",
    loginYes: "✅ បាទ/ចាស ចូល",
    no: "❌ ទេ",
    loginDone: "{:ok:} រួចរាល់! ត្រឡប់ទៅកម្មវិធីរុករកវិញ — អ្នកនឹងចូលដោយស្វ័យប្រវត្តិ។",
    linkAsk: (name) => `{:link:} ភ្ជាប់ Telegram នេះជាមួយគណនី KH Invoice «${name || "—"}»?\n\nក្រោយភ្ជាប់ អ្នកអាចចូល និង ប្រើពី bot នេះបាន។`,
    linkYes: "✅ ភ្ជាប់",
    linkDone: (name) => `{:ok:} បានភ្ជាប់ Telegram ជាមួយ «${name || "KH Invoice"}» រួចរាល់!`,
    inUse: (name) => `{:warn:} Telegram នេះបានភ្ជាប់ជាមួយគណនីផ្សេង «${name || "—"}» រួចហើយ។`,
    expired: "⌛ តំណនេះផុតកំណត់ ឬ ប្រើរួចហើយ។ សូមព្យាយាមម្ដងទៀតពីកម្មវិធី។",
    cancelled: "បានបោះបង់។",
    down: "{:warn:} KH Invoice មិនអាចភ្ជាប់បានឥឡូវនេះ។ សូមព្យាយាមម្ដងទៀតបន្តិចទៀត។",
    granted: (until) => `{:party:} KH Invoice Pro បានបើកដំណើរការ!${until ? ` រហូតដល់ ${until}` : ""}\nអរគុណសម្រាប់ការគាំទ្រ 🙏`,
    section: "{:inv_create:} ផ្នែក KH Invoice — ប៊ូតុងខាងក្រោមប្ដូរមកមុខងារវិក្កយបត្រ។ ចុច {:inv_back:} ម៉ឺនុយដើម ដើម្បីត្រឡប់។",
    kCreate: "🧾 បង្កើតវិក្កយបត្រ",
    kOpen: "📱 បើក KH Invoice",
    kSummary: "📋 សង្ខេបថ្ងៃនេះ",
    kShop: "🏪 ឈ្មោះហាង",
    kStock: "📦 ស្តុកទំនិញ",
    kCustomer: "👥 អតិថិជន",
    kSupplierDebt: "🤝 បំណុលអ្នកផ្គត់ផ្គង់",
    kCategory: "🏷 ប្រភេទចំណូល/ចំណាយ",
    kBack: "⬅️ ម៉ឺនុយដើម",
    backDone: "{:inv_back:} ត្រឡប់ទៅម៉ឺនុយដើម",
    createHint: "{:inv_create:} ចុចប៊ូតុងខាងក្រោម ដើម្បីបើកផ្ទាំងបង្កើតវិក្កយបត្រ (ចូលដោយស្វ័យប្រវត្តិ)៖",
    stockHint: "{:inv_stock:} ចុចប៊ូតុងខាងក្រោម ដើម្បីមើលស្តុកទំនិញ (ចូលដោយស្វ័យប្រវត្តិ)៖",
    openHint: "{:app_tg:} ជ្រើសផ្ទាំងដែលចង់បើក (ចូលដោយស្វ័យប្រវត្តិ)៖",
    appHint: "{:app_tg:} ចុចប៊ូតុងខាងក្រោម ដើម្បីបើក (ចូលដោយស្វ័យប្រវត្តិ)៖",
    aCreate: "🧾 បង្កើតវិក្កយបត្រ",
    aInvoices: "📂 វិក្កយបត្រទាំងអស់",
    aReport: "📊 របាយការណ៍",
    aStock: "📦 ស្តុក",
    aCustomer: "👥 អតិថិជន",
    aSupplierDebt: "🤝 បំណុលអ្នកផ្គត់ផ្គង់",
    aCategory: "🏷 ប្រភេទចំណូល/ចំណាយ",
    aDebt: "💳 បំណុល",
    aHome: "🏠 ទំព័រដើម",
    askShop: (current) => `{:inv_shop:} វាយឈ្មោះហាងរបស់អ្នក (បង្ហាញលើវិក្កយបត្រ)${current ? `\nបច្ចុប្បន្ន៖ ${current}` : ""}`,
    shopSaved: (name) => `{:ok:} ឈ្មោះហាងបានរក្សាទុក៖ ${name}`,
    noWebApp: "{:warn:} កម្មវិធី KH Invoice មិនទាន់រៀបចំ link ទេ។",
  },
  en: {
    title: "{:inv_app:} KH Invoice",
    tagline: "Invoices · income & expenses · stock · debts — inside Telegram",
    notLinked:
      "{:inv_create:} KH Invoice — run your shop from your phone\n\n" +
      "{:ok:} Clean invoices, shared as images\n" +
      "{:ok:} Income / expenses in USD and KHR\n" +
      "{:ok:} Stock with low-stock alerts\n" +
      "{:ok:} Customer and supplier debts\n" +
      "{:ok:} Daily / monthly profit reports\n\n" +
      "{:gift:} 15-day free trial — tap below and your account is created automatically, no password.\n\n" +
      "Already have a phone-number account? Open the app → Account → “Connect Telegram”.",
    start: "🚀 Start 15-day free trial",
    open: "📱 Open KH Invoice",
    income: "➕ Income",
    expense: "➖ Expense",
    unpaid: "🧾 Unpaid",
    refresh: "🔄 Refresh",
    buy: "👑 Buy Pro",
    trial: (bar, left, total) => `{:gift:} Trial: ${bar} ${left}/${total} days left`,
    trialOver: "{:fail:} Your trial has ended — tap {:m_pro:} Buy Pro to continue",
    pro: (until) => `{:m_pro:} Pro active until ${until}`,
    today: "📅 Today",
    month: "🗓 This month",
    inc: "{:inv_in:} Income",
    exp: "{:inv_out:} Expense",
    bal: "{:credit:} Balance",
    unpaidLine: (n, amount) => `{:inv_unpaid:} Unpaid invoices: ${n}${n ? ` · ${amount}` : ""}`,
    lowStock: (n) => `{:inv_stock:} Low stock: ${n}`,
    tip: "{:bulb:} Shortcut: type +25 coffee sale or -10000៛ water to record instantly",
    askAmount: (type) =>
      `${type === "income" ? "{:inv_in:} Income" : "{:inv_out:} Expense"} — type the amount and a note\n\nFor example:\n• 25 coffee sales\n• 15000៛ delivery\n• $3.5 ice`,
    badAmount: "{:fail:} I couldn't read an amount. Try: 25 coffee sales, or 15000៛ delivery",
    saved: (type, amount, desc) => `{:ok:} ${type === "income" ? "Income" : "Expense"} recorded: ${amount} — ${desc}`,
    needLink: "{:link:} You don't have a KH Invoice account yet — tap “Start” below first.",
    locked: "{:lock:} Your KH Invoice account is locked. Please contact the operator.",
    unpaidTitle: "{:inv_create:} Unpaid invoices",
    unpaidNone: "{:party:} No unpaid invoices!",
    plans: "{:m_pro:} KH Invoice Pro — choose a plan\n\n{:ok:} Every feature, no limits\n{:ok:} Scan with any bank app (KHQR)\n{:ok:} Switched on the moment you pay",
    loginAsk:
      "{:lock:} Sign in to KH Invoice with Telegram?\n\nSomeone (hopefully you) is signing in to KH Invoice in a browser.\n{:warn:} Only tap “Yes” if you just pressed “Sign in with Telegram” yourself.",
    loginYes: "✅ Yes, sign me in",
    no: "❌ No",
    loginDone: "{:ok:} Done! Go back to your browser — you'll be signed in automatically.",
    linkAsk: (name) => `{:link:} Connect this Telegram to the KH Invoice account “${name || "—"}”?\n\nAfterwards you can sign in and use it from this bot.`,
    linkYes: "✅ Connect",
    linkDone: (name) => `{:ok:} Telegram connected to “${name || "KH Invoice"}”!`,
    inUse: (name) => `{:warn:} This Telegram is already connected to another account, “${name || "—"}”.`,
    expired: "⌛ This link has expired or was already used. Please try again from the app.",
    cancelled: "Cancelled.",
    down: "{:warn:} KH Invoice can't be reached right now. Please try again in a moment.",
    granted: (until) => `{:party:} KH Invoice Pro is on!${until ? ` Until ${until}` : ""}\nThank you for your support 🙏`,
    section: "{:inv_create:} KH Invoice section — the buttons below now work on invoices. Tap {:inv_back:} Main menu to go back.",
    kCreate: "🧾 Create invoice",
    kOpen: "📱 Open KH Invoice",
    kSummary: "📋 Today's summary",
    kShop: "🏪 Shop name",
    kStock: "📦 Stock",
    kCustomer: "👥 Customers",
    kSupplierDebt: "🤝 Supplier debts",
    kCategory: "🏷 Categories",
    kBack: "⬅️ Main menu",
    backDone: "{:inv_back:} Back to the main menu",
    createHint: "{:inv_create:} Tap below to open the new-invoice screen (signed in automatically):",
    stockHint: "{:inv_stock:} Tap below to see your stock (signed in automatically):",
    openHint: "{:app_tg:} Pick a screen to open (signed in automatically):",
    appHint: "{:app_tg:} Tap below to open it (signed in automatically):",
    aCreate: "🧾 Create invoice",
    aInvoices: "📂 All invoices",
    aReport: "📊 Report",
    aStock: "📦 Stock",
    aCustomer: "👥 Customers",
    aSupplierDebt: "🤝 Supplier debts",
    aCategory: "🏷 Categories",
    aDebt: "💳 Debts",
    aHome: "🏠 Home",
    askShop: (current) => `{:inv_shop:} Type your shop name (shown on invoices)${current ? `\nNow: ${current}` : ""}`,
    shopSaved: (name) => `{:ok:} Shop name saved: ${name}`,
    noWebApp: "{:warn:} The KH Invoice app link isn't set up yet.",
  },
};
const tx = (language) => L[language] ?? L.km;
export const grantedText = (language, until) => tx(language).granted(until ? String(until).slice(0, 10) : null);

// ------------------------------------------------------------ helpers

function money(usd, khr) {
  const parts = [];
  if (usd) parts.push(`$${Number(usd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  if (khr) parts.push(`${Math.round(Number(khr)).toLocaleString("en-US")}៛`);
  return parts.length ? parts.join(" + ") : "$0.00";
}

const KHMER_DIGITS = "០១២៣៤៥៦៧៨៩";
function westernDigits(text) {
  return String(text).replace(/[០-៩]/g, (d) => String(KHMER_DIGITS.indexOf(d)));
}

/**
 * "25 coffee", "$3.5 ice", "15000៛ delivery", "15,000 riel", "+25 x".
 * Without a currency mark, 1000 or more reads as riel -- nobody sells a
 * $1000 coffee, and 1000៛ is a common price.
 */
export function parseEntry(text) {
  const src = westernDigits(text).trim().replace(/^[+-]\s*/, "");
  const m = /^(\$)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(\$|usd|khr|riel|រៀល|៛|r(?![a-z]))?\s*([\s\S]*)$/i.exec(src);
  if (!m) return null;
  const amount = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const mark = (m[1] || m[3] || "").toLowerCase();
  const currency = mark === "$" || mark === "usd" ? "USD" : mark ? "KHR" : amount >= 1000 ? "KHR" : "USD";
  return { amount, currency, description: m[4].trim().slice(0, 200) };
}

/** The Mini App URL, opened on one screen (see the app's applyDeepLink). */
function webAppUrl(screen) {
  const base = config.khInvoiceWebUrl || (config.publicUrl ? `${config.publicUrl.replace(/\/$/, "")}/invoice/` : "");
  if (!base) return null;
  return screen ? `${base}${base.includes("?") ? "&" : "?"}screen=${screen}` : base;
}

// Inline, not reply-keyboard, web_app buttons: only a Mini App opened from an
// inline button (or the menu button) is handed the signed initData the app
// signs in with.
function openButton(t, label, screen, emoji = "inv_app") {
  const url = webAppUrl(screen);
  return url ? { text: label ?? t.open, emoji, web_app: { url } } : null;
}

/** The keyboard under the message box while in the KH Invoice section. */
export function sectionKeyboard(language) {
  const t = tx(language);
  return {
    // Create invoice stands alone on top -- the one action people reach for
    // most -- then income/expense, the other two logged every day. Stock,
    // Unpaid, Shop name, Open KH Invoice and Buy Pro all live one tap into
    // Today's summary instead of their own row, so this keyboard stays short
    // enough to leave real room above it -- a payment QR especially.
    // Every action of the section lives here, under the message box; the
    // chat above only shows results. `style` colours the main actions.
    keyboard: [
      [{ text: t.kCreate, emoji: "inv_create", style: "primary" }],
      [{ text: t.income, emoji: "inv_in", style: "success" }, { text: t.expense, emoji: "inv_out", style: "danger" }],
      [{ text: t.kSummary, emoji: "inv_summary" }, { text: t.aReport, emoji: "inv_report" }],
      [{ text: t.kStock, emoji: "inv_stock" }, { text: t.unpaid, emoji: "inv_unpaid" }],
      // Customer directory and supplier debts: the app has had these screens
      // for a while (CustomerScreen.tsx/SupplierDebtScreen.tsx), but nothing
      // in the bot ever linked to them -- this is that missing link.
      [{ text: t.kCustomer }, { text: t.kSupplierDebt }],
      [{ text: t.kCategory }, { text: t.kShop, emoji: "inv_shop" }],
      [{ text: t.kOpen, emoji: "inv_app" }, { text: t.buy, emoji: "inv_pro", style: "primary" }],
      [{ text: t.kBack, emoji: "inv_back" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// Section buttons arrive as plain text, in either language.
// With a logo icon the button's own leading emoji is dropped (customEmoji.js),
// so a tap may arrive either way.
const SECTION_ACTIONS = new Map();
const bare = (label) => label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");
for (const lang of Object.keys(L)) {
  const t = L[lang];
  for (const [label, action] of [
    [t.kCreate, "create"], [t.kOpen, "open"], [t.income, "income"], [t.expense, "expense"],
    [t.kSummary, "summary"], [t.unpaid, "unpaid"], [t.kShop, "shop"], [t.buy, "buy"], [t.kBack, "back"],
    [t.kStock, "stock"], [t.aReport, "report"], [t.aStock, "stock"],
    [t.kCustomer, "customer"], [t.aCustomer, "customer"],
    [t.kSupplierDebt, "supplierdebt"], [t.aSupplierDebt, "supplierdebt"],
    [t.kCategory, "category"], [t.aCategory, "category"],
  ]) {
    SECTION_ACTIONS.set(label, action);
    SECTION_ACTIONS.set(bare(label), action);
  }
}

/** Entering the section: swap the keyboard, then show the numbers. */
export async function enterSection(chatId, user) {
  const t = tx(user.language);
  await call("sendMessage", { chat_id: chatId, text: t.section, reply_markup: sectionKeyboard(user.language) });
  await showHome(chatId, user);
}

/**
 * One app screen, from its keyboard button. Telegram only signs a Mini App
 * in when it's opened from a button on a message (a keyboard button's Mini
 * App gets no initData), so this is the one place a button still appears
 * in the chat: the single "open" for the screen just asked for.
 */
async function showAppScreen(chatId, user, label, screen, emoji, hint) {
  const t = tx(user.language);
  const button = openButton(t, label, screen, emoji);
  if (!button) return call("sendMessage", { chat_id: chatId, text: t.noWebApp });
  return call("sendMessage", { chat_id: chatId, text: hint, reply_markup: { inline_keyboard: [[{ ...button, style: "primary" }]] } });
}

/**
 * A tap on one of the section's keyboard buttons. Returns true when the text
 * was one of them; `backToMenu` is the main keyboard to restore on {:inv_back:}.
 */
/** The shop-name prompt, shared by the keyboard button and the Home screen's. */
async function askShopName(chatId, user) {
  const t = tx(user.language);
  const s = await bridge("status", { telegram: tgOf(user) }).catch(() => null);
  if (!s?.linked) {
    await call("sendMessage", { chat_id: chatId, text: t.needLink });
    await showHome(chatId, user);
  } else {
    awaiting.set(chatId, { kind: "shop", at: Date.now() });
    await call("sendMessage", { chat_id: chatId, text: t.askShop(s.business_name) });
  }
}

export async function handleSectionButton(chatId, user, text, backToMenu) {
  const action = SECTION_ACTIONS.get(String(text ?? "").trim());
  if (!action || !enabled()) return false;
  awaiting.delete(chatId);
  const t = tx(user.language);
  if (action === "create") await showAppScreen(chatId, user, t.aCreate, "invoice", "inv_create", t.createHint);
  else if (action === "open") await showAppScreen(chatId, user, t.open, undefined, "inv_app", t.appHint);
  else if (action === "report") await showAppScreen(chatId, user, t.aReport, "report", "inv_report", t.appHint);
  else if (action === "stock") await showAppScreen(chatId, user, t.aStock, "stock", "inv_stock", t.stockHint);
  else if (action === "customer") await showAppScreen(chatId, user, t.aCustomer, "customer", undefined, t.appHint);
  else if (action === "supplierdebt") await showAppScreen(chatId, user, t.aSupplierDebt, "supplierdebt", undefined, t.appHint);
  else if (action === "category") await showAppScreen(chatId, user, t.aCategory, "category", undefined, t.appHint);
  else if (action === "income" || action === "expense") {
    awaiting.set(chatId, { kind: "entry", type: action, at: Date.now() });
    await call("sendMessage", { chat_id: chatId, text: t.askAmount(action) });
  } else if (action === "summary") await showHome(chatId, user);
  else if (action === "unpaid") await showUnpaid(chatId, user);
  else if (action === "buy") await showPlans(chatId, user);
  else if (action === "shop") await askShopName(chatId, user);
  else if (action === "back") {
    await call("sendMessage", { chat_id: chatId, text: t.backDone, reply_markup: backToMenu });
  }
  return true;
}

// Waiting for the amount after {:inv_in:} / {:inv_out:}. In memory on purpose: a restart just
// means the person taps the button again.
const awaiting = new Map();
const AWAIT_MS = 10 * 60 * 1000;

// ------------------------------------------------------------ screens

export async function showHome(chatId, user) {
  const t = tx(user.language);
  if (!enabled()) return call("sendMessage", { chat_id: chatId, text: t.down });
  let s;
  try {
    s = await bridge("status", { telegram: tgOf(user) });
  } catch (err) {
    console.error("KH Invoice status failed:", err?.message ?? err);
    return call("sendMessage", { chat_id: chatId, text: t.down });
  }

  if (!s.linked) {
    const keyboard = [];
    const start = openButton(t, t.start, undefined, "rocket");
    if (start) keyboard.push([start]);
    keyboard.push([{ text: t.buy, emoji: "inv_pro", callback_data: "inv:plans" }]);
    return call("sendMessage", { chat_id: chatId, text: t.notLinked, reply_markup: { inline_keyboard: keyboard } });
  }

  const standing = s.subscribed
    ? t.pro(String(s.subscription_expires_at).slice(0, 10))
    : s.trial_days_left > 0
      ? t.trial(progressBar(s.trial_days_total - s.trial_days_left, s.trial_days_total), s.trial_days_left, s.trial_days_total)
      : t.trialOver;
  const block = (label, p) => [
    label,
    `├ ${t.inc}: ${money(p.income_usd, p.income_khr)}`,
    `├ ${t.exp}: ${money(p.expense_usd, p.expense_khr)}`,
    `└ ${t.bal}: ${money(p.income_usd - p.expense_usd, p.income_khr - p.expense_khr)}`,
  ];
  const lines = [
    `${t.title} · ${s.business_name ?? ""}`.trim(),
    standing,
    "",
    ...block(t.today, s.today),
    "",
    ...block(t.month, s.month),
    "",
    t.unpaidLine(s.unpaid.count, money(s.unpaid.usd, s.unpaid.khr)),
    t.lowStock(s.low_stock),
    "",
    t.tip,
  ];

  // Display only: every action is on the section keyboard below.
  return call("sendMessage", { chat_id: chatId, text: lines.join("\n"), reply_markup: sectionKeyboard(user.language) });
}

async function showUnpaid(chatId, user) {
  const t = tx(user.language);
  const r = await bridge("unpaid", { telegram: tgOf(user) });
  if (!r.ok) return call("sendMessage", { chat_id: chatId, text: r.error === "not_linked" ? t.needLink : t.down });
  if (!r.invoices.length) return call("sendMessage", { chat_id: chatId, text: t.unpaidNone });
  const lines = r.invoices.map(
    (i) =>
      `#${i.invoice_number ?? "—"} · ${i.customer_name || "—"} · ${i.currency === "KHR" ? money(0, i.left) : money(i.left, 0)} · ${i.invoice_date}`
  );
  return call("sendMessage", {
    chat_id: chatId,
    text: `${t.unpaidTitle}\n\n${lines.join("\n")}`,
  });
}

export async function showPlans(chatId, user) {
  const t = tx(user.language);
  const list = rows(
    await db().from("bot_packages").select("*").like("id", `${INVOICE_PACKAGE_PREFIX}%`).eq("active", true).order("sort")
  );
  return call("sendMessage", {
    chat_id: chatId,
    text: t.plans,
    reply_markup: {
      // Every plan is the same Pro tier, just a different length -- one
      // crown, not the payment-app's own KHQR mark repeated on each row.
      inline_keyboard: list.map((pkg) => [
        {
          text: `${user.language === "en" ? pkg.title_en : pkg.title_km} — $${Number(pkg.price_usd).toFixed(2)}`,
          emoji: "inv_pro",
          style: "primary",
          callback_data: `bot:buy:${pkg.id}`,
        },
      ]),
    },
  });
}

async function recordEntry(chatId, user, type, text) {
  const t = tx(user.language);
  const entry = parseEntry(text);
  if (!entry) {
    await call("sendMessage", { chat_id: chatId, text: t.badAmount });
    return;
  }
  const r = await bridge("add_tx", { telegram: tgOf(user), type, ...entry });
  if (!r.ok) {
    const reason = r.error === "not_linked" ? t.needLink : r.error === "locked" ? t.locked : r.error === "bad_amount" ? t.badAmount : t.down;
    await call("sendMessage", { chat_id: chatId, text: reason });
    return;
  }
  const amount = entry.currency === "KHR" ? money(0, entry.amount) : money(entry.amount, 0);
  const today = `${t.today}: ${t.inc} ${money(r.today.income_usd, r.today.income_khr)} · ${t.exp} ${money(r.today.expense_usd, r.today.expense_khr)}`;
  await call("sendMessage", {
    chat_id: chatId,
    text: `${t.saved(type, amount, entry.description || "—")}\n\n${today}`,
  });
}

// ------------------------------------------------------------ entry points

/**
 * A /start payload aimed at KH Invoice: "invoice", "invpay", "inl_<code>"
 * (browser sign-in) or "inlk_<code>" (connect an existing account).
 * Returns true when handled.
 */
export async function handleStart(chatId, user, payload) {
  if (!payload || !enabled()) return false;
  const t = tx(user.language);
  if (payload === "invoice") {
    await enterSection(chatId, user);
    return true;
  }
  if (payload === "invpay") {
    await showPlans(chatId, user);
    return true;
  }
  const login = /^inl_([A-Za-z0-9_-]{16,40})$/.exec(payload);
  if (login) {
    await call("sendMessage", {
      chat_id: chatId,
      text: t.loginAsk,
      reply_markup: { inline_keyboard: [[{ text: t.loginYes, emoji: "ok", callback_data: `inv:ok:${login[1]}` }, { text: t.no, emoji: "fail", callback_data: "inv:no" }]] },
    });
    return true;
  }
  const link = /^inlk_([A-Za-z0-9_-]{16,40})$/.exec(payload);
  if (link) {
    await call("sendMessage", {
      chat_id: chatId,
      text: t.linkAsk(""),
      reply_markup: { inline_keyboard: [[{ text: t.linkYes, emoji: "ok", callback_data: `inv:ok:${link[1]}` }, { text: t.no, emoji: "fail", callback_data: "inv:no" }]] },
    });
    return true;
  }
  return false;
}

/**
 * Plain text that belongs to KH Invoice: the amount after {:inv_in:}/{:inv_out:}, or a
 * "+25 coffee" / "-5000៛ ice" shortcut. Returns true when handled.
 */
export async function handleText(chatId, user, text) {
  if (!enabled()) return false;
  const pending = awaiting.get(chatId);
  if (pending && Date.now() - pending.at < AWAIT_MS) {
    awaiting.delete(chatId);
    if (pending.kind === "shop") await saveShopName(chatId, user, text);
    else await recordEntry(chatId, user, pending.type, text);
    return true;
  }
  awaiting.delete(chatId);
  const shortcut = /^([+-])\s*[$]?\s*[0-9០-៩]/.exec(text);
  if (shortcut) {
    await recordEntry(chatId, user, shortcut[1] === "+" ? "income" : "expense", text);
    return true;
  }
  return false;
}

async function saveShopName(chatId, user, text) {
  const t = tx(user.language);
  const r = await bridge("set_name", { telegram: tgOf(user), business_name: text }).catch(() => ({ ok: false }));
  await call("sendMessage", { chat_id: chatId, text: r.ok ? t.shopSaved(r.business_name) : r.error === "not_linked" ? t.needLink : t.down });
}

/** Forgets a half-finished {:inv_in:}/{:inv_out:} when the person moves on to something else. */
export function cancelPending(chatId) {
  awaiting.delete(chatId);
}

/** Buttons with data "inv:...". Returns true when handled. */
export async function handleCallback(cq, user) {
  const data = String(cq?.data ?? "");
  if (!data.startsWith("inv:")) return false;
  const chatId = cq.message?.chat?.id;
  const t = tx(user.language);
  const [, kind, value] = data.split(":");
  await call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  if (!chatId) return true;

  try {
    if (kind === "home") await showHome(chatId, user);
    else if (kind === "plans") await showPlans(chatId, user);
    else if (kind === "unpaid") await showUnpaid(chatId, user);
    else if (kind === "shop") await askShopName(chatId, user);
    else if (kind === "add") {
      const type = value === "expense" ? "expense" : "income";
      awaiting.set(chatId, { kind: "entry", type, at: Date.now() });
      await call("sendMessage", { chat_id: chatId, text: t.askAmount(type) });
    } else if (kind === "no") {
      await call("editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: t.cancelled });
    } else if (kind === "ok") {
      const r = await bridge("approve", { code: value, telegram: tgOf(user) });
      const text = !r.ok
        ? r.error === "telegram_in_use"
          ? t.inUse(r.business_name)
          : r.error === "locked"
            ? t.locked
            : t.expired
        : r.kind === "link"
          ? t.linkDone(r.business_name)
          : t.loginDone;
      await call("editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text });
      if (r.ok && r.kind === "link") await showHome(chatId, user);
    }
  } catch (err) {
    console.error(`KH Invoice button ${data} failed:`, err?.message ?? err);
    await call("sendMessage", { chat_id: chatId, text: t.down });
  }
  return true;
}
