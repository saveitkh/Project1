/**
 * SaveIt AI: tap "🤖 AI", pick a model, then send text or a photo (with or
 * without a caption) and get the answer back -- or pick the image model and
 * describe a picture to have it drawn, or tap 🎵 and describe a song to have
 * it written (lyrics by a text model) and sung (ElevenLabs Music).
 *
 * Every use is paid for in AI Credit (aiCredits.js): a few free a day, then
 * bought Credit -- a cheap model costs less than a premium one, and a
 * failed answer is refunded.
 *
 * Everything goes through OpenRouter (one key, every provider). The model
 * buttons aren't hard-coded ids: each slot below is matched against
 * OpenRouter's live catalog and the newest model that fits it wins, so the
 * menu keeps up with new releases without a deploy. AI_MODELS overrides the
 * whole list ("id|Label,id|Label") when the operator wants specific ones.
 *
 * State (chosen model, the last few turns) is in memory on purpose: a
 * restart just means the next message starts a fresh conversation.
 */
import * as aiCredits from "./aiCredits.js";
import { config } from "./config.js";
import { call } from "./notifyBot.js";

const API = "https://openrouter.ai/api/v1";

// One button per slot. `match` runs over the catalog's ids; among the
// matches the newest (by OpenRouter's `created`) is used. `image: true`
// means the slot draws pictures instead of answering in text; `tier` is
// which AI Credit price it charges (aiCredits.costs()).
const SLOTS = [
  { key: "claude", label: "🧠 Claude", tier: "premium", match: (id) => /^anthropic\/claude-/.test(id) && !/haiku|:free|:thinking/.test(id) },
  { key: "gpt", label: "⚡ ChatGPT", tier: "premium", match: (id) => /^openai\/gpt-\d/.test(id) && !/mini|nano|oss|audio|image|search|codex|chat|:free/.test(id) },
  { key: "gemini", label: "💎 Gemini Pro", tier: "premium", match: (id) => /^google\/gemini-[\d.]+-pro/.test(id) && !/image|:free/.test(id) },
  { key: "flash", label: "🚀 Gemini Flash", tier: "cheap", match: (id) => /^google\/gemini-[\d.]+-flash/.test(id) && !/lite|image|:free/.test(id) },
  { key: "grok", label: "🛰 Grok", tier: "premium", match: (id) => /^x-ai\/grok-\d/.test(id) && !/mini|fast|code|vision|:free/.test(id) },
  { key: "deepseek", label: "🐋 DeepSeek", tier: "cheap", match: (id) => /^deepseek\/deepseek-/.test(id) && !/distill|coder|prover|:free/.test(id) },
  { key: "image", label: "🎨 បង្កើតរូបភាព · Create image", tier: "image", image: true, match: (id, m) => outputs(m).includes("image") && !/:free/.test(id) },
];

const SYSTEM_PROMPT = [
  "You are SaveIt AI, the assistant inside the SaveIt Telegram bot, used mostly by people in Cambodia.",
  "Language: reply in the language the user writes in. If they write Khmer, answer in clear, natural, correct Khmer script (not romanized). If the message is only a photo, answer in {lang}.",
  "Style: be accurate, direct and genuinely helpful. Lead with the answer, then the detail that matters. Use short paragraphs and simple bullet lists; no tables, no Markdown headings, no **bold** -- Telegram shows plain text.",
  "Photos: when the user sends an image, look at it carefully and do what they ask (describe it, read the text in it, solve the problem shown, translate it, etc.). If there's no caption, describe what is in it and anything useful you notice.",
  "Honesty: if you're not sure, say so plainly instead of guessing. Never invent facts, prices, laws, phone numbers or links.",
  "Keep answers a reasonable length for a phone screen unless the user asks for something long.",
].join("\n");

const IMAGE_PROMPT =
  "Create the image the user describes. If the description is in Khmer, follow it faithfully. " +
  "Make it high quality and visually clear. Reply with the image and at most one short sentence.";

// The song button isn't an OpenRouter model: lyrics come from the best text
// model in the menu, the music from ElevenLabs.
const SONG = { key: "song", label: "🎵 បង្កើតចម្រៀង · Create song", tier: "song", song: true };

