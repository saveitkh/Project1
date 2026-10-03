/**
 * Text translation: tap "🌐 Translate" and the keyboard switches to its own
 * -- pick a target language (or leave it on "ស្វ័យប្រវត្តិ" auto, which goes
 * Khmer ⇄ English by detecting which one arrived) -- then just send text,
 * one message after another, until "⬅️ ម៉ឺនុយដើម" leaves the section. Uses
 * Google's public translate endpoint (the same one translate.google.com's
 * own web page calls) -- free, no API key, no billing account to set up,
 * unlike the official Cloud Translation API.
 */
import { mainKeyboard } from "./botText.js";
import { call } from "./notifyBot.js";

const LANGS = [
  ["km", "🇰🇭 ខ្មែរ"],
  ["en", "🇬🇧 English"],
  ["zh", "🇨🇳 中文"],
  ["th", "🇹🇭 ไทย"],
  ["vi", "🇻🇳 Tiếng Việt"],
];

const TEXT = {
  km: {
    ask:
      "{:m_language:} បកប្រែភាសា\n\n" +
      "ជ្រើសរើសភាសាគោលដៅខាងក្រោម រួចផ្ញើអត្ថបទមក — ឬទុកលំនាំដើម «ស្វ័យប្រវត្តិ» ឲ្យខ្ញុំស្គាល់ភាសាខ្លួនឯង (ខ្មែរ ⇄ អង់គ្លេស)។",
    autoSet: "{:ok:} ស្វ័យប្រវត្តិ — ខ្មែរ ⇄ អង់គ្លេស។ ផ្ញើអត្ថបទមក។",
    targetSet: (label) => `{:ok:} ឥឡូវបកប្រែទៅ ${label} ស្វ័យប្រវត្តិ — ផ្ញើអត្ថបទមក។`,
    working: "{:wait:} កំពុងបកប្រែ…",
    failed: "{:fail:} បកប្រែមិនបានទេ សូមសាកម្ដងទៀត។",
    inlineHint: "\n\n{:bulb:} ក៏អាចបកប្រែក្នុង chat ណាក៏បាន — វាយ {bot} រួចអត្ថបទ ក្នុងប្រអប់សារ ហើយចុចលទ្ធផលដើម្បីផ្ញើ។",
    auto: "🔄 ស្វ័យប្រវត្តិ",
    back: "⬅️ ម៉ឺនុយដើម",
    backDone: "{:ok:} ត្រឡប់មកម៉ឺនុយដើម។",
  },
  en: {
    ask:
      "{:m_language:} Translate\n\n" +
      "Pick a target language below, then send text — or leave it on \"Auto\" and I'll detect Khmer ⇄ English on my own.",
    autoSet: "{:ok:} Auto -- Khmer ⇄ English. Send me some text.",
    targetSet: (label) => `{:ok:} Now translating to ${label} automatically -- send me some text.`,
    working: "{:wait:} Translating…",
    failed: "{:fail:} Couldn't translate that. Please try again.",
    inlineHint: "\n\n{:bulb:} You can also translate in any chat -- type {bot} followed by your text in the message box, then tap a result to send it.",
    auto: "🔄 Auto",
    back: "⬅️ Main menu",
    backDone: "{:ok:} Back to the main menu.",
  },
};
const tx = (language) => TEXT[language] ?? TEXT.km;

// Session per chat: which target language is pinned (null = auto-detect).
// Long-lived, like the AI's own keyboard -- someone coming back later is
// still in Translate, not told "that isn't a link".
const sessions = new Map(); // chatId -> { target: string|null, at }
const SESSION_MS = 2 * 60 * 60_000;

function session(chatId) {
  const s = sessions.get(chatId);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_MS) {
    sessions.delete(chatId);
    return null;
  }
  return s;
}

/** Whether this chat is in Translate (its own keyboard is on screen). */
export function isActive(chatId) {
  return Boolean(session(chatId));
}

export function cancel(chatId) {
  sessions.delete(chatId);
}

function keyboard() {
  const t = tx();
  return {
    keyboard: [
      [{ text: t.auto }],
      [{ text: LANGS[0][1] }, { text: LANGS[1][1] }],
      [{ text: LANGS[2][1] }, { text: LANGS[3][1] }],
      [{ text: LANGS[4][1] }],
      [{ text: t.back }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

let botName = null;
async function botUsername() {
  if (!botName) botName = (await call("getMe", {}))?.result?.username ?? null;
  return botName;
}

/** "🌐 Translate" (or /translate): switches the keyboard to Translate's own. */
export async function ask(chatId, user) {
  sessions.set(chatId, { target: null, at: Date.now() });
  const t = tx(user.language);
  const name = await botUsername().catch(() => null);
  return call("sendMessage", {
    chat_id: chatId,
    text: t.ask + t.inlineHint.replace("{bot}", name ? `@${name}` : "@bot"),
    reply_markup: keyboard(),
  });
}

/**
 * A tap on Translate's own keyboard -- a language, auto, or back to the main
 * menu. Returns true when it handled it.
 */
export async function handleButton(chatId, user, text) {
  const s = session(chatId);
  if (!s) return false;
  const t = tx(user.language);
  const said = String(text ?? "").trim();

  if (said === t.back) {
    cancel(chatId);
    await call("sendMessage", { chat_id: chatId, text: t.backDone, reply_markup: mainKeyboard(user.language) });
    return true;
  }
  if (said === t.auto) {
    s.target = null;
    s.at = Date.now();
    await call("sendMessage", { chat_id: chatId, text: t.autoSet });
    return true;
  }
  const found = LANGS.find(([, label]) => said === label);
  if (found) {
    s.target = found[0];
    s.at = Date.now();
    await call("sendMessage", { chat_id: chatId, text: t.targetSet(found[1]) });
    return true;
  }
  return false;
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
 * A message while in Translate: the pinned target language if one was
 * picked, otherwise auto-detect (Khmer goes to English; anything else goes
 * to Khmer). Returns true when it handled it.
 */
export async function handleText(chatId, user, text) {
  const s = session(chatId);
  if (!s) return false;
  s.at = Date.now();
  const t = tx(user.language);
  await call("sendMessage", { chat_id: chatId, text: t.working });
  try {
    const result = s.target ? await translateText(text, s.target) : await autoTranslate(text);
    await call("sendMessage", { chat_id: chatId, text: result.translated || t.failed });
  } catch (err) {
    console.error("Translate failed:", err?.message ?? err);
    await call("sendMessage", { chat_id: chatId, text: t.failed });
  }
  return true;
}

async function autoTranslate(text) {
  const toKm = await translateText(text, "km");
  return toKm.detected === "km" ? translateText(text, "en") : toKm;
}
