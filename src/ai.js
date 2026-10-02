/**
 * SaveIt AI -- an AI app inside the bot. Tap "🤖 SaveIt AI" (or /ai) and the
 * keyboard under the message box turns into the AI's own: one button per
 * model, plus 🎨 / 🎵 / new chat / AI Credit / back to the main menu. Then
 * just talk to it:
 *
 *   - text      -> an answer;
 *   - a photo   -> the model looks at it (caption optional);
 *   - "draw…"   -> the model calls create_image and a picture comes back;
 *   - "a song…" -> the model calls create_song: lyrics, then ElevenLabs sings.
 *
 * So every chat model can do everything, the way the Gemini / ChatGPT apps
 * do, without the person having to know which mode to pick. 🎨 and 🎵 stay
 * as direct modes for whoever wants them.
 *
 * Models come from two places:
 *   - 🆓 Gemini Free: Google's own free API tier (GEMINI_API_KEY). Costs no
 *     AI Credit; capped per person per day, because Google's free quota is
 *     one pool for the whole bot.
 *   - everything else through OpenRouter. The buttons aren't hard-coded ids:
 *     each slot is matched against OpenRouter's live catalog and the newest
 *     fit wins, so the menu keeps up with new releases without a deploy.
 *     AI_MODELS overrides that list ("id|Label,id|Label").
 *
 * Every paid use is charged in AI Credit (aiCredits.js) and refunded when it
 * fails. State (model, last few turns) is in memory on purpose: a restart
 * just starts a fresh conversation.
 */
import * as aiCredits from "./aiCredits.js";
import { mainKeyboard } from "./botText.js";
import { config } from "./config.js";
import { call } from "./notifyBot.js";

const API = "https://openrouter.ai/api/v1";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/openai";
const GROQ_API = "https://api.groq.com/openai/v1";

// One button per slot. `match` runs over OpenRouter's ids; among the matches
// the newest (by `created`) is used. `tier` is which AI Credit price it
// charges (aiCredits.costs()); `emoji` is the provider's logo in the custom
// emoji pack (customEmoji.js), the plain glyph in `label` standing in until
// /makeemoji has built it. `best` is what the capability card says it's
// strongest at.
const SLOTS = [
  {
    key: "claude", label: "🧠 Claude", tier: "premium", emoji: "ai_claude",
    best: { km: "សរសេរ · ភាសាខ្មែរល្អ · វិភាគវែងៗ · កូដ", en: "writing · strong Khmer · long analysis · code" },
    match: (id) => /^anthropic\/claude-/.test(id) && !/haiku|:free|:thinking/.test(id),
  },
  {
    key: "gpt", label: "⚡ ChatGPT", tier: "premium", emoji: "ai_openai",
    best: { km: "ចំណេះដឹងទូទៅ · គណិត · ការងារប្រចាំថ្ងៃ", en: "general knowledge · maths · everyday work" },
    match: (id) => /^openai\/gpt-\d/.test(id) && !/mini|nano|oss|audio|image|search|codex|chat|:free/.test(id),
  },
  {
    key: "gemini", label: "💎 Gemini Pro", tier: "premium", emoji: "ai_gemini",
    best: { km: "ចម្លើយលម្អិត · មើលរូប/ឯកសារ · ការគិតស៊ីជម្រៅ", en: "detailed answers · photos & documents · deep reasoning" },
    match: (id) => /^google\/gemini-[\d.]+-pro/.test(id) && !/image|:free/.test(id),
  },
  {
    key: "flash", label: "🚀 Gemini Flash", tier: "cheap", emoji: "ai_gemini",
    best: { km: "លឿនបំផុត · ថោក · សំណួរប្រចាំថ្ងៃ", en: "fastest · cheap · everyday questions" },
    match: (id) => /^google\/gemini-[\d.]+-flash/.test(id) && !/lite|image|:free/.test(id),
  },
  {
    key: "grok", label: "🛰 Grok", tier: "premium", emoji: "ai_grok",
    best: { km: "ឆ្លើយត្រង់ៗ · បែបសប្បាយ · គំនិតច្នៃប្រឌិត", en: "straight answers · playful · creative ideas" },
    match: (id) => /^x-ai\/grok-\d/.test(id) && !/mini|fast|code|vision|:free/.test(id),
  },
  {
    key: "deepseek", label: "🐋 DeepSeek", tier: "cheap", emoji: "ai_deepseek",
    best: { km: "គណិត · ការគិតជាជំហាន · ថោក", en: "maths · step-by-step reasoning · cheap" },
    match: (id) => /^deepseek\/deepseek-/.test(id) && !/distill|coder|prover|:free/.test(id),
  },
];

const IMAGE_SLOT = { key: "image", tier: "image", image: true, match: (id, m) => outputs(m).includes("image") && !/:free/.test(id) };

const GEMINI_FREE = {
  key: "gfree", label: "🆓 Gemini Free", tier: "free", provider: "google", emoji: "ai_gemini", vision: true,
  best: { km: "ឥតគិតថ្លៃ · លឿន · សំណួរប្រចាំថ្ងៃ", en: "free · fast · everyday questions" },
};

// A second, independent free pool (Groq's own, not Google's), so one
// provider cutting its free tier -- it has happened to Gemini's before --
// doesn't take 🆓 down entirely. No logo asset, and its name is kept out of
// the label on purpose: "Groq" (the chip company behind this) reads exactly
// like "Grok" (xAI's paid model, already a button above) at a glance.
const GROQ_FREE = {
  key: "lfree", label: "🆓 Llama Free", tier: "free", provider: "groq", vision: false,
  best: { km: "ឥតគិតថ្លៃ · លឿនបំផុត · ជម្រើសបម្រុង", en: "free · very fast · a backup when Gemini Free is busy" },
};

// The AI keyboard's non-model buttons, both languages (a tap arrives as text).
const BUTTONS = {
  image: { km: "🎨 បង្កើតរូបភាព", en: "🎨 Create image", emoji: null },
  song: { km: "🎵 បង្កើតចម្រៀង", en: "🎵 Create song", emoji: "ai_elevenlabs" },
  new: { km: "🔄 ចាប់ផ្ដើមថ្មី", en: "🔄 New chat", emoji: null },
  credit: { km: "💳 AI Credit", en: "💳 AI Credit", emoji: "credit" },
  menu: { km: "⬅️ ម៉ឺនុយដើម", en: "⬅️ Main menu", emoji: null },
};

