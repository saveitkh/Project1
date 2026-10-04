/**
 * Everything the menu bot says, in Khmer and English, plus the keyboards it
 * shows. Kept apart from the bot's logic so a wording change never means
 * touching a flow, and so the two languages stay side by side where a missing
 * translation is obvious.
 */
import { config } from "./config.js";

export const LANGUAGES = ["km", "en"];

/**
 * The buttons of the main keyboard. `action` is what the bot dispatches on --
 * the label the user tapped arrives as ordinary message text, so both
 * languages' labels have to map back to the same action (see actionForLabel).
 */
const MENU = [
  { action: "account", emoji: "m_account", km: "👤 គណនី", en: "👤 Account" },
  // Two doors instead of one: the public sites anyone may use, and the
  // private-Telegram path that needs credit. The icon says which platforms.
  // Older labels stay as aliases so a keyboard still on someone's screen
  // keeps working.
  {
    action: "free",
    emoji: "free_all",
    style: "success",
    km: "⬇️ Free · ទាញយកវីដេអូ",
    en: "⬇️ Free · Download videos",
    aliases: [
      "🆓 ទាញយក Free", "🆓 Free Download",
      "🆓 Free ♾ · YT · FB · IG · TikTok", "🆓 ទាញយក · FB · IG · YT · TikTok", "🆓 Free · FB · IG · YT · TikTok",
      "📥 ទាញយកតំណ", "📥 Download",
    ],
  },
  {
    action: "premium",
    emoji: "dl",
    km: "📥 Telegram Private Link",
    en: "📥 Telegram Private Link",
    aliases: [
      "🔐 Videos Private", "🔐 Private Videos",
      "👑 Pro Telegram", "👑 Pro · Telegram · 10 ឥតគិតថ្លៃ", "👑 Pro · Telegram · 10 free",
      "👑 Premium · Telegram ឯកជន", "👑 Premium · private Telegram",
    ],
  },
  {
    action: "invoice",
    emoji: "inv_app",
    km: "🧾 គ្រប់គ្រងអាជីវកម្ម",
    en: "🧾 Manage Business",
    aliases: ["🧾 KH Invoice", "🧾 KH Invoice · វិក្កយបត្រ"],
  },
  {
    action: "watch",
    emoji: "donghua_badge",
    style: "danger",
    km: "🎬 Donghua និយាយខ្មែរ",
    en: "🎬 Donghua in Khmer",
    // The "(for sale)" clarifier lives in the section's own home text now --
    // it made the main-menu button wrap to two lines on a phone. Older
    // labels (before the rename, and before the icon replaced the leading
    // emoji) stay as aliases so a keyboard still on someone's screen works.
    aliases: [
      "🎬 មើលរឿង", "🎬 រឿងនិយាយខ្មែរ", "🎬 រឿងនិយាយខ្មែរ (សម្រាប់លក់)",
      "🎬 Khmer-dubbed Shows", "🎬 Khmer-dubbed Shows (for sale)", "🎬 Watch",
    ],
  },
  { action: "emoji", emoji: "sparkle", km: "✨ Emoji Maker", en: "✨ Emoji Maker", aliases: ["✨ Emoji Maker · បង្កើត Emoji"] },
  {
    action: "translate",
    emoji: "m_language",
    style: "success",
    km: "🌐 បកប្រែភាសា",
    en: "🌐 Translate",
    aliases: ["🌐 Translate · ខ្មែរ ⇄ English"],
  },
  // The headline row of the dashboard: one wide green button. The robot
  // stays a plain emoji (no logo icon); the models live on the AI's own
  // keyboard and in the / command list.
  {
    action: "ai",
    emoji: "ai_badge",
    style: "success",
    km: "🤖 SaveIt AI",
    en: "🤖 SaveIt AI",
    aliases: ["🤖 SaveIt AI · Claude · ChatGPT · Gemini", "🤖 AI"],
  },
  {
    action: "buy",
    emoji: "credit",
    style: "success",
    km: "💲 បញ្ចូល Credit",
    en: "💲 Add Credit",
    aliases: ["💲 បញ្ចូល Credit សម្រាប់ Download Private", "💲 Add Credit for Private Downloads", "💲 បន្ថែម Credit", "💲 Add Credit", "💎 ទិញ VIP", "💎 Buy VIP", "💎 ទិញ / VIP", "💎 Buy / VIP"],
  },
  {
    action: "referral",
    emoji: "invite",
    km: "🎁 ណែនាំមិត្ត",
    en: "🎁 Invite friends",
    aliases: ["🎁 ណែនាំមិត្ត · ទទួល Free Credit", "🎁 Invite friends · Get Free Credit", "👥 ណែនាំមិត្ត", "👥 Referral"],
  },
  // Not on the main keyboard -- these are the AI's own two video tools
  // (ai.js's aiKeyboard adds the buttons), registered here only so tapping
  // one resolves to an action the same way every other button does.
  { action: "dub", emoji: "video", km: "🎬 ប្ដូរវីដេអូជាខ្មែរ", en: "🎬 Dub video to Khmer" },
  { action: "redub", km: "🎙 ប្ដូរសំឡេងជារបស់អ្នក", en: "🎙 Replace voice with mine" },
  // The full dubbing studio (a Mini App on the VPS) -- character voices, subtitles,
  // background music -- for whole episodes rather than one short clip.
  {
    action: "dubbing",
    emoji: "video",
    km: "🎞 Studio បញ្ចូលសំឡេងខ្មែរ",
    en: "🎞 Khmer Dubbing Studio",
    aliases: ["🎬 បញ្ចូលសំឡេងខ្មែរ (AI Dubbing)", "🎬 AI Khmer Dubbing", "🎬 Dubbing Studio"],
  },
  // Kept for the commands and older keyboards; now reached from Account.
  { action: "history", emoji: "m_history", km: "📜 ប្រវត្តិ", en: "📜 History" },
  { action: "language", emoji: "m_language", km: "🌐 ភាសា", en: "🌐 Language" },
  { action: "help", emoji: "m_help", km: "❓ ជំនួយ", en: "❓ Help", aliases: ["❓ របៀបប្រើ", "❓ How to use"] },
  {
    action: "app",
    emoji: "app_tg",
    km: "📲 Open App",
    en: "📲 Open App",
    aliases: ["🚀 Open App", "🚀 Open App · បើកកម្មវិធី", "🖥 បើកកម្មវិធី", "🖥 Open app"],
  },
];