const LYRICS_PROMPT = [
  "You write songs for an AI singer. From the user's request, write an original song and return ONLY JSON, no other text:",
  '{"title": string, "styles": [3-6 short English style tags: genre, mood, tempo, instruments, vocal type], "sections": [{"name": "Verse 1"|"Chorus"|..., "lines": [lyric lines]}]}',
  "Lyrics language: the language the user asks for; if they don't say, the language they wrote in. Khmer lyrics must be natural, poetic, correct Khmer script that sings well (no romanization).",
  "If the user pasted their own lyrics, keep them exactly and only split them into sections.",
  "Structure: 4-6 sections (e.g. Verse 1, Chorus, Verse 2, Chorus, Bridge, Chorus), 2-6 short lines each. If the user asked for Khmer or Cambodian style, add a fitting style tag such as \"Cambodian pop\" or \"Khmer traditional\".",
  "Never copy lyrics from existing songs.",
].join("\n");

const TEXT = {
  km: {
    pick:
      "{:sparkle:} SaveIt AI\n\n" +
      "ជ្រើសរើស Model ខាងក្រោម រួចផ្ញើ៖\n" +
      "• អត្ថបទ — សួរអ្វីក៏បាន សរសេរ បកប្រែ ពន្យល់…\n" +
      "• រូបភាព — (ដាក់ caption បើចង់) ឲ្យ AI មើល អាន ឬដោះស្រាយ\n" +
      "• 🎨 បង្កើតរូបភាព — រៀបរាប់រូបដែលចង់បាន\n" +
      "• 🎵 បង្កើតចម្រៀង — ប្រាប់ប្រធានបទ និងស្ទីលបទចម្រៀង\n\n" +
      "ចុចប៊ូតុងម៉ឺនុយណាមួយដើម្បីចេញ។",
    balance: (free, paid) => `\n\n{:sparkle:} Credit៖ 🎁 ${free} ឥតគិតថ្លៃថ្ងៃនេះ · 💳 ${paid}`,
    creditButton: "💳 AI Credit · ទិញបន្ថែម",
    chosenSong:
      "{:ok:} បានជ្រើស 🎵 បង្កើតចម្រៀង\n\n" +
      "ប្រាប់ប្រធានបទ អារម្មណ៍ និងស្ទីលបទ — ឧ. «ចម្រៀងស្នេហាខ្មែរ បែបរ៉ូមែនទិក យឺតៗ អំពីការនឹកផ្ទះនៅខេត្តបាត់ដំបង»។\n" +
      "ឬបិទភ្ជាប់ទំនុកផ្ទាល់ខ្លួនរបស់អ្នក។",
    writing: "{:wait:} កំពុងនិពន្ធទំនុក…",
    singing: "{:wait:} កំពុងផលិតបទចម្រៀង… (អាចចំណាយពេល ១–៣ នាទី)",
    songFailed: "{:fail:} បង្កើតចម្រៀងមិនបានទេ។ Credit ត្រូវបានបង្វិលសងវិញ។ សូមសាកម្ដងទៀត។",
    songTextOnly: "{:fail:} សូមសរសេរពីបទចម្រៀងដែលចង់បាន (មិនមែនរូបភាព)។",
    noCredit: (need, free, paid) =>
      `{:fail:} Credit មិនគ្រប់ទេ — ត្រូវការ ${need} Credit (អ្នកមាន 🎁 ${free} + 💳 ${paid})។\n\nទិញ AI Credit បន្ថែម ឬសាក Model ថោកជាង (🚀 Gemini Flash · 🐋 DeepSeek)។`,
    chosen: (label) => `{:ok:} បានជ្រើស ${label}\n\nផ្ញើអត្ថបទ ឬរូបភាពមកបានហើយ។`,
    chosenImage: "{:ok:} បានជ្រើស 🎨 បង្កើតរូបភាព\n\nរៀបរាប់រូបភាពដែលចង់បាន (ឧ. «ឆ្មាពាក់មួកអង្គុយលើប្រាសាទអង្គរវត្ត ពេលថ្ងៃលិច»)។",
    thinking: "{:wait:} AI កំពុងគិត…",
    drawing: "{:wait:} កំពុងបង្កើតរូបភាព…",
    failed: "{:fail:} AI ឆ្លើយមិនបានទេ សូមសាកម្ដងទៀត ឬជ្រើស Model ផ្សេង។",
    noImage: "{:fail:} Model នេះមិនបានបង្កើតរូបភាពទេ សូមសាករៀបរាប់ម្ដងទៀត។",
    off: "{:fail:} AI មិនទាន់បើកនៅឡើយទេ។",
    newChat: "🔄 ចាប់ផ្ដើមថ្មី",
    changeModel: "🔁 ប្ដូរ Model",
    cleared: "{:ok:} បានចាប់ផ្ដើមការសន្ទនាថ្មី។",
    noModels: "{:fail:} រក Model មិនឃើញទេ សូមសាកម្ដងទៀតបន្តិចទៀត។",
    noVision: "{:fail:} Model នេះមើលរូបភាពមិនបានទេ សូមជ្រើស Claude, ChatGPT ឬ Gemini។",
  },
  en: {
    pick:
      "{:sparkle:} SaveIt AI\n\n" +
      "Pick a model below, then send:\n" +
      "• Text — ask anything, write, translate, explain…\n" +
      "• A photo — (add a caption if you like) for the AI to look at, read or solve\n" +
      "• 🎨 Create image — describe the picture you want\n" +
      "• 🎵 Create song — tell it the topic and style\n\n" +
      "Tap any menu button to leave.",
    balance: (free, paid) => `\n\n{:sparkle:} Credit: 🎁 ${free} free today · 💳 ${paid}`,
    creditButton: "💳 AI Credit · Buy more",
    chosenSong:
      "{:ok:} 🎵 Create song selected\n\n" +
      "Tell me the topic, mood and style — e.g. \"a slow romantic Khmer love song about missing home in Battambang\".\n" +
      "Or paste your own lyrics.",
    writing: "{:wait:} Writing the lyrics…",
    singing: "{:wait:} Producing the song… (can take 1–3 minutes)",
    songFailed: "{:fail:} Couldn't create the song. Your Credit was refunded. Please try again.",
    songTextOnly: "{:fail:} Please describe the song you want in text (not a photo).",
    noCredit: (need, free, paid) =>
      `{:fail:} Not enough Credit — this needs ${need} (you have 🎁 ${free} + 💳 ${paid}).\n\nBuy more AI Credit, or try a cheaper model (🚀 Gemini Flash · 🐋 DeepSeek).`,
    chosen: (label) => `{:ok:} ${label} selected\n\nSend your text or photo.`,
    chosenImage: "{:ok:} 🎨 Create image selected\n\nDescribe the picture you want (e.g. \"a cat in a hat sitting on Angkor Wat at sunset\").",
    thinking: "{:wait:} Thinking…",
    drawing: "{:wait:} Creating the image…",
    failed: "{:fail:} The AI couldn't answer. Please try again or pick another model.",
    noImage: "{:fail:} The model didn't return an image. Please try describing it again.",
    off: "{:fail:} AI isn't switched on yet.",
    newChat: "🔄 New chat",
    changeModel: "🔁 Change model",
    cleared: "{:ok:} Started a new conversation.",
    noModels: "{:fail:} Couldn't load the models. Please try again in a moment.",
    noVision: "{:fail:} This model can't see photos. Please pick Claude, ChatGPT or Gemini.",
  },
};