// Slash commands that jump straight to a model or mode (see BOT_COMMANDS in
// botText.js for the list Telegram shows).
const COMMANDS = {
  "/gemini_free": "gfree", "/llama_free": "lfree", "/claude": "claude", "/chatgpt": "gpt", "/gpt": "gpt",
  "/gemini": "gemini", "/flash": "flash", "/grok": "grok", "/deepseek": "deepseek", "/image": "image",
  "/song": "song", "/ai_credit": "credit", "/newchat": "new",
};

const SYSTEM_PROMPT = [
  "You are SaveIt AI, the assistant inside the SaveIt Telegram bot, used mostly by people in Cambodia. Today is {date}.",
  "Language: reply in the language the user writes in. If they write Khmer, answer in clear, natural, correct Khmer script (not romanized). If the message is only a photo, answer in {lang}.",
  "Style: accurate, direct and genuinely helpful. Lead with the answer, then the detail that matters. Short paragraphs and simple bullet lists; no tables, no Markdown headings, no **bold** -- Telegram shows plain text.",
  "Photos: look carefully and do what they ask (describe, read the text, solve the problem shown, translate…). With no caption, describe it and anything useful you notice.",
  "{tools}",
  "Honesty: if you're not sure, say so plainly. Never invent facts, prices, laws, phone numbers or links.",
  "Keep answers a phone-screen length unless asked for something long.",
].join("\n");

const TOOLS_PROMPT =
  "You can create pictures and songs with your tools. Call create_image when the user asks you to draw, make, generate or design a picture, photo, logo, poster or illustration. " +
  "Call create_song when they ask you to make, compose or sing a song or music. Write the tool's argument in English with every detail they gave (keep any Khmer lyrics or text exactly as written). " +
  "Don't call a tool for anything else, and don't ask for confirmation first unless the request is genuinely unclear.";

const IMAGE_PROMPT =
  "Create the image the user describes. If the description is in Khmer, follow it faithfully. " +
  "Make it high quality and visually clear. Reply with the image and at most one short sentence.";

const LYRICS_PROMPT = [
  "You write songs for an AI singer. From the user's request, write an original song and return ONLY JSON, no other text:",
  '{"title": string, "styles": [3-6 short English style tags: genre, mood, tempo, instruments, vocal type], "sections": [{"name": "Verse 1"|"Chorus"|..., "lines": [lyric lines]}]}',
  "Lyrics language: the language the user asks for; if they don't say, the language they wrote in. Khmer lyrics must be natural, poetic, correct Khmer script that sings well (no romanization).",
  "If the user pasted their own lyrics, keep them exactly and only split them into sections.",
  "Structure: 4-6 sections (e.g. Verse 1, Chorus, Verse 2, Chorus, Bridge, Chorus), 2-6 short lines each. If the user asked for Khmer or Cambodian style, add a fitting style tag such as \"Cambodian pop\" or \"Khmer traditional\".",
  "Never copy lyrics from existing songs.",
].join("\n");

const SEP = "━━━━━━━━━━━━━━";

