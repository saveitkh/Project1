/**
 * Text translation: tap "🌐 Translate", send a message, get it back in the
 * other language. Uses Google's public translate endpoint (the same one
 * translate.google.com's own web page calls) -- free, no API key, no
 * billing account to set up, unlike the official Cloud Translation API.
 */
import { call } from "./notifyBot.js";

const TEXT = {
  km: {
    ask:
      "{:m_language:} បកប្រែភាសា\n\n" +
      "ផ្ញើអត្ថបទដែលចង់បកប្រែមកខ្ញុំ — ខ្ញុំនឹងស្គាល់ភាសា ហើយបកអោយភ្លាម (ខ្មែរ ⇄ អង់គ្លេស ស្វ័យប្រវត្តិ)។\n" +
      "{:bulb:} ចុចប៊ូតុង 🇨🇳 🇹🇭 🇻🇳 ក្រោមលទ្ធផល ដើម្បីបកទៅភាសាផ្សេងទៀតភ្លាម។",
    working: "{:wait:} កំពុងបកប្រែ…",
    failed: "{:fail:} បកប្រែមិនបានទេ សូមសាកម្ដងទៀត។",
    inlineHint:
      "\n\n{:bulb:} ថ្មី! បកប្រែក្នុង chat ណាក៏បាន — វាយ {bot} រួចអត្ថបទ ក្នុងប្រអប់សារ ហើយចុចលទ្ធផលដើម្បីផ្ញើ។",
    inlineButton: "🌐 បកប្រែក្នុង chat ផ្សេង",
  },
  en: {
    ask:
      "{:m_language:} Translate\n\n" +
      "Send me the text you want translated — I'll detect the language and translate it automatically (Khmer ⇄ English).\n" +
      "{:bulb:} Tap the 🇨🇳 🇹🇭 🇻🇳 buttons under a result to translate it into another language too.",
    working: "{:wait:} Translating…",
    failed: "{:fail:} Couldn't translate that. Please try again.",
    inlineHint:
      "\n\n{:bulb:} New! Translate in any chat — type {bot} followed by your text in the message box, then tap a result to send it.",
    inlineButton: "🌐 Translate in another chat",
  },
};

// Waiting for the text to translate. In memory on purpose: a restart just
// means the person taps the button again.
const waiting = new Map();
const WAIT_MS = 10 * 60_000;

// The original text behind each "🇨🇳 🇹🇭 🇻🇳" button below a translation --
// callback_data can't carry the text itself (Telegram's 64-byte limit), so a
// short id stands in for it here instead, swept for staleness on insert.
const pending = new Map(); // id -> { text, at }
function remember(text) {
  const cutoff = Date.now() - WAIT_MS;
  for (const [id, e] of pending) if (e.at < cutoff) pending.delete(id);
  const id = Math.random().toString(36).slice(2, 10);
  pending.set(id, { text, at: Date.now() });
  return id;
}
const MORE_LANGS = [
  ["zh", "🇨🇳 中文"],
  ["th", "🇹🇭 ไทย"],
  ["vi", "🇻🇳 Tiếng Việt"],
];

let botName = null;
async function botUsername() {
  if (!botName) botName = (await call("getMe", {}))?.result?.username ?? null;
  return botName;
}

export async function ask(chatId, user) {
  waiting.set(chatId, { at: Date.now() });
  const t = TEXT[user.language] ?? TEXT.km;
  const name = await botUsername().catch(() => null);
  return call("sendMessage", {
    chat_id: chatId,
    text: t.ask + t.inlineHint.replace("{bot}", name ? `@${name}` : "@bot"),
    reply_markup: { inline_keyboard: [[{ text: t.inlineButton, style: "primary", switch_inline_query: "" }]] },
  });
}

export function cancel(chatId) {
  waiting.delete(chatId);
}

function isWaiting(chatId) {
  const w = waiting.get(chatId);
  if (!w) return false;
  if (Date.now() - w.at > WAIT_MS) {
    waiting.delete(chatId);
    return false;
  }
  return true;
}

/**
 * Calls Google's public translate endpoint, auto-detecting the source
 * language. Returns the translated text and the language Google detected.
 */
export async function translateText(text, targetLang) {
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    `?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Translate returned ${res.status}`);
  const data = await res.json();
  const translated = (data?.[0] ?? []).map((chunk) => chunk[0]).join("");
  const detected = data?.[2] ?? null;
  return { translated, detected };
}

const LANG_NAMES = { km: "🇰🇭 ខ្មែរ", en: "🇬🇧 English", zh: "🇨🇳 中文", th: "🇹🇭 ไทย", vi: "🇻🇳 Tiếng Việt" };

/**
 * Inline mode: "@bot some text" typed in any chat. Offers the text in Khmer
 * and English (minus whichever it already is), plus Chinese / Thai /
 * Vietnamese; tapping one sends the translation into that chat. Needs inline
 * mode switched on once in BotFather (/setinline).
 */
export async function handleInlineQuery(iq) {
  const text = String(iq?.query ?? "").trim();
  if (text.length < 2) {
    return call("answerInlineQuery", { inline_query_id: iq.id, results: [], cache_time: 5 });
  }
  const targets = ["km", "en", "zh", "th", "vi"];
  const settled = await Promise.allSettled(targets.map((lang) => translateText(text, lang)));
  const detected = settled.find((s) => s.status === "fulfilled")?.value.detected;
  const results = [];
  settled.forEach((s, i) => {
    const lang = targets[i];
    if (s.status !== "fulfilled" || !s.value.translated || lang === detected) return;
    results.push({
      type: "article",
      id: `${lang}-${iq.id}`.slice(0, 64),
      title: LANG_NAMES[lang],
      description: s.value.translated.slice(0, 200),
      input_message_content: { message_text: s.value.translated },
    });
  });
  return call("answerInlineQuery", { inline_query_id: iq.id, results, cache_time: 300, is_personal: false });
}

/**
 * A message while waiting for text to translate. Khmer goes to English;
 * anything else detected goes to Khmer. Returns true when it handled it.
 */
export async function handleText(chatId, user, text) {
  if (!isWaiting(chatId)) return false;
  waiting.delete(chatId);
  const t = TEXT[user.language] ?? TEXT.km;
  await call("sendMessage", { chat_id: chatId, text: t.working });
  try {
    const toKm = await translateText(text, "km");
    const result = toKm.detected === "km" ? await translateText(text, "en") : toKm;
    const id = remember(text);
    await call("sendMessage", {
      chat_id: chatId,
      text: result.translated || t.failed,
      reply_markup: { inline_keyboard: [MORE_LANGS.map(([code, label]) => ({ text: label, callback_data: `tr:${code}:${id}` }))] },
    });
  } catch (err) {
    console.error("Translate failed:", err?.message ?? err);
    await call("sendMessage", { chat_id: chatId, text: t.failed });
  }
  return true;
}

/** A tap on 🇨🇳/🇹🇭/🇻🇳 under a translation: the same source text, that language. */
export async function handleCallback(cq) {
  const [, code, id] = String(cq?.data ?? "").split(":");
  const entry = pending.get(id);
  const chatId = cq.message?.chat?.id;
  if (!entry || !chatId) {
    await call("answerCallbackQuery", { callback_query_id: cq.id, text: "⌛", show_alert: false });
    return true;
  }
  await call("answerCallbackQuery", { callback_query_id: cq.id });
  try {
    const { translated } = await translateText(entry.text, code);
    await call("sendMessage", { chat_id: chatId, text: translated || "…" });
  } catch (err) {
    console.error("Translate (more languages) failed:", err?.message ?? err);
  }
  return true;
}