const outputs = (m) => m?.architecture?.output_modalities ?? [];
const inputs = (m) => m?.architecture?.input_modalities ?? [];

// --------------------------------------------------------------- catalog

let catalog = null;
let catalogAt = 0;
const CATALOG_TTL_MS = 6 * 60 * 60_000;

async function fetchCatalog() {
  if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  catalog = (await res.json())?.data ?? [];
  catalogAt = Date.now();
  return catalog;
}

/** The model menu: [{ key, label, id, image, vision }]. */
export async function models() {
  const all = await fetchCatalog();
  const byId = new Map(all.map((m) => [m.id, m]));
  if (config.aiModels.length) {
    const menu = config.aiModels.map(({ id, label }, i) => {
      const m = byId.get(id);
      const image = outputs(m).includes("image");
      const tier = image ? "image" : /flash|mini|nano|lite|deepseek|haiku/i.test(id) ? "cheap" : "premium";
      return { key: `c${i}`, label, id, image, tier, vision: inputs(m).includes("image") };
    });
    return config.elevenlabsApiKey ? [...menu, SONG] : menu;
  }
  const newestFirst = [...all].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const menu = [];
  for (const slot of SLOTS) {
    const m = newestFirst.find((x) => slot.match(x.id, x) && (slot.image || outputs(x).includes("text")));
    if (m) menu.push({ key: slot.key, label: slot.label, id: m.id, tier: slot.tier, image: Boolean(slot.image), vision: inputs(m).includes("image") });
  }
  if (config.elevenlabsApiKey) menu.push(SONG);
  return menu;
}

// ----------------------------------------------------------------- state

const sessions = new Map(); // chatId -> { model, history: [{role, content}], at }
const SESSION_MS = 30 * 60_000;
const MAX_TURNS = 8;

function session(chatId) {
  const s = sessions.get(chatId);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_MS) {
    sessions.delete(chatId);
    return null;
  }
  return s;
}

/** Whether a model is chosen and waiting for this chat's next message. */
export function isActive(chatId) {
  return Boolean(session(chatId));
}