const TEXT = {
  km: {
    home: (models, using, free, paid) =>
      `{:sparkle:} SaveIt AI\n${SEP}\n` +
      `💬 សួរអ្វីក៏បាន · សរសេរ · បកប្រែ · កូដ\n` +
      `👁 ផ្ញើរូបមក — AI មើល អាន ដោះស្រាយ\n` +
      `🎨 «គូររូប…» — AI បង្កើតរូបភាព\n` +
      `🎵 «បង្កើតចម្រៀង…» — AI និពន្ធ និងច្រៀង\n` +
      `គ្រាន់តែសរសេរមក — AI យល់ខ្លួនឯងថាត្រូវឆ្លើយ គូរ ឬច្រៀង។\n` +
      `${SEP}\n` +
      `📋 Model · Credit ក្នុងមួយសារ\n${models}\n` +
      `${SEP}\n` +
      `✅ កំពុងប្រើ៖ ${using}\n` +
      `{:gift:} Credit៖ ${free} ឥតគិតថ្លៃថ្ងៃនេះ · 💳 ${paid}\n` +
      `{:bulb:} ប្ដូរ Model ប្រើប៊ូតុងខាងក្រោម · ចុច ⬅️ ម៉ឺនុយដើម ដើម្បីចេញ`,
    freeLine: (n) => `${n} សារ/ថ្ងៃ`,
    card: (label, price, lines, best) =>
      `{:ok:} ${label} · ${price}\n${SEP}\n${lines}\n⭐ ពូកែ៖ ${best}\n${SEP}\nសរសេរ ឬផ្ញើរូបមកបានហើយ។`,
    capChat: "✅ សួរ-ឆ្លើយ · សរសេរ · បកប្រែ · កូដ",
    capVision: "✅ មើលរូប — ផ្ញើរូបមក (ដាក់ caption បើចង់)",
    capNoVision: "➖ មើលរូបមិនបាន — ប្ដូរទៅ Model ផ្សេងដើម្បីផ្ញើរូប",
    capImage: (c) => `✅ គូររូប — សរសេរ «គូររូប…» (+${c} Credit)`,
    capSong: (c) => `✅ បង្កើតចម្រៀង — សរសេរ «បង្កើតចម្រៀង…» (+${c} Credit)`,
    perMsg: (c) => (c ? `${c} Credit/សារ` : "ឥតគិតថ្លៃ"),
    chosenImage: (c) =>
      `{:ok:} 🎨 បង្កើតរូបភាព · ${c} Credit\n\nរៀបរាប់រូបភាពដែលចង់បាន (ឧ. «ឆ្មាពាក់មួកអង្គុយលើប្រាសាទអង្គរវត្ត ពេលថ្ងៃលិច»)។`,
    chosenSong: (c) =>
      `{:ok:} 🎵 បង្កើតចម្រៀង · ${c} Credit\n\n` +
      "ប្រាប់ប្រធានបទ អារម្មណ៍ និងស្ទីលបទ — ឧ. «ចម្រៀងស្នេហាខ្មែរ បែបរ៉ូមែនទិក យឺតៗ អំពីការនឹកផ្ទះនៅខេត្តបាត់ដំបង»។\nឬបិទភ្ជាប់ទំនុកផ្ទាល់ខ្លួនរបស់អ្នក។",
    writing: "{:wait:} កំពុងនិពន្ធទំនុក…",
    singing: "{:wait:} កំពុងផលិតបទចម្រៀង… (អាចចំណាយពេល ១–៣ នាទី)",
    songFailed: "{:fail:} បង្កើតចម្រៀងមិនបានទេ។ Credit ត្រូវបានបង្វិលសងវិញ។ សូមសាកម្ដងទៀត។",
    songTextOnly: "{:fail:} សូមសរសេរពីបទចម្រៀងដែលចង់បាន (មិនមែនរូបភាព)។",
    songOff: "{:fail:} មុខងារបង្កើតចម្រៀងមិនទាន់បើកទេ។",
    imageOff: "{:fail:} មុខងារបង្កើតរូបភាពមិនទាន់បើកទេ។",
    noCredit: (need, free, paid) =>
      `{:fail:} Credit មិនគ្រប់ទេ — ត្រូវការ ${need} Credit (អ្នកមាន 🎁 ${free} + 💳 ${paid})។\n\nទិញ AI Credit បន្ថែម ឬប្ដូរទៅ 🆓 Gemini Free / Model ថោកជាង។`,
    freeLimit: (n, label) => `{:fail:} ${label} អស់ ${n} សារសម្រាប់ថ្ងៃនេះហើយ។ សាក Model ផ្សេង ឬត្រឡប់មកថ្ងៃស្អែក។`,
    freeBusy: (label) => `{:fail:} ${label} ពេញកម្រិតបណ្ដោះអាសន្ន។ រង់ចាំមួយភ្លែត ឬសាក Model ផ្សេង។`,
    thinking: "{:wait:} AI កំពុងគិត…",
    drawing: "{:wait:} កំពុងបង្កើតរូបភាព…",
    failed: "{:fail:} AI ឆ្លើយមិនបានទេ សូមសាកម្ដងទៀត ឬប្ដូរ Model។",
    noImage: "{:fail:} មិនបានបង្កើតរូបភាពទេ សូមសាករៀបរាប់ម្ដងទៀត។ Credit បានបង្វិលសងវិញ។",
    off: "{:fail:} AI មិនទាន់បើកនៅឡើយទេ។",
    cleared: "{:ok:} បានចាប់ផ្ដើមការសន្ទនាថ្មី។",
    noModels: "{:fail:} រក Model មិនឃើញទេ សូមសាកម្ដងទៀតបន្តិចទៀត។",
    noVision: "{:fail:} Model នេះមើលរូបភាពមិនបានទេ — ប្ដូរទៅ 🆓 Gemini Free, Claude, ChatGPT ឬ Gemini។",
    back: "{:ok:} ត្រឡប់មកម៉ឺនុយដើម។",
  },
  en: {
    home: (models, using, free, paid) =>
      `{:sparkle:} SaveIt AI\n${SEP}\n` +
      `💬 Ask anything · write · translate · code\n` +
      `👁 Send a photo — the AI looks, reads, solves\n` +
      `🎨 "Draw…" — the AI makes a picture\n` +
      `🎵 "Make a song…" — the AI writes and sings it\n` +
      `Just write — the AI works out whether to answer, draw or sing.\n` +
      `${SEP}\n` +
      `📋 Model · Credit per message\n${models}\n` +
      `${SEP}\n` +
      `✅ Using: ${using}\n` +
      `{:gift:} Credit: ${free} free today · 💳 ${paid}\n` +
      `{:bulb:} Switch model with the buttons below · ⬅️ Main menu to leave`,
    freeLine: (n) => `${n} messages/day`,
    card: (label, price, lines, best) =>
      `{:ok:} ${label} · ${price}\n${SEP}\n${lines}\n⭐ Best at: ${best}\n${SEP}\nWrite, or send a photo.`,
    capChat: "✅ Questions · writing · translation · code",
    capVision: "✅ Sees photos — send one (caption optional)",
    capNoVision: "➖ Can't see photos — switch model to send one",
    capImage: (c) => `✅ Draws — write "draw…" (+${c} Credit)`,
    capSong: (c) => `✅ Makes songs — write "make a song…" (+${c} Credit)`,
    perMsg: (c) => (c ? `${c} Credit/message` : "free"),
    chosenImage: (c) => `{:ok:} 🎨 Create image · ${c} Credit\n\nDescribe the picture you want (e.g. "a cat in a hat on Angkor Wat at sunset").`,
    chosenSong: (c) =>
      `{:ok:} 🎵 Create song · ${c} Credit\n\n` +
      'Tell me the topic, mood and style — e.g. "a slow romantic Khmer love song about missing home in Battambang".\nOr paste your own lyrics.',
    writing: "{:wait:} Writing the lyrics…",
    singing: "{:wait:} Producing the song… (can take 1–3 minutes)",
    songFailed: "{:fail:} Couldn't create the song. Your Credit was refunded. Please try again.",
    songTextOnly: "{:fail:} Please describe the song you want in text (not a photo).",
    songOff: "{:fail:} Song creation isn't switched on yet.",
    imageOff: "{:fail:} Image creation isn't switched on yet.",
    noCredit: (need, free, paid) =>
      `{:fail:} Not enough Credit — this needs ${need} (you have 🎁 ${free} + 💳 ${paid}).\n\nBuy more AI Credit, or switch to 🆓 Gemini Free / a cheaper model.`,
    freeLimit: (n, label) => `{:fail:} You've used today's ${n} ${label} messages. Try another model, or come back tomorrow.`,
    freeBusy: (label) => `{:fail:} ${label} has hit its limit for now. Wait a moment, or try another model.`,
    thinking: "{:wait:} Thinking…",
    drawing: "{:wait:} Creating the image…",
    failed: "{:fail:} The AI couldn't answer. Please try again or switch model.",
    noImage: "{:fail:} No image came back. Please try describing it again. Your Credit was refunded.",
    off: "{:fail:} AI isn't switched on yet.",
    cleared: "{:ok:} Started a new conversation.",
    noModels: "{:fail:} Couldn't load the models. Please try again in a moment.",
    noVision: "{:fail:} This model can't see photos — switch to 🆓 Gemini Free, Claude, ChatGPT or Gemini.",
    back: "{:ok:} Back to the main menu.",
  },
};

const outputs = (m) => m?.architecture?.output_modalities ?? [];
const inputs = (m) => m?.architecture?.input_modalities ?? [];
const t = (user) => TEXT[user?.language] ?? TEXT.km;
const lang = (user) => (user?.language === "en" ? "en" : "km");
const isAdmin = (chatId) => Boolean(config.telegramAdminChatId) && String(chatId) === String(config.telegramAdminChatId);
const aiOn = () => Boolean(config.openrouterApiKey || config.geminiApiKey || config.groqApiKey);
// Which daily cap a free-tier model draws from -- each provider's free
// quota is its own pool, shared by everyone using the bot.
const freeLimit = (m) => (m.provider === "groq" ? config.aiGroqFreeDaily : config.aiGeminiFreeDaily);

