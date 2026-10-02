/**
 * SaveIt AI: tap "🤖 AI", pick a model, then send text or a photo (with or
 * without a caption) and get the answer back -- or pick the image model and
 * describe a picture to have it drawn.
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
import { config } from "./config.js";
import { call } from "./notifyBot.js";

const API = "https://openrouter.ai/api/v1";

// One button per slot. `match` runs over the catalog's ids; among the
// matches the newest (by OpenRouter's `created`) is used. `image: true`
// means the slot draws pictures instead of answering in text.
const SLOTS = [
  { key: "claude", label: "🧠 Claude", match: (id) => /^anthropic\/claude-/.test(id) && !/haiku|:free|:thinking/.test(id) },
  { key: "gpt", label: "⚡ ChatGPT", match: (id) => /^openai\/gpt-\d/.test(id) && !/mini|nano|oss|audio|image|search|codex|chat|:free/.test(id) },
  { key: "gemini", label: "💎 Gemini Pro", match: (id) => /^google\/gemini-[\d.]+-pro/.test(id) && !/image|:free/.test(id) },
  { key: "flash", label: "🚀 Gemini Flash", match: (id) => /^google\/gemini-[\d.]+-flash/.test(id) && !/lite|image|:free/.test(id) },
  { key: "grok", label: "🛰 Grok", match: (id) => /^x-ai\/grok-\d/.test(id) && !/mini|fast|code|vision|:free/.test(id) },
  { key: "deepseek", label: "🐋 DeepSeek", match: (id) => /^deepseek\/deepseek-/.test(id) && !/distill|coder|prover|:free/.test(id) },
  { key: "image", label: "🎨 បង្កើតរូបភាព · Create image", image: true, match: (id, m) => outputs(m).includes("image") && !/:free/.test(id) },
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

const TEXT = {
  km: {
    pick:
      "{:sparkle:} SaveIt AI\n\n" +
      "ជ្រើសរើស Model ខាងក្រោម រួចផ្ញើ៖\n" +
      "• អត្ថបទ — សួរអ្វីក៏បាន សរសេរ បកប្រែ ពន្យល់…\n" +
      "• រូបភាព — (ដាក់ caption បើចង់) ឲ្យ AI មើល អាន ឬដោះស្រាយ\n" +
      "• 🎨 បង្កើតរូបភាព — រៀបរាប់រូបដែលចង់បាន\n\n" +
      "ចុចប៊ូតុងម៉ឺនុយណាមួយដើម្បីចេញ។",
    chosen: (label) => `{:ok:} បានជ្រើស ${label}\n\nផ្ញើអត្ថបទ ឬរូបភាពមកបានហើយ។`,
    chosenImage: "{:ok:} បានជ្រើស 🎨 បង្កើតរូបភាព\n\nរៀបរាប់រូបភាពដែលចង់បាន (ឧ. «ឆ្មាពាក់មួកអង្គុយលើប្រាសាទអង្គរវត្ត ពេលថ្ងៃលិច»)។",
    thinking: "{:wait:} AI កំពុងគិត…",
    drawing: "{:wait:} កំពុងបង្កើតរូបភាព…",
    failed: "{:fail:} AI ឆ្លើយមិនបានទេ សូមសាកម្ដងទៀត ឬជ្រើស Model ផ្សេង។",
    noImage: "{:fail:} Model នេះមិនបានបង្កើតរូបភាពទេ សូមសាករៀបរាប់ម្ដងទៀត។",
    off: "{:fail:} AI មិនទាន់បើកនៅឡើយទេ។",
    limit: (n) => `{:fail:} ថ្ងៃនេះអ្នកប្រើ AI គ្រប់ ${n} ដងហើយ។ សូមត្រឡប់មកវិញថ្ងៃស្អែក។`,
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
      "• 🎨 Create image — describe the picture you want\n\n" +
      "Tap any menu button to leave.",
    chosen: (label) => `{:ok:} ${label} selected\n\nSend your text or photo.`,
    chosenImage: "{:ok:} 🎨 Create image selected\n\nDescribe the picture you want (e.g. \"a cat in a hat sitting on Angkor Wat at sunset\").",
    thinking: "{:wait:} Thinking…",
    drawing: "{:wait:} Creating the image…",
    failed: "{:fail:} The AI couldn't answer. Please try again or pick another model.",
    noImage: "{:fail:} The model didn't return an image. Please try describing it again.",
    off: "{:fail:} AI isn't switched on yet.",
    limit: (n) => `{:fail:} You've used AI ${n} times today. Please come back tomorrow.`,
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
    return config.aiModels.map(({ id, label }, i) => {
      const m = byId.get(id);
      const image = outputs(m).includes("image");
      return { key: `c${i}`, label, id, image, vision: inputs(m).includes("image") };
    });
  }
  const newestFirst = [...all].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const menu = [];
  for (const slot of SLOTS) {
    const m = newestFirst.find((x) => slot.match(x.id, x) && (slot.image || outputs(x).includes("text")));
    if (m) menu.push({ key: slot.key, label: slot.label, id: m.id, image: Boolean(slot.image), vision: inputs(m).includes("image") });
  }
  return menu;
}

// ----------------------------------------------------------------- state

const sessions = new Map(); // chatId -> { model, history: [{role, content}], at }
const SESSION_MS = 30 * 60_000;
const MAX_TURNS = 8;
const usage = new Map(); // userId -> { day, count }

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

const isAdmin = (chatId) => Boolean(config.telegramAdminChatId) && String(chatId) === String(config.telegramAdminChatId);

/** Counts one use; false when the user is over today's limit. */
function takeQuota(chatId, userId) {
  if (isAdmin(chatId) || !config.aiDailyLimit) return true;
  const day = new Date().toISOString().slice(0, 10);
  const u = usage.get(userId);
  const count = u?.day === day ? u.count : 0;
  if (count >= config.aiDailyLimit) return false;
  usage.set(userId, { day, count: count + 1 });
  return true;
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
  const rows = [];
  const textModels = menu.filter((m) => !m.image);
  for (let i = 0; i < textModels.length; i += 2) {
    rows.push(textModels.slice(i, i + 2).map((m) => ({ text: m.label, callback_data: `ai:m:${m.key}` })));
  }
  for (const m of menu.filter((x) => x.image)) rows.push([{ text: m.label, callback_data: `ai:m:${m.key}` }]);
  return call("sendMessage", { chat_id: chatId, text: tx.pick, reply_markup: { inline_keyboard: rows } });
}

const sessionKeyboard = (tx) => ({
  inline_keyboard: [[
    { text: tx.newChat, callback_data: "ai:new" },
    { text: tx.changeModel, callback_data: "ai:pick" },
  ]],
});

/** Taps on the picker / session buttons (callback data "ai:..."). */
export async function handleCallback(cq, user) {
  const chatId = cq.message?.chat?.id;
  const tx = t(user);
  const [, kind, key] = String(cq.data).split(":");
  await call("answerCallbackQuery", { callback_query_id: cq.id });
  if (!chatId) return true;

  if (kind === "pick") return ask(chatId, user), true;
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
    await call("sendMessage", { chat_id: chatId, text: model.image ? tx.chosenImage : tx.chosen(model.label) });
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

  if (photo && !s.model.image && !s.model.vision) {
    await call("sendMessage", { chat_id: chatId, text: tx.noVision, reply_markup: sessionKeyboard(tx) });
    return true;
  }
  if (!takeQuota(chatId, user.telegram_user_id)) {
    await call("sendMessage", { chat_id: chatId, text: tx.limit(config.aiDailyLimit) });
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
  return menu.length ? menu.map((m) => `${m.label}\n  ${m.id}`).join("\n") : "⚠️ No models matched.";
}