export function cancel(chatId) {
  sessions.delete(chatId);
}

// ------------------------------------------------------------------- flow

const t = (user) => TEXT[user?.language] ?? TEXT.km;

/** "🤖 AI" tapped: the model picker. */
export async function ask(chatId, user) {
  const tx = t(user);
  if (!config.openrouterApiKey) return call("sendMessage", { chat_id: chatId, text: tx.off });
  let menu;
  try {
    menu = await models();
  } catch (err) {
    console.error("AI models failed:", err?.message ?? err);
    return call("sendMessage", { chat_id: chatId, text: tx.noModels });
  }
  if (!menu.length) return call("sendMessage", { chat_id: chatId, text: tx.noModels });
  const c = await aiCredits.costs();
  const button = (m) => ({ text: `${m.label} · ${c[m.tier] ?? 0}`, callback_data: `ai:m:${m.key}` });
  const rows = [];
  const textModels = menu.filter((m) => !m.image && !m.song);
  for (let i = 0; i < textModels.length; i += 2) rows.push(textModels.slice(i, i + 2).map(button));
  for (const m of menu.filter((x) => x.image || x.song)) rows.push([button(m)]);
  rows.push([{ text: tx.creditButton, style: "success", callback_data: "ai:credit" }]);
  const { free, paid } = await aiCredits.balance(user.telegram_user_id).catch(() => ({ free: "?", paid: "?" }));
  return call("sendMessage", { chat_id: chatId, text: tx.pick + tx.balance(free, paid), reply_markup: { inline_keyboard: rows } });
}

const sessionKeyboard = (tx) => ({
  inline_keyboard: [
    [
      { text: tx.newChat, callback_data: "ai:new" },
      { text: tx.changeModel, callback_data: "ai:pick" },
    ],
  ],
});

const creditKeyboard = (tx) => ({
  inline_keyboard: [
    [{ text: tx.creditButton, style: "success", callback_data: "ai:credit" }],
    [{ text: tx.changeModel, callback_data: "ai:pick" }],
  ],
});

/** Taps on the picker / session buttons (callback data "ai:..."). */
export async function handleCallback(cq, user) {
  const chatId = cq.message?.chat?.id;
  const tx = t(user);
  const [, kind, key] = String(cq.data).split(":");
  await call("answerCallbackQuery", { callback_query_id: cq.id });
  if (!chatId) return true;

  if (kind === "pick") {
    await ask(chatId, user);
    return true;
  }
  if (kind === "credit") {
    await aiCredits.showTopUps(chatId, user).catch((err) => console.error("AI Credit screen failed:", err?.message ?? err));
    return true;
  }
  if (kind === "new") {
    const s = session(chatId);
    if (s) {
      s.history = [];
      s.at = Date.now();
    }
    await call("sendMessage", { chat_id: chatId, text: tx.cleared });
    return true;
  }
  if (kind === "m") {
    const model = (await models().catch(() => [])).find((m) => m.key === key);
    if (!model) {
      await call("sendMessage", { chat_id: chatId, text: tx.noModels });
      return true;
    }
    sessions.set(chatId, { model, history: [], at: Date.now() });
    const text = model.song ? tx.chosenSong : model.image ? tx.chosenImage : tx.chosen(model.label);
    await call("sendMessage", { chat_id: chatId, text });
    return true;
  }
  return true;
}

/**
 * A message while a model is chosen. `photo` is the image's bytes when the
 * message carried one. Returns true when it handled the message.
 */