// --------------------------------------------------------------- catalog

let catalog = null;
let catalogAt = 0;
const CATALOG_TTL_MS = 6 * 60 * 60_000;

async function fetchCatalog() {
  if (!config.openrouterApiKey) return [];
  if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  catalog = (await res.json())?.data ?? [];
  catalogAt = Date.now();
  return catalog;
}

let geminiModel = null;
let geminiModelAt = 0;

/** Google's newest stable Flash (or GEMINI_FREE_MODEL), for 🆓 Gemini Free. */
async function geminiFreeModel() {
  if (config.geminiFreeModel) return config.geminiFreeModel;
  if (geminiModel && Date.now() - geminiModelAt < CATALOG_TTL_MS) return geminiModel;
  try {
    const res = await fetch(`${GEMINI_API}/models`, { headers: { authorization: `Bearer ${config.geminiApiKey}` } });
    const ids = ((await res.json())?.data ?? []).map((m) => String(m.id).replace(/^models\//, ""));
    const version = (id) => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
    const flash = ids
      .filter((id) => /^gemini-[\d.]+-flash/.test(id) && !/lite|image|tts|live|audio|exp|thinking|native/.test(id))
      .sort((a, b) => version(b) - version(a) || Number(/preview/.test(a)) - Number(/preview/.test(b)));
    if (flash[0]) {
      geminiModel = flash[0];
      geminiModelAt = Date.now();
    }
  } catch (err) {
    console.error("Gemini model list failed:", err?.message ?? err);
  }
  return geminiModel ?? "gemini-2.5-flash";
}

let groqModel = null;
let groqModelAt = 0;

/** A capable, current Llama on Groq (or GROQ_FREE_MODEL), for 🆓 Llama Free. */
async function groqFreeModel() {
  if (config.groqFreeModel) return config.groqFreeModel;
  if (groqModel && Date.now() - groqModelAt < CATALOG_TTL_MS) return groqModel;
  try {
    const res = await fetch(`${GROQ_API}/models`, { headers: { authorization: `Bearer ${config.groqApiKey}` } });
    const ids = ((await res.json())?.data ?? []).map((m) => String(m.id));
    const bad = /guard|whisper|tts|prompt-guard|moderation|safety/i;
    // "Versatile"/"Maverick"/70B+ reads better than the "instant" 8B tier
    // Groq also offers; that one's for when quality doesn't matter.
    const score = (id) => (/maverick/i.test(id) ? 3 : /70b|versatile|scout/i.test(id) ? 2 : /instant|8b/i.test(id) ? 1 : 1.5);
    const llama = ids.filter((id) => /llama/i.test(id) && !bad.test(id)).sort((a, b) => score(b) - score(a));
    if (llama[0]) {
      groqModel = llama[0];
      groqModelAt = Date.now();
    }
  } catch (err) {
    console.error("Groq model list failed:", err?.message ?? err);
  }
  return groqModel ?? "llama-3.3-70b-versatile";
}

/**
 * The menu: the chat models in button order, then the image model (if any)
 * and the song "model" (if ElevenLabs is set). Each entry: { key, label, id,
 * tier, emoji, vision, provider, image?, song?, best? }.
 */
export async function models() {
  const menu = [];
  if (config.geminiApiKey) menu.push({ ...GEMINI_FREE, id: await geminiFreeModel() });
  if (config.groqApiKey) menu.push({ ...GROQ_FREE, id: await groqFreeModel() });

  const all = await fetchCatalog().catch((err) => {
    console.error("OpenRouter catalog failed:", err?.message ?? err);
    return [];
  });
  const byId = new Map(all.map((m) => [m.id, m]));
  const newestFirst = [...all].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));

  if (config.aiModels.length) {
    config.aiModels.forEach(({ id, label }, i) => {
      const m = byId.get(id);
      const image = outputs(m).includes("image");
      const tier = image ? "image" : /flash|mini|nano|lite|deepseek|haiku/i.test(id) ? "cheap" : "premium";
      menu.push({ key: `c${i}`, label, id, image, tier, vision: inputs(m).includes("image") });
    });
  } else {
    for (const slot of SLOTS) {
      const m = newestFirst.find((x) => slot.match(x.id, x) && outputs(x).includes("text"));
      if (m) menu.push({ ...slot, match: undefined, id: m.id, vision: inputs(m).includes("image") });
    }
    const img = newestFirst.find((x) => IMAGE_SLOT.match(x.id, x));
    if (img) menu.push({ key: "image", label: BUTTONS.image.km, tier: "image", image: true, id: img.id, vision: true });
  }
  if (config.elevenlabsApiKey) menu.push({ key: "song", label: BUTTONS.song.km, tier: "song", song: true, emoji: BUTTONS.song.emoji });
  return menu;
}

const chatModels = (menu) => menu.filter((m) => !m.image && !m.song);
const imageModel = (menu) => menu.find((m) => m.image);

// ----------------------------------------------------------------- state

const sessions = new Map(); // chatId -> { model, history: [{role, content}], at }
// Long, because the AI keyboard stays on screen: someone coming back hours
// later should still be talking to the AI, not get "that isn't a link".
const SESSION_MS = 12 * 60 * 60_000;
const MAX_TURNS = 8;
const freeUses = new Map(); // "<provider>:<userId>" -> { day, count }, one pool per free provider
const noTools = new Set(); // model ids that refused the tools parameter

function session(chatId) {
  const s = sessions.get(chatId);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_MS) {
    sessions.delete(chatId);
    return null;
  }
  return s;
}

/** Whether this chat is in the AI (its next message goes to the model). */
export function isActive(chatId) {
  return Boolean(session(chatId));
}

export function cancel(chatId) {
  sessions.delete(chatId);
}

/** One message on a free model; false once today's per-person cap is used. */
function takeFree(chatId, userId, provider, limit) {
  if (isAdmin(chatId) || !limit) return true;
  const key = `${provider}:${userId}`;
  const day = new Date().toISOString().slice(0, 10);
  const u = freeUses.get(key);
  const count = u?.day === day ? u.count : 0;
  if (count >= limit) return false;
  freeUses.set(key, { day, count: count + 1 });
  return true;
}