const LABEL_TO_ACTION = new Map();
// With a logo icon on the button, its own leading emoji is dropped (see
// customEmoji.js), so the tapped text may arrive without it.
const bareLabel = (label) => label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, "");
for (const item of MENU) {
  for (const label of [item.km, item.en, ...(item.aliases ?? [])]) {
    LABEL_TO_ACTION.set(label, item.action);
    LABEL_TO_ACTION.set(bareLabel(label), item.action);
  }
}

/** "▰▰▰▱▱▱▱▱▱▱" -- how much of a quota is spent, readable at a glance. */
export function progressBar(used, total, width = 10) {
  if (!total) return "▱".repeat(width);
  const filled = Math.min(width, Math.round((Math.min(used, total) / total) * width));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** Which menu action a tapped button (arriving as plain text) means, or null. */
export function actionForLabel(text) {
  return LABEL_TO_ACTION.get(String(text ?? "").trim()) ?? null;
}

/**
 * The persistent keyboard under the message box. The "open the app" button is
 * a real Mini App button when WEB_APP_URL is set -- Telegram then opens the
 * web UI inside the chat instead of a browser -- and is left out entirely
 * when it isn't, rather than showing a button that does nothing.
 */
export function mainKeyboard(language) {
  const button = (action) => {
    const item = MENU.find((m) => m.action === action);
    // `style` tints a few key buttons. Only success/danger here: Telegram
    // draws the label in its accent blue, so on a "primary" (blue) button the
    // text vanished and only the icon was left.
    return { text: item[language] ?? item.en, emoji: item.emoji, ...(item.style ? { style: item.style } : {}) };
  };
  const appUrl = config.webAppUrl || (config.khInvoiceBridgeSecret && config.publicUrl ? `${config.publicUrl.replace(/\/$/, "")}/invoice/` : "");
  // Telegram only hands signed initData (what the studio logs people in with) to a
  // Mini App opened from an *inline* button -- a reply-keyboard web_app button like
  // "app" below never receives it, so if WEB_APP_URL was pointed at the same studio,
  // that button would always land on the login screen. Never show both for one URL.
  const appUrlIsStudio = Boolean(
    appUrl && config.dubbingStudioUrl && appUrl.replace(/\/$/, "") === config.dubbingStudioUrl.replace(/\/$/, "")
  );
  // The dashboard, top to bottom: the Dubbing Studio leads when it's configured --
  // the button people actually came for -- then Manage Business (the operator's own
  // daily tool), with AI one row down; then pairs grouped by what they're for --
  // downloading, watching & words, your account -- with the colour on the one button
  // of each pair people tap most. History, language and help live under Account;
  // Open App closes the list.
  const rows = [];
  // A plain button: the bot answers with an inline Mini App button, because only an
  // inline-opened Mini App receives the signed initData the studio logs people in with.
  if (config.dubbingStudioUrl) rows.push([button("dubbing")]);
  rows.push(...(config.khInvoiceBridgeSecret ? [[button("invoice")], [button("ai"), button("emoji")]] : [[button("ai")], [button("emoji")]]));
  rows.push(
    [button("free"), button("premium")],
    [button("watch"), button("translate")],
    [button("buy"), button("account")],
    [button("referral")],
  );
  if (appUrl && !appUrlIsStudio) rows.push([{ ...button("app"), web_app: { url: appUrl } }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

export function languageKeyboard() {
  return {
    inline_keyboard: [[
      { text: "🇰🇭 ភាសាខ្មែរ", emoji: "m_language", callback_data: "bot:lang:km" },
      { text: "🇬🇧 English", emoji: "m_language", callback_data: "bot:lang:en" },
    ]],
  };
}

const SEP = "━━━━━━━━━━━━━━";

/** The welcome card's SaveIt AI block -- only once AI is switched on. */
function aiIntro(language) {
  if (!config.openrouterApiKey && !config.geminiApiKey && !config.groqApiKey) return "";
  const km = language !== "en";
  const song = config.elevenlabsApiKey ? (km ? " · {:ai_elevenlabs:} បង្កើតចម្រៀង" : " · {:ai_elevenlabs:} Create songs") : "";
  const logos = config.openrouterApiKey ? "{:ai_claude:} {:ai_openai:} {:ai_gemini:} {:ai_grok:} {:ai_deepseek:}" : "{:ai_gemini:}";
  const freeLines = [];
  if (config.geminiApiKey) freeLines.push(km ? `      🆓 Gemini Free — ឥតគិតថ្លៃ ${config.aiGeminiFreeDaily} សារ/ថ្ងៃ\n` : `      🆓 Gemini Free — ${config.aiGeminiFreeDaily} free messages a day\n`);
  if (config.groqApiKey) freeLines.push(km ? `      🆓 Llama Free — ឥតគិតថ្លៃ ${config.aiGroqFreeDaily} សារ/ថ្ងៃ\n` : `      🆓 Llama Free — ${config.aiGroqFreeDaily} free messages a day\n`);
  const free = freeLines.join("");
  return km
    ? `{:sparkle:} SaveIt AI — ថ្មី!\n` +
        `      ${logos}\n` +
        `      សួរអ្វីក៏បាន · ផ្ញើរូបឲ្យ AI មើល\n` +
        `      {:camera:} បង្កើតរូបភាព${song}\n` +
        free +
        `      {:gift:} ${config.aiFreeDaily} Credit ឥតគិតថ្លៃរៀងរាល់ថ្ងៃ\n\n`
    : `{:sparkle:} SaveIt AI — new!\n` +
        `      ${logos}\n` +
        `      Ask anything · send a photo for the AI to read\n` +
        `      {:camera:} Create images${song}\n` +
        free +
        `      {:gift:} ${config.aiFreeDaily} free Credit every day\n\n`;
}

/**
 * The list Telegram shows when someone types "/" (setMyCommands, at
 * startup). Khmer for Khmer-language Telegram apps, English otherwise.
 */
export const BOT_COMMANDS = {
  // Grouped by what people come for: AI first, then video, then the rest.
  km: [
    ["start", "🏠 ម៉ឺនុយដើម"],
    ["ai", "🤖 SaveIt AI — សួរអ្វីក៏បាន"],
    ["image", "🎨 បង្កើតរូបភាព"],
    ["song", "🎵 បង្កើតចម្រៀង"],
    ["newchat", "🔄 ចាប់ផ្ដើមការសន្ទនា AI ថ្មី"],
    ["gemini_free", "🆓 Gemini ឥតគិតថ្លៃ"],
    ["llama_free", "🆓 Llama ឥតគិតថ្លៃ"],
    ["claude", "🧠 Claude"],
    ["chatgpt", "⚡ ChatGPT"],
    ["gemini", "💎 Gemini Pro"],
    ["flash", "🚀 Gemini Flash"],
    ["grok", "🛰 Grok"],
    ["deepseek", "🐋 DeepSeek"],
    ["dub", "🎬 ប្ដូរវីដេអូខ្លីជាខ្មែរ"],
    ["redub", "🎙 ប្ដូរសំឡេងវីដេអូជារបស់អ្នក"],
    ["dubbing", "🎞 Studio បញ្ចូលសំឡេង (រឿងពេញ)"],
    ["free", "⬇️ ទាញយកវីដេអូ (YouTube, TikTok…)"],
    ["premium", "👑 ទាញយកពី Telegram ឯកជន"],
    ["watch", "📺 មើល Donghua និយាយខ្មែរ"],
    ["translate", "🌐 បកប្រែភាសា"],
    ["emoji", "✨ បង្កើត Emoji"],
    ["ai_credit", "💳 AI Credit · ទិញបន្ថែម"],
    ["buy", "💲 បញ្ចូល Credit ទាញយក"],
    ["referral", "🎁 ណែនាំមិត្ត · ទទួល Credit"],
    ["account", "👤 គណនី"],
    ["history", "📜 ប្រវត្តិទាញយក"],
    ["language", "🌐 ប្ដូរភាសា"],
    ["help", "❓ ជំនួយ"],
  ],
  en: [
    ["start", "🏠 Main menu"],
    ["ai", "🤖 SaveIt AI — ask anything"],
    ["image", "🎨 Create image"],
    ["song", "🎵 Create song"],
    ["newchat", "🔄 New AI chat"],
    ["gemini_free", "🆓 Free Gemini"],
    ["llama_free", "🆓 Free Llama"],
    ["claude", "🧠 Claude"],
    ["chatgpt", "⚡ ChatGPT"],
    ["gemini", "💎 Gemini Pro"],
    ["flash", "🚀 Gemini Flash"],
    ["grok", "🛰 Grok"],
    ["deepseek", "🐋 DeepSeek"],
    ["dub", "🎬 Dub a short video to Khmer"],
    ["redub", "🎙 Replace a video's voice with mine"],
    ["dubbing", "🎞 Dubbing Studio (full episodes)"],
    ["free", "⬇️ Download videos (YouTube, TikTok…)"],
    ["premium", "👑 Download from private Telegram"],
    ["watch", "📺 Watch Donghua in Khmer"],
    ["translate", "🌐 Translate"],
    ["emoji", "✨ Emoji Maker"],
    ["ai_credit", "💳 AI Credit · buy more"],
    ["buy", "💲 Add download Credit"],
    ["referral", "🎁 Invite friends · get Credit"],
    ["account", "👤 Account"],
    ["history", "📜 Download history"],
    ["language", "🌐 Language"],
    ["help", "❓ Help"],
  ],
};

const TEXT = {
  km: {
    welcome: (name) =>
      `{:logo:} សួស្តី ${name}! សូមស្វាគមន៍មកកាន់ {:brand:} SaveIt KH\n` +
      `${SEP}\n` +
      aiIntro("km") +
      `{:m_free:} ទាញយកវីដេអូ — ឥតគិតថ្លៃ មិនកំណត់\n` +
      `      {:yt:} {:fb:} {:ig:} {:tt:} {:x:}\n\n` +
      `{:m_pro:} Telegram ឯកជន — ក្រុម/channel បិទ\n` +
      `      {:gift:} សាកល្បងឥតគិតថ្លៃ 10 វីដេអូ\n\n` +
      `{:donghua_badge:} Donghua និយាយខ្មែរ · {:m_language:} បកប្រែ · {:sparkle:} Emoji Maker\n` +
      `${SEP}\n` +
      `{:bulb:} ផ្ញើតំណវីដេអូមក ឬជ្រើសប៊ូតុងខាងក្រោម {:dl:}`,
    help:
      `{:m_help:} របៀបប្រើ\n\n` +
      `1️⃣ ចម្លងតំណវីដេអូ (YouTube, Facebook, TikTok, Telegram…)\n` +
      `2️⃣ ផ្ញើវាមកក្នុងការសន្ទនានេះ\n` +
      `3️⃣ រង់ចាំបន្តិច — ខ្ញុំផ្ញើឯកសារ ឬ តំណទាញយកមកវិញ\n\n` +
      `{:bulb:} ឯកសារធំជាង 50MB ខ្ញុំផ្ញើជា តំណ ជំនួស (កំណត់របស់ Telegram សម្រាប់ bot)។\n` +
      `{:bulb:} ចង់យកតែសំឡេង? ផ្ញើតំណរួចសរសេរ audio នៅខាងក្រោយ។\n` +
      `{:bulb:} /dub — ផ្ញើវីដេអូខ្លី (< 6 នាទី) ឲ្យខ្ញុំអានជាសំឡេងខ្មែរឡើងវិញ។\n` +
      `{:bulb:} /redub — ផ្ញើវីដេអូ រួចផ្ញើសំឡេងអ្នក ឲ្យខ្ញុំជំនួសសំឡេងដើម។`,
    accountTitle: "ព័ត៌មានគណនី",
    fieldId: "ID",
    fieldUsername: "Username",
    fieldLanguage: "ភាសា",
    fieldQuota: "ទាញយកនៅសល់",
    fieldPlan: "គម្រោង",
    planFree: "ឥតគិតថ្លៃ",
    planVip: (until) => `{:m_pro:} VIP ដល់ ${until}`,
    fieldUsed: "បានទាញយក",
    unlimited: "មិនកំណត់",
    historyTitle: "ប្រវត្តិទាញយក",
    historyEmpty: "មិនទាន់មានការទាញយកទេ។ ផ្ញើតំណមកដើម្បីចាប់ផ្ដើម។",
    referralTitle: "កម្មវិធីណែនាំ",
    referralBody: (count, bonus, link) =>
      `{:gift:} ណែនាំមិត្តម្នាក់ ទទួលបាន ${bonus} ការទាញយកបន្ថែម!\n\n` +
      `{:inv_report:} អ្នកបានណែនាំ៖ ${count} នាក់\n\n` +
      `{:link:} តំណណែនាំរបស់អ្នក៖\n${link}\n\n` +
      `➡️ ចែករំលែកតំណនេះ — ពេលមិត្តចុច និងចាប់ផ្ដើមប្រើ អ្នកទទួលបានភ្លាម។`,
    referralJoined: (name) => `{:party:} ${name} បានចូលរួមតាមតំណណែនាំរបស់អ្នក! អ្នកទទួលបានការទាញយកបន្ថែម។`,
    languagePrompt: "{:m_language:} ជ្រើសរើសភាសា៖",
    languageSet: "{:ok:} បានប្ដូរទៅភាសាខ្មែរ។",
    btnHistory: "📜 ប្រវត្តិ",
    btnLanguage: "🌐 ភាសា",
    btnHelp: "❓ ជំនួយ",
    openApp: (url) => `{:m_desktop:} បើកកម្មវិធីពេញលេញ៖\n${url}`,
    openAppMissing: "{:m_desktop:} កម្មវិធីលើបណ្ដាញមិនទាន់បានកំណត់ទេ។",
    dubbingOpen:
      "{:video:} Studio បញ្ចូលសំឡេងខ្មែរ — សម្រាប់វីដេអូវែង/រឿងពេញ\n" +
      "Upload វីដេអូ → AI ស្កេន បកប្រែ ចែកតួ → សំឡេងខ្មែរ ក្លូនសំឡេងតួ Subtitle និងភ្លេង។\n" +
      "(វីដេអូខ្លី? ប្រើ /dub ក្នុង Chat នេះបានភ្លាម)",
    dubbingButton: "🎞 បើក Studio",
    dubbingMissing: "{:video:} Studio បញ្ចូលសំឡេងមិនទាន់បើកដំណើរការទេ — សាក /dub សម្រាប់វីដេអូខ្លី។",
    sendLink: "{:dl:} ផ្ញើតំណវីដេអូមកទីនេះ (YouTube, Facebook, TikTok, Telegram, .mp4, .m3u8…)។",
    freeScreen: () =>
      `{:m_free:} SaveIt Free — ឥតគិតថ្លៃ មិនកំណត់\n\n` +
      `{:yt:} YouTube     {:fb:} Facebook\n` +
      `{:ig:} Instagram   {:tt:} TikTok\n` +
      `{:x:} X (Twitter)  🎮 Twitch\n` +
      `{:link:} .mp4 · .m3u8 · .mp3\n` +
      `{:inv_in:} គេហទំព័រជាង ១៨០០ ផ្សេងទៀត\n\n` +
      `{:m_free:} ទាញយកប៉ុន្មានក៏បាន — មិនគិតលុយ មិនកំណត់ចំនួន\n\n` +
      `👉 ផ្ញើតំណមកបានឥឡូវនេះ\n` +
      `{:bulb:} ចង់យកតែសំឡេង? សរសេរ audio បន្ទាប់ពីតំណ`,
    proScreenTrial: (bar, used, total, left) =>
      `{:m_pro:} SaveIt Pro — Telegram\n\n` +
      `{:gift:} សាកល្បងឥតគិតថ្លៃ ${total} វីដេអូ\n` +
      `${bar}  ${used}/${total}\n` +
      `{:ok:} នៅសល់ ${left} វីដេអូ\n\n` +
      `ទាញយកបានពី៖\n` +
      `{:lock:} ក្រុម / channel ឯកជន (t.me/c/...)\n` +
      `📢 channel សាធារណៈ (t.me/...)\n` +
      `{:video:} វីដេអូពេញទំហំ — គ្មានកម្រិត 50MB\n` +
      `⚡ ផ្ញើមកវិញភ្លាម\n\n` +
      `👉 បើក post វីដេអូ → ចុចលើវា → Copy Link → ផ្ញើមកទីនេះ`,
    proScreenVip: (until) =>
      `{:m_pro:} SaveIt Pro — VIP\n\n` +
      `{:m_free:} មិនកំណត់ រហូតដល់ ${until}\n\n` +
      `{:lock:} ក្រុម / channel ឯកជន (t.me/c/...)\n` +
      `{:video:} វីដេអូពេញទំហំ — គ្មានកម្រិត 50MB\n` +
      `⚡ ផ្ញើមកវិញភ្លាម\n\n` +
      `👉 បើក post វីដេអូ → ចុចលើវា → Copy Link → ផ្ញើមកទីនេះ`,
    proScreenEmpty: (bar, total) =>
      `{:m_pro:} SaveIt Pro — Telegram\n\n` +
      `${bar}  ${total}/${total}\n` +
      `{:fail:} អ្នកប្រើអស់វីដេអូឥតគិតថ្លៃហើយ\n\n` +
      `ដើម្បីបន្ត៖\n` +
      `{:diamond:} ទិញកញ្ចប់វីដេអូ ឬ VIP មិនកំណត់\n` +
      `{:m_referral:} ណែនាំមិត្ត ១ នាក់ = +5 វីដេអូឥតគិតថ្លៃ\n\n` +
      `{:bulb:} YouTube · FB · IG · TikTok នៅតែ ឥតគិតថ្លៃ មិនកំណត់ {:m_free:}`,
    proOwnAccount:
      `\n\n{:inv_in:} ចង់ទាញពីក្រុមឯកជនរបស់អ្នកផ្ទាល់? ភ្ជាប់គណនី Telegram\n` +
      `      ក្នុង {:m_desktop:} បើកកម្មវិធី → ការកំណត់ → Telegram (ស្ម័គ្រចិត្ត)`,
    notALink: "នោះមិនមែនជាតំណទេ។ សូមផ្ញើតំណដែលចាប់ផ្ដើមដោយ http:// ឬ https://។",
    working: "{:wait:} កំពុងដំណើរការ… ខ្ញុំនឹងផ្ញើមកវិញពេលរួច។",
    queued: "{:ok:} បានបញ្ចូលក្នុងជួរ។ ខ្ញុំនឹងផ្ញើមកវិញពេលទាញយករួច (អាចចំណាយពេលពីរបីនាទីសម្រាប់វីដេអូវែង)។",
    quotaOver: (total) =>
      `{:fail:} អ្នកប្រើអស់ ${total} វីដេអូ Telegram ឥតគិតថ្លៃហើយ។\n\n` +
      `{:diamond:} ទិញ / VIP ដើម្បីបន្ត ឬ {:m_referral:} ណែនាំមិត្ត = +5 វីដេអូ\n` +
      `{:bulb:} YouTube · FB · IG · TikTok នៅតែ ឥតគិតថ្លៃ មិនកំណត់ {:m_free:}`,
    doneWithLink: (name, url) => `{:ok:} រួចរាល់៖ ${name}\n\n{:link:} ${url}`,
    doneNoLink: (name) => `{:ok:} រួចរាល់៖ ${name}`,
    creditUsed: (left, total) =>
      `{:credit:} ប្រើ 1 Credit · នៅសល់ ${left} / ${total}` +
      (left === 0 ? `\n{:fail:} Credit អស់ហើយ — ចុច {:credit:} បន្ថែម Credit ដើម្បីបន្ត` : ""),
    failed: (reason) => `{:fail:} ទាញយកមិនបាន៖ ${reason}`,
    tooBig: (mb) => `ឯកសារនេះ ${mb}MB ធំជាងកំណត់ 50MB របស់ Telegram សម្រាប់ bot — ខ្ញុំផ្ញើជាតំណជំនួស។`,
    noMedia: "សាររបស់តំណនោះគ្មានវីដេអូ ឬសំឡេងទេ។",
    privateVipOnly: "{:lock:} តំណ Telegram បិទជាបណ្ដោះអាសន្នដោយអ្នកគ្រប់គ្រង។",
    privateNoAccess: "{:lock:} មិនអាចចូលមើល chat នោះបានទេ — គណនីរបស់យើងមិនមែនជាសមាជិកនៅក្នុងក្រុមនោះទេ។",
    telegramOffline: "🔧 ផ្នែក Telegram កំពុងភ្ជាប់ឡើងវិញ — អ្នកគ្រប់គ្រងបានទទួលដំណឹងហើយ។ សូមសាកម្តងទៀតបន្តិចទៀត។\n\n{:bulb:} YouTube · FB · IG · TikTok នៅតែដំណើរការធម្មតា {:m_free:}",
    telegramBusy: "{:wait:} server កំពុង update — សូមសាកម្តងទៀតក្នុង ១ នាទី។",
    inviteLink: "នោះជាតំណអញ្ជើញ (t.me/+...) មិនមែនតំណទៅកាន់ post ទេ។ សូមចូលក្នុង post វីដេអូ → ចុចលើវា → Copy Link រួចផ្ញើតំណនោះមក។",
    sendingVideo: "📤 កំពុងផ្ញើវីដេអូ…",
  },
  en: {
    welcome: (name) =>
      `{:logo:} Hi ${name}! Welcome to {:brand:} SaveIt KH\n` +
      `${SEP}\n` +
      aiIntro("en") +
      `{:m_free:} Video download — free & unlimited\n` +
      `      {:yt:} {:fb:} {:ig:} {:tt:} {:x:}\n\n` +
      `{:m_pro:} Private Telegram — closed groups/channels\n` +
      `      {:gift:} 10 videos free to try\n\n` +
      `{:donghua_badge:} Donghua in Khmer · {:m_language:} Translate · {:sparkle:} Emoji Maker\n` +
      `${SEP}\n` +
      `{:bulb:} Send a video link, or pick a button below {:dl:}`,
    help:
      `{:m_help:} How to use\n\n` +
      `1️⃣ Copy a video link (YouTube, Facebook, TikTok, Telegram…)\n` +
      `2️⃣ Send it to this chat\n` +
      `3️⃣ Wait a moment — I send back the file, or a download link\n\n` +
      `{:bulb:} Files over 50MB come back as a link instead (Telegram's own limit for bots).\n` +
      `{:bulb:} Want audio only? Send the link followed by: audio\n` +
      `{:bulb:} /dub — send a short video (< 6 min) and I'll read it back in Khmer.\n` +
      `{:bulb:} /redub — send a video, then your own voice, and I'll swap it in.`,
    accountTitle: "Account",
    fieldId: "ID",
    fieldUsername: "Username",
    fieldLanguage: "Language",
    fieldQuota: "Downloads left",
    fieldPlan: "Plan",
    planFree: "Free",
    planVip: (until) => `{:m_pro:} VIP until ${until}`,
    fieldUsed: "Downloaded",
    unlimited: "unlimited",
    historyTitle: "Download history",
    historyEmpty: "Nothing downloaded yet. Send a link to start.",
    referralTitle: "Referral programme",
    referralBody: (count, bonus, link) =>
      `{:gift:} Get ${bonus} extra downloads for every friend you bring!\n\n` +
      `{:inv_report:} You have referred: ${count}\n\n` +
      `{:link:} Your referral link:\n${link}\n\n` +
      `➡️ Share it — you're credited as soon as they start the bot.`,
    referralJoined: (name) => `{:party:} ${name} joined through your referral link! Extra downloads added.`,
    languagePrompt: "{:m_language:} Choose a language:",
    languageSet: "{:ok:} Switched to English.",
    btnHistory: "📜 History",
    btnLanguage: "🌐 Language",
    btnHelp: "❓ Help",
    openApp: (url) => `{:m_desktop:} Open the full app:\n${url}`,
    openAppMissing: "{:m_desktop:} The web app URL isn't configured yet.",
    dubbingOpen:
      "{:video:} Khmer Dubbing Studio — for long videos and full episodes\n" +
      "Upload a video → AI scans, translates and casts it → Khmer voices, cloned character voices, subtitles and music.\n" +
      "(Short clip? Use /dub right here in the chat)",
    dubbingButton: "🎞 Open Studio",
    dubbingMissing: "{:video:} The dubbing studio isn't running yet — try /dub for short clips.",
    sendLink: "{:dl:} Send a video link here (YouTube, Facebook, TikTok, Telegram, .mp4, .m3u8…).",
    freeScreen: () =>
      `{:m_free:} SaveIt Free — free & unlimited\n\n` +
      `{:yt:} YouTube     {:fb:} Facebook\n` +
      `{:ig:} Instagram   {:tt:} TikTok\n` +
      `{:x:} X (Twitter)  🎮 Twitch\n` +
      `{:link:} .mp4 · .m3u8 · .mp3\n` +
      `{:inv_in:} ~1800 more sites\n\n` +
      `{:m_free:} As many as you like — no charge, no limit\n\n` +
      `👉 Send a link now\n` +
      `{:bulb:} Want audio only? Write audio after the link`,
    proScreenTrial: (bar, used, total, left) =>
      `{:m_pro:} SaveIt Pro — Telegram\n\n` +
      `{:gift:} Free trial: ${total} videos\n` +
      `${bar}  ${used}/${total}\n` +
      `{:ok:} ${left} left\n\n` +
      `Download from:\n` +
      `{:lock:} Private groups / channels (t.me/c/...)\n` +
      `📢 Public channels (t.me/...)\n` +
      `{:video:} Full-size video — no 50MB limit\n` +
      `⚡ Delivered instantly\n\n` +
      `👉 Open the video post → tap it → Copy Link → send it here`,
    proScreenVip: (until) =>
      `{:m_pro:} SaveIt Pro — VIP\n\n` +
      `{:m_free:} Unlimited until ${until}\n\n` +
      `{:lock:} Private groups / channels (t.me/c/...)\n` +
      `{:video:} Full-size video — no 50MB limit\n` +
      `⚡ Delivered instantly\n\n` +
      `👉 Open the video post → tap it → Copy Link → send it here`,
    proScreenEmpty: (bar, total) =>
      `{:m_pro:} SaveIt Pro — Telegram\n\n` +
      `${bar}  ${total}/${total}\n` +
      `{:fail:} Your free videos are used up\n\n` +
      `To keep going:\n` +
      `{:diamond:} Buy a video pack, or VIP unlimited\n` +
      `{:m_referral:} Refer a friend = +5 free videos\n\n` +
      `{:bulb:} YouTube · FB · IG · TikTok stay free and unlimited {:m_free:}`,
    proOwnAccount:
      `\n\n{:inv_in:} Want your own private groups? Link your Telegram account\n` +
      `      in {:rocket:} Open App → Settings → Telegram (optional)`,
    notALink: "That isn't a link. Send something starting with http:// or https://.",
    working: "{:wait:} Working on it… I'll send it back when it's ready.",
    queued: "{:ok:} Queued. I'll send it back once it's downloaded (a long video can take a few minutes).",
    quotaOver: (total) =>
      `{:fail:} You've used all ${total} free Telegram videos.\n\n` +
      `{:diamond:} Buy / VIP to keep going, or {:m_referral:} refer a friend = +5 videos\n` +
      `{:bulb:} YouTube · FB · IG · TikTok stay free and unlimited {:m_free:}`,
    doneWithLink: (name, url) => `{:ok:} Done: ${name}\n\n{:link:} ${url}`,
    doneNoLink: (name) => `{:ok:} Done: ${name}`,
    creditUsed: (left, total) =>
      `{:credit:} 1 Credit used · ${left} / ${total} left` +
      (left === 0 ? `\n{:fail:} Out of Credit — tap {:credit:} Add Credit to continue` : ""),
    failed: (reason) => `{:fail:} Download failed: ${reason}`,
    tooBig: (mb) => `That file is ${mb}MB, over Telegram's 50MB bot upload limit — here's a link instead.`,
    noMedia: "That message has no video or audio in it.",
    privateVipOnly: "{:lock:} Telegram links are switched off by the operator for now.",
    privateNoAccess: "{:lock:} Can't open that chat — our account isn't a member of that group.",
    telegramOffline: "🔧 The Telegram side is reconnecting — the operator has been told. Please try again shortly.\n\n{:bulb:} YouTube · FB · IG · TikTok still work as normal {:m_free:}",
    telegramBusy: "{:wait:} The server is updating — please try again in a minute.",
    inviteLink: "That's an invite link (t.me/+...), not a link to a post. Open the video post → tap it → Copy Link, and send that.",
    sendingVideo: "📤 Sending the video…",
  },
};

/** The string table for a language, falling back to Khmer (the default audience). */
export function texts(language) {
  return TEXT[language] ?? TEXT.km;
}