export async function handleMessage(chatId, user, text, photo) {
  const s = session(chatId);
  if (!s || (!text && !photo)) return false;
  const tx = t(user);
  s.at = Date.now();

  if (s.model.song && !text) {
    await call("sendMessage", { chat_id: chatId, text: tx.songTextOnly });
    return true;
  }
  if (photo && !s.model.image && !s.model.song && !s.model.vision) {
    await call("sendMessage", { chat_id: chatId, text: tx.noVision, reply_markup: sessionKeyboard(tx) });
    return true;
  }

  const userId = user.telegram_user_id;
  const cost = (await aiCredits.costs())[s.model.tier] ?? 0;
  let receipt;
  try {
    receipt = await aiCredits.charge(chatId, userId, cost);
  } catch (err) {
    console.error("AI Credit charge failed:", err?.message ?? err);
    await call("sendMessage", { chat_id: chatId, text: tx.failed });
    return true;
  }
  if (!receipt) {
    const { free, paid } = await aiCredits.balance(userId);
    await call("sendMessage", { chat_id: chatId, text: tx.noCredit(cost, free, paid), reply_markup: creditKeyboard(tx) });
    return true;
  }
  const refund = () => aiCredits.refund(userId, receipt).catch((err) => console.error("AI Credit refund failed:", err?.message ?? err));

  if (s.model.song) {
    try {
      await makeSong(chatId, user, text, tx);
    } catch (err) {
      console.error("AI song failed:", err?.message ?? err);
      await refund();
      await call("sendMessage", { chat_id: chatId, text: tx.songFailed });
    }
    return true;
  }

  await call("sendChatAction", { chat_id: chatId, action: s.model.image ? "upload_photo" : "typing" }).catch(() => {});
  const waitMsg = await call("sendMessage", { chat_id: chatId, text: s.model.image ? tx.drawing : tx.thinking });
  const dropWait = () =>
    waitMsg?.result?.message_id
      ? call("deleteMessage", { chat_id: chatId, message_id: waitMsg.result.message_id }).catch(() => {})
      : null;

  const content = [];
  if (text) content.push({ type: "text", text });
  if (photo) content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${photo.toString("base64")}` } });
  const userTurn = { role: "user", content };

  try {
    if (s.model.image) {
      const { text: caption, images } = await complete(s.model, [{ role: "system", content: IMAGE_PROMPT }, userTurn], true);
      await dropWait();
      if (!images.length) {
        await refund();
        await call("sendMessage", { chat_id: chatId, text: tx.noImage });
        return true;
      }
      for (const url of images) await sendDataImage(chatId, url, caption.slice(0, 1000));
      return true;
    }

    const lang = user?.language === "en" ? "English" : "Khmer";
    const messages = [{ role: "system", content: SYSTEM_PROMPT.replace("{lang}", lang) }, ...s.history, userTurn];
    const { text: answer } = await complete(s.model, messages, false);
    await dropWait();
    if (!answer) throw new Error("empty answer");
    // Photos aren't kept in the history -- re-sending one every turn would
    // multiply the cost; a note that there was one keeps the thread readable.
    s.history.push({ role: "user", content: text || "[photo]" }, { role: "assistant", content: answer });
    s.history = s.history.slice(-MAX_TURNS * 2);
    const parts = chunk(answer, 4000);
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await call("sendMessage", { chat_id: chatId, text: parts[i], ...(last ? { reply_markup: sessionKeyboard(tx) } : {}) });
    }
  } catch (err) {
    console.error(`AI (${s.model.id}) failed:`, err?.message ?? err);
    await refund();
    await dropWait();
    await call("sendMessage", { chat_id: chatId, text: tx.failed });
  }
  return true;
}

// ------------------------------------------------------------- OpenRouter

async function complete(model, messages, wantImage) {
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openrouterApiKey}`,
      "content-type": "application/json",
      ...(config.publicUrl ? { "HTTP-Referer": config.publicUrl } : {}),
      "X-Title": "SaveIt Bot",
    },
    body: JSON.stringify({
      model: model.id,
      messages,
      max_tokens: wantImage ? undefined : 2000,
      ...(wantImage ? { modalities: ["image", "text"] } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  const message = data.choices?.[0]?.message ?? {};
  const text = typeof message.content === "string"
    ? message.content
    : (message.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
  const images = (message.images ?? []).map((img) => img?.image_url?.url).filter(Boolean);
  return { text: String(text ?? "").trim(), images };
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
async function makeSong(chatId, user, request, tx) {
  const wait = await call("sendMessage", { chat_id: chatId, text: tx.writing });
  const waitId = wait?.result?.message_id;
  const say = (text) =>
    waitId ? call("editMessageText", { chat_id: chatId, message_id: waitId, text }).catch(() => {}) : null;

  const menu = await models();
  const writer = ["claude", "gemini", "gpt", "flash"].map((k) => menu.find((m) => m.key === k)).find(Boolean)
    ?? menu.find((m) => !m.image && !m.song);
  if (!writer) throw new Error("no text model for lyrics");
  const { text: raw } = await complete(writer, [{ role: "system", content: LYRICS_PROMPT }, { role: "user", content: request }], false);
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
  if (!config.openrouterApiKey) return "⚠️ OPENROUTER_API_KEY is not set.";
  const menu = await models();
  const c = await aiCredits.costs();
  const lines = menu.map((m) => `${m.label} · ${c[m.tier]} Credit\n  ${m.song ? "ElevenLabs music_v1" : m.id}`);
  return lines.length
    ? `${lines.join("\n")}\n\nFree a day: ${config.aiFreeDaily} Credit${config.elevenlabsApiKey ? "" : "\n🎵 off: ELEVENLABS_API_KEY not set"}`
    : "⚠️ No models matched.";
}