function giveBackFree(userId, provider) {
  const u = freeUses.get(`${provider}:${userId}`);
  if (u?.count) u.count -= 1;
}

// ------------------------------------------------------------- keyboards

/** The AI's own keyboard (replaces the main menu while in the AI). */
function aiKeyboard(menu, user) {
  const l = lang(user);
  const btn = (text, emoji) => ({ text, ...(emoji ? { emoji } : {}) });
  const chatMenu = chatModels(menu);
  const chats = chatMenu.map((m) => btn(m.label, m.emoji));
  const rows = [];
  // Every free model gets a row of its own at the top: the ones anyone can
  // use, before the paid ones start pairing up.
  let i = 0;
  while (i < chatMenu.length && chatMenu[i].tier === "free") rows.push([chats[i++]]);
  for (; i < chats.length; i += 2) rows.push(chats.slice(i, i + 2));
  const tools = [];
  if (imageModel(menu)) tools.push(btn(BUTTONS.image[l], BUTTONS.image.emoji));
  if (menu.some((m) => m.song)) tools.push(btn(BUTTONS.song[l], BUTTONS.song.emoji));
  if (tools.length) rows.push(tools);
  rows.push([btn(BUTTONS.new[l]), btn(BUTTONS.credit[l], BUTTONS.credit.emoji)]);
  rows.push([btn(BUTTONS.menu[l])]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

// A tap on the AI keyboard arrives as its label -- or, once a logo icon
// replaced the label's leading emoji, as the label without it.
const bare = (label) => String(label ?? "").trim().replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");

function buttonFor(text, menu) {
  const said = String(text ?? "").trim();
  if (!said) return null;
  for (const m of chatModels(menu)) if (said === m.label || said === bare(m.label)) return m.key;
  for (const [key, b] of Object.entries(BUTTONS)) {
    if ([b.km, b.en].some((label) => said === label || said === bare(label))) return key;
  }
  return null;
}

// --------------------------------------------------------------- screens

async function priceList(menu, c, user) {
  const tx = t(user);
  const price = (m) => (m.tier === "free" ? `${tx.perMsg(0)} (${tx.freeLine(freeLimit(m))})` : `${c[m.tier] ?? 0}`);
  const logo = (m) => (m.emoji ? `{:${m.emoji}:}` : m.label.split(" ")[0]);
  const name = (m) => m.label.replace(/^\S+\s/, "");
  const lines = chatModels(menu).map((m) => `${logo(m)} ${name(m)} — ${price(m)}`);
  const extras = [];
  if (imageModel(menu)) extras.push(`🎨 ${bare(BUTTONS.image[lang(user)])} — ${c.image}`);
  if (menu.some((m) => m.song)) extras.push(`{:ai_elevenlabs:} ${bare(BUTTONS.song[lang(user)])} — ${c.song}`);
  if (extras.length) lines.push(extras.join(" · "));
  return lines.join("\n");
}

/** What one chat model can do, shown when it's picked. */
async function capabilityCard(model, menu, user) {
  const tx = t(user);
  const c = await aiCredits.costs();
  const price = model.tier === "free" ? `${tx.perMsg(0)} · ${tx.freeLine(freeLimit(model))}` : tx.perMsg(c[model.tier] ?? 0);
  const lines = [tx.capChat, model.vision ? tx.capVision : tx.capNoVision];
  if (imageModel(menu)) lines.push(tx.capImage(c.image));
  if (menu.some((m) => m.song)) lines.push(tx.capSong(c.song));
  const best = model.best?.[lang(user)] ?? model.best?.km ?? "—";
  return tx.card(model.label, price, lines.join("\n"), best);
}

async function loadMenu(chatId, user) {
  try {
    const menu = await models();
    if (chatModels(menu).length) return menu;
  } catch (err) {
    console.error("AI models failed:", err?.message ?? err);
  }
  await call("sendMessage", { chat_id: chatId, text: t(user).noModels });
  return null;
}

/** "🤖 SaveIt AI" / /ai: into the AI, on the free (or cheapest) model. */
export async function ask(chatId, user) {
  const tx = t(user);
  if (!aiOn()) return call("sendMessage", { chat_id: chatId, text: tx.off });
  const menu = await loadMenu(chatId, user);
  if (!menu) return null;
  const current = session(chatId)?.model;
  const keep = current && !current.image && !current.song && chatModels(menu).find((m) => m.key === current.key);
  const model = keep ?? chatModels(menu).find((m) => m.tier === "free") ?? chatModels(menu).find((m) => m.tier === "cheap") ?? chatModels(menu)[0];
  if (!keep) sessions.set(chatId, { model, history: [], at: Date.now() });
  const c = await aiCredits.costs();
  const { free, paid } = await aiCredits.balance(user.telegram_user_id).catch(() => ({ free: "?", paid: "?" }));
  return call("sendMessage", {
    chat_id: chatId,
    text: tx.home(await priceList(menu, c, user), model.label, free, paid),
    reply_markup: aiKeyboard(menu, user),
  });
}

async function switchTo(chatId, user, key, menu) {
  const tx = t(user);
  const c = await aiCredits.costs();
  if (key === "image") {
    const model = imageModel(menu);
    if (!model) return call("sendMessage", { chat_id: chatId, text: tx.imageOff });
    sessions.set(chatId, { model, history: [], at: Date.now() });
    return call("sendMessage", { chat_id: chatId, text: tx.chosenImage(c.image), reply_markup: aiKeyboard(menu, user) });
  }
  if (key === "song") {
    const model = menu.find((m) => m.song);
    if (!model) return call("sendMessage", { chat_id: chatId, text: tx.songOff });
    sessions.set(chatId, { model, history: [], at: Date.now() });
    return call("sendMessage", { chat_id: chatId, text: tx.chosenSong(c.song), reply_markup: aiKeyboard(menu, user) });
  }
  const model = chatModels(menu).find((m) => m.key === key);
  if (!model) return call("sendMessage", { chat_id: chatId, text: tx.noModels });
  // Switching model keeps the conversation going, the way an AI app does.
  const history = session(chatId)?.history ?? [];
  sessions.set(chatId, { model, history, at: Date.now() });
  return call("sendMessage", { chat_id: chatId, text: await capabilityCard(model, menu, user), reply_markup: aiKeyboard(menu, user) });
}

/**
 * A tap on the AI keyboard, or one of the AI's slash commands (/claude,
 * /image, …). Returns true when it was one.
 */
export async function handleButton(chatId, user, text) {
  const cmd = COMMANDS[String(text ?? "").trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "")];
  const quick = cmd ?? (Object.values(BUTTONS).some((b) => [b.km, b.en].some((l) => text === l || text === bare(l))) ? "button" : null);
  // Model labels only count while the AI keyboard could be on screen.
  if (!quick && !isActive(chatId) && !/^\S*\s?(Claude|ChatGPT|Gemini|Grok|DeepSeek)\b/.test(bare(text))) return false;

  const tx = t(user);
  if (!aiOn()) {
    if (!quick) return false;
    await call("sendMessage", { chat_id: chatId, text: tx.off });
    return true;
  }
  const menu = await models().catch(() => []);
  const key = cmd ?? buttonFor(text, menu);
  if (!key) return false;

  if (key === "menu") {
    cancel(chatId);
    await call("sendMessage", { chat_id: chatId, text: tx.back, reply_markup: mainKeyboard(user.language) });
    return true;
  }
  if (key === "credit") {
    await aiCredits.showTopUps(chatId, user).catch((err) => console.error("AI Credit screen failed:", err?.message ?? err));
    return true;
  }
  if (key === "new") {
    const s = session(chatId);
    if (s) {
      s.history = [];
      s.at = Date.now();
      await call("sendMessage", { chat_id: chatId, text: tx.cleared });
    } else {
      await ask(chatId, user);
    }
    return true;
  }
  await switchTo(chatId, user, key, menu);
  return true;
}

/** Taps on inline buttons from older AI screens (callback data "ai:..."). */
export async function handleCallback(cq, user) {
  const chatId = cq.message?.chat?.id;
  const [, kind, key] = String(cq.data).split(":");
  await call("answerCallbackQuery", { callback_query_id: cq.id });
  if (!chatId) return true;
  if (kind === "credit") {
    await aiCredits.showTopUps(chatId, user).catch((err) => console.error("AI Credit screen failed:", err?.message ?? err));
  } else if (kind === "m" && key) {
    const menu = await models().catch(() => []);
    await switchTo(chatId, user, key, menu);
  } else if (kind === "new") {
    await handleButton(chatId, user, "/newchat");
  } else {
    await ask(chatId, user);
  }
  return true;
}

// ------------------------------------------------------------- messages

/** Charges `cost`; when there isn't enough, says so and returns null. */
async function pay(chatId, user, cost) {
  const tx = t(user);
  let receipt;
  try {
    receipt = await aiCredits.charge(chatId, user.telegram_user_id, cost);
  } catch (err) {
    console.error("AI Credit charge failed:", err?.message ?? err);
    await call("sendMessage", { chat_id: chatId, text: tx.failed });
    return null;
  }
  if (!receipt) {
    const { free, paid } = await aiCredits.balance(user.telegram_user_id);
    await call("sendMessage", {
      chat_id: chatId,
      text: tx.noCredit(cost, free, paid),
      reply_markup: { inline_keyboard: [[{ text: BUTTONS.credit[lang(user)], style: "success", callback_data: "ai:credit" }]] },
    });
    return null;
  }
  return () => aiCredits.refund(user.telegram_user_id, receipt).catch((err) => console.error("AI Credit refund failed:", err?.message ?? err));
}

async function waiting(chatId, text, action) {
  await call("sendChatAction", { chat_id: chatId, action }).catch(() => {});
  const msg = await call("sendMessage", { chat_id: chatId, text });
  const id = msg?.result?.message_id;
  return () => (id ? call("deleteMessage", { chat_id: chatId, message_id: id }).catch(() => {}) : null);
}

/** 🎨: charge, draw with the image model, send, refund on failure. */
async function runImage(chatId, user, prompt, photo, menu) {
  const tx = t(user);
  const model = imageModel(menu);
  if (!model) {
    await call("sendMessage", { chat_id: chatId, text: tx.imageOff });
    return;
  }
  const refund = await pay(chatId, user, (await aiCredits.costs()).image);
  if (!refund) return;
  const done = await waiting(chatId, tx.drawing, "upload_photo");
  try {
    const content = [{ type: "text", text: prompt }];
    if (photo) content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${photo.toString("base64")}` } });
    const { text: caption, images } = await complete(model, [{ role: "system", content: IMAGE_PROMPT }, { role: "user", content }], { wantImage: true });
    await done();
    if (!images.length) {
      await refund();
      await call("sendMessage", { chat_id: chatId, text: tx.noImage });
      return;
    }
    for (const url of images) await sendDataImage(chatId, url, caption.slice(0, 1000));
  } catch (err) {
    console.error(`AI image (${model.id}) failed:`, err?.message ?? err);
    await done();
    await refund();
    await call("sendMessage", { chat_id: chatId, text: tx.noImage });
  }
}

/** 🎵: charge, write and sing, refund on failure. */
async function runSong(chatId, user, request, menu) {
  const tx = t(user);
  if (!menu.some((m) => m.song)) {
    await call("sendMessage", { chat_id: chatId, text: tx.songOff });
    return;
  }
  const refund = await pay(chatId, user, (await aiCredits.costs()).song);
  if (!refund) return;
  try {
    await makeSong(chatId, request, tx, menu);
  } catch (err) {
    console.error("AI song failed:", err?.message ?? err);
    await refund();
    await call("sendMessage", { chat_id: chatId, text: tx.songFailed });
  }
}

const TOOL_DEFS = (menu) => {
  const defs = [];
  if (imageModel(menu)) {
    defs.push({
      type: "function",
      function: {
        name: "create_image",
        description: "Draw a picture for the user: photo, illustration, logo, poster, etc.",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string", description: "Detailed description of the picture, in English, keeping any text to show exactly." } },
          required: ["prompt"],
        },
      },
    });
  }
  if (menu.some((m) => m.song)) {
    defs.push({
      type: "function",
      function: {
        name: "create_song",
        description: "Compose and sing an original song for the user.",
        parameters: {
          type: "object",
          properties: { request: { type: "string", description: "Topic, mood, genre, language, and any lyrics the user gave (kept exactly)." } },
          required: ["request"],
        },
      },
    });
  }
  return defs;
};

/**
 * A message while in the AI. `photo` is the image's bytes when the message
 * carried one. Returns true when it handled the message.
 */
export async function handleMessage(chatId, user, text, photo) {
  const s = session(chatId);
  if (!s || (!text && !photo)) return false;
  const tx = t(user);
  s.at = Date.now();
  const menu = await models().catch(() => []);

  if (s.model.song) {
    if (!text) await call("sendMessage", { chat_id: chatId, text: tx.songTextOnly });
    else await runSong(chatId, user, text, menu);
    return true;
  }
  if (s.model.image) {
    await runImage(chatId, user, text || "Recreate this picture in high quality.", photo, menu);
    return true;
  }
  if (photo && !s.model.vision) {
    await call("sendMessage", { chat_id: chatId, text: tx.noVision });
    return true;
  }

  // The chat itself: free (within the daily cap) or charged by tier.
  const userId = user.telegram_user_id;
  let refund;
  if (s.model.tier === "free") {
    const limit = freeLimit(s.model);
    if (!takeFree(chatId, userId, s.model.provider, limit)) {
      await call("sendMessage", { chat_id: chatId, text: tx.freeLimit(limit, s.model.label) });
      return true;
    }
    refund = async () => giveBackFree(userId, s.model.provider);
  } else {
    refund = await pay(chatId, user, (await aiCredits.costs())[s.model.tier] ?? 0);
    if (!refund) return true;
  }

  const done = await waiting(chatId, tx.thinking, "typing");
  const content = [];
  if (text) content.push({ type: "text", text });
  if (photo) content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${photo.toString("base64")}` } });
  const tools = TOOL_DEFS(menu);
  const system = SYSTEM_PROMPT.replace("{date}", new Date().toISOString().slice(0, 10))
    .replace("{lang}", lang(user) === "en" ? "English" : "Khmer")
    .replace("{tools}", tools.length ? TOOLS_PROMPT : "");
  const messages = [{ role: "system", content: system }, ...s.history, { role: "user", content }];

  let reply;
  try {
    reply = await complete(s.model, messages, { tools });
  } catch (err) {
    console.error(`AI (${s.model.id}) failed:`, err?.message ?? err);
    await done();
    await refund();
    await call("sendMessage", { chat_id: chatId, text: err?.quota ? tx.freeBusy(s.model.label) : tx.failed });
    return true;
  }
  await done();

  const remember = (answer) => {
    // Photos aren't kept -- re-sending one every turn would multiply the
    // cost; a note that there was one keeps the thread readable.
    s.history.push({ role: "user", content: text || "[photo]" }, { role: "assistant", content: answer });
    s.history = s.history.slice(-MAX_TURNS * 2);
  };

  if (reply.text) {
    for (const part of chunk(reply.text, 4000)) await call("sendMessage", { chat_id: chatId, text: part });
  }
  const tool = reply.toolCalls[0];
  if (tool?.name === "create_image") {
    remember(`${reply.text ? `${reply.text}\n` : ""}[made a picture: ${tool.args.prompt ?? ""}]`);
    await runImage(chatId, user, String(tool.args.prompt || text || ""), photo, menu);
  } else if (tool?.name === "create_song") {
    remember(`${reply.text ? `${reply.text}\n` : ""}[made a song: ${tool.args.request ?? ""}]`);
    await runSong(chatId, user, String(tool.args.request || text || ""), menu);
  } else if (reply.text) {
    remember(reply.text);
  } else {
    await refund();
    await call("sendMessage", { chat_id: chatId, text: tx.failed });
  }
  return true;
}

// ------------------------------------------------------------- providers

/**
 * One chat completion -- OpenRouter, or Google's OpenAI-compatible endpoint
 * for 🆓 Gemini Free. Returns { text, images, toolCalls }. A model that
 * refuses the `tools` parameter is retried without it (and remembered).
 * A rate-limit from Google's free tier throws an error with `quota` set.
 */
// Everything OpenAI-compatible SaveIt AI can talk to. `url`/`key` pick the
// endpoint and credential; `noMaxTokens` is for Gemini's thinking models,
// which count thinking against max_tokens and can come back empty under a
// cap; `label` and `quota429` are for the error a failure throws.
const PROVIDERS = {
  openrouter: {
    url: `${API}/chat/completions`, key: () => config.openrouterApiKey, label: "OpenRouter",
    headers: () => ({ ...(config.publicUrl ? { "HTTP-Referer": config.publicUrl } : {}), "X-Title": "SaveIt Bot" }),
  },
  google: {
    url: `${GEMINI_API}/chat/completions`, key: () => config.geminiApiKey, label: "Gemini",
    headers: () => ({}), noMaxTokens: true, quota429: true,
  },
  groq: {
    url: `${GROQ_API}/chat/completions`, key: () => config.groqApiKey, label: "Groq",
    headers: () => ({}), quota429: true,
  },
};

async function complete(model, messages, { wantImage = false, tools = [] } = {}) {
  const p = PROVIDERS[model.provider] ?? PROVIDERS.openrouter;
  const useTools = tools.length && !wantImage && !noTools.has(model.id);
  const body = {
    model: model.id,
    messages,
    ...(p.noMaxTokens || wantImage ? {} : { max_tokens: 2000 }),
    ...(wantImage ? { modalities: ["image", "text"] } : {}),
    ...(useTools ? { tools, tool_choice: "auto" } : {}),
  };
  const res = await fetch(p.url, {
    method: "POST",
    headers: { authorization: `Bearer ${p.key()}`, "content-type": "application/json", ...p.headers() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.json().catch(() => ({}));
  const data = Array.isArray(raw) ? raw[0] ?? {} : raw;
  if (!res.ok || data.error) {
    const detail = JSON.stringify(data.error ?? data).slice(0, 300);
    if (useTools && res.status >= 400 && res.status < 500 && /tool|function/i.test(detail)) {
      noTools.add(model.id);
      return complete(model, messages, { wantImage, tools: [] });
    }
    const err = new Error(`${p.label} ${res.status}: ${detail}`);
    if (p.quota429 && res.status === 429) err.quota = true;
    throw err;
  }
  const message = data.choices?.[0]?.message ?? {};
  const text = typeof message.content === "string"
    ? message.content
    : (message.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
  const images = (message.images ?? []).map((img) => img?.image_url?.url).filter(Boolean);
  const toolCalls = (message.tool_calls ?? [])
    .map((tc) => {
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        args = {};
      }
      return { name: tc.function?.name, args };
    })
    .filter((tc) => tc.name);
  return { text: String(text ?? "").trim(), images, toolCalls };
}

/** Sends a data: (or https:) image URL as a photo -- sendPhoto's JSON body can't carry bytes. */
async function sendDataImage(chatId, url, caption) {
  if (/^https?:/.test(url)) return call("sendPhoto", { chat_id: chatId, photo: url, caption });
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (!match) return null;
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  form.set("photo", new Blob([Buffer.from(match[2], "base64")], { type: match[1] }), "image.png");
  const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/sendPhoto`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error("Telegram sendPhoto failed:", JSON.stringify(data).slice(0, 300));
  return data;
}

// ------------------------------------------------------------------ songs

const ELEVEN_API = "https://api.elevenlabs.io/v1";

/**
 * 🎵: a text model writes the lyrics (as JSON sections), ElevenLabs sings
 * them. The lyrics go out first, so the wait for the audio has something
 * to read. Throws on any failure -- the caller refunds.
 */
async function makeSong(chatId, request, tx, menu) {
  const wait = await call("sendMessage", { chat_id: chatId, text: tx.writing });
  const waitId = wait?.result?.message_id;
  const say = (text) =>
    waitId ? call("editMessageText", { chat_id: chatId, message_id: waitId, text }).catch(() => {}) : null;

  const writer = ["claude", "gemini", "gpt", "flash", "gfree"].map((k) => menu.find((m) => m.key === k)).find(Boolean)
    ?? chatModels(menu)[0];
  if (!writer) throw new Error("no text model for lyrics");
  const { text: raw } = await complete(writer, [{ role: "system", content: LYRICS_PROMPT }, { role: "user", content: request }]);
  const song = parseSong(raw);

  const lyrics = song.sections.map((sec) => `[${sec.name}]\n${sec.lines.join("\n")}`).join("\n\n");
  await call("sendMessage", { chat_id: chatId, text: `🎵 ${song.title}\n\n${lyrics}`.slice(0, 4000) });
  await say(tx.singing);
  await call("sendChatAction", { chat_id: chatId, action: "upload_voice" }).catch(() => {});

  const audio = await compose(song);
  if (waitId) await call("deleteMessage", { chat_id: chatId, message_id: waitId }).catch(() => {});
  const sent = await sendAudio(chatId, audio, song.title);
  if (!sent?.ok) throw new Error(`sendAudio failed: ${JSON.stringify(sent).slice(0, 200)}`);
}

/** The model's JSON (tolerating a ```json fence around it) as a clean song. */
function parseSong(raw) {
  const json = /\{[\s\S]*\}/.exec(String(raw ?? ""))?.[0];
  if (!json) throw new Error("lyrics weren't JSON");
  const data = JSON.parse(json);
  const sections = (data.sections ?? [])
    .map((sec) => ({
      name: String(sec?.name ?? "Verse").slice(0, 40),
      lines: (sec?.lines ?? []).map((l) => String(l).trim()).filter(Boolean).slice(0, 12),
    }))
    .filter((sec) => sec.lines.length)
    .slice(0, 8);
  if (!sections.length) throw new Error("no lyrics");
  const styles = (data.styles ?? []).map(String).filter(Boolean).slice(0, 8);
  return { title: String(data.title ?? "SaveIt Song").slice(0, 100), styles, sections };
}

/**
 * ElevenLabs Music. The composition plan carries the lyrics section by
 * section; if it's refused (the plan schema is the stricter of the two),
 * the same song goes again as one plain prompt with the lyrics inside.
 */
async function compose(song) {
  const totalMs = Math.min(Math.max(config.aiSongSeconds, 30), 300) * 1000;
  const perSection = Math.max(Math.floor(totalMs / song.sections.length), 3000);
  const plan = {
    positive_global_styles: song.styles,
    negative_global_styles: [],
    sections: song.sections.map((sec) => ({
      section_name: sec.name,
      positive_local_styles: [],
      negative_local_styles: [],
      duration_ms: perSection,
      lines: sec.lines,
    })),
  };
  try {
    return await elevenMusic({ composition_plan: plan, model_id: "music_v1" });
  } catch (err) {
    if (!/ 4\d\d:/.test(String(err?.message))) throw err;
    console.error("ElevenLabs plan refused, retrying as a prompt:", err.message);
    const lyrics = song.sections.map((sec) => `[${sec.name}]\n${sec.lines.join("\n")}`).join("\n\n");
    const prompt = `${song.styles.join(", ")}. Sing these lyrics exactly:\n\n${lyrics}`.slice(0, 4000);
    return elevenMusic({ prompt, music_length_ms: totalMs, model_id: "music_v1" });
  }
}

async function elevenMusic(body) {
  const res = await fetch(`${ELEVEN_API}/music?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": config.elevenlabsApiKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6 * 60_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000) throw new Error("ElevenLabs returned no audio");
  return audio;
}

async function sendAudio(chatId, buffer, title) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("title", title);
  form.set("performer", "SaveIt AI");
  form.set("audio", new Blob([buffer], { type: "audio/mpeg" }), `${title.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "song"}.mp3`);
  const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/sendAudio`, { method: "POST", body: form });
  return res.json().catch(() => ({}));
}

/** Splits text into Telegram-sized pieces, preferring paragraph breaks. */
function chunk(text, size) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** /aimodels for the operator: which model each button uses right now. */
export async function describeModels() {
  if (!aiOn()) return "⚠️ None of OPENROUTER_API_KEY, GEMINI_API_KEY or GROQ_API_KEY is set.";
  const menu = await models();
  const c = await aiCredits.costs();
  const price = (m) => (m.tier === "free" ? `free, ${freeLimit(m)}/person/day` : `${c[m.tier]} Credit`);
  const source = (m) => (m.song ? "ElevenLabs music_v1" : m.provider ? `${PROVIDERS[m.provider]?.label ?? m.provider} ${m.id}` : m.id);
  const lines = menu.map((m) => `${m.label} · ${price(m)}\n  ${source(m)}${noTools.has(m.id) ? " (no tools)" : ""}`);
  const off = [];
  if (!config.geminiApiKey) off.push("🆓 Gemini Free off: GEMINI_API_KEY not set");
  if (!config.groqApiKey) off.push("🆓 Llama Free off: GROQ_API_KEY not set");
  if (!config.openrouterApiKey) off.push("Paid models off: OPENROUTER_API_KEY not set");
  if (!config.elevenlabsApiKey) off.push("🎵 off: ELEVENLABS_API_KEY not set");
  return lines.length
    ? `${lines.join("\n")}\n\nFree a day: ${config.aiFreeDaily} Credit${off.length ? `\n${off.join("\n")}` : ""}`
    : "⚠️ No models matched.";
}
