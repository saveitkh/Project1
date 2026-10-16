/**
 * The bot's own "storefront": the description people see before pressing
 * Start, the one-line short description in search / share cards, and the
 * "/" command menu -- in Khmer and English, pushed to Telegram on startup.
 *
 * Telegram picks the language from the viewer's app language; the call
 * without `language_code` is the default for everyone else (Khmer, the main
 * audience).
 *
 * Not settable here: the 640x360 animation above the description. The Bot
 * API has no method for it -- upload it in @BotFather (/setdescriptionpic).
 * `npm run make:descpic -- <video>` makes a file that fits.
 */
import { config } from "./config.js";
import { call } from "./notifyBot.js";

// Telegram limits: description 512 chars, short description 120.
const PROFILE = {
  km: {
    description:
      "សូមស្វាគមន៍មកកាន់ SaveIt KH 👋\n\n" +
      "⬇️ ទាញយកវីដេអូ YouTube · Facebook · TikTok · Instagram ឥតគិតថ្លៃ\n" +
      "📥 ទាញពី Telegram ឯកជន — វីដេអូពេញទំហំ\n" +
      "🎬 AI បញ្ចូលសំឡេងខ្មែរលើវីដេអូ\n" +
      "✨ Emoji Maker — បង្កើត Emoji ផ្ទាល់ខ្លួនពី MP4 / GIF\n" +
      "🧾 គ្រប់គ្រងអាជីវកម្ម · វិក្កយបត្រ\n\n" +
      "ចុច START ឬ ផ្ញើតំណមកបានភ្លាម 👇",
    short: "ទាញយកវីដេអូ · បញ្ចូលសំឡេងខ្មែរ AI · Emoji Maker · វិក្កយបត្រ",
    commands: [
      ["start", "ចាប់ផ្ដើម / ម៉ឺនុយ"],
      ["free", "ទាញយកវីដេអូ ឥតគិតថ្លៃ"],
      ["premium", "ទាញយក Telegram ឯកជន"],
      ["dubbing", "AI បញ្ចូលសំឡេងខ្មែរ"],
      ["emoji", "បង្កើត Emoji ផ្ទាល់ខ្លួន"],
      ["translate", "បកប្រែ ខ្មែរ ⇄ English"],
      ["invoice", "គ្រប់គ្រងអាជីវកម្ម"],
      ["buy", "បញ្ចូល Credit / VIP"],
      ["account", "គណនីរបស់ខ្ញុំ"],
      ["referral", "ណែនាំមិត្ត · Credit ឥតគិតថ្លៃ"],
      ["language", "ប្ដូរភាសា"],
      ["help", "របៀបប្រើ"],
    ],
  },
  en: {
    description:
      "Welcome to SaveIt KH 👋\n\n" +
      "⬇️ Free video downloads — YouTube · Facebook · TikTok · Instagram\n" +
      "📥 Private Telegram links — full-size video\n" +
      "🎬 AI Khmer dubbing for any video\n" +
      "✨ Emoji Maker — custom emoji from an MP4 / GIF\n" +
      "🧾 Business & invoice manager\n\n" +
      "Tap START, or just send a link 👇",
    short: "Video downloader · AI Khmer dubbing · Emoji Maker · Invoices",
    commands: [
      ["start", "Start / main menu"],
      ["free", "Free video download"],
      ["premium", "Private Telegram download"],
      ["dubbing", "AI Khmer dubbing"],
      ["emoji", "Make a custom emoji"],
      ["translate", "Translate Khmer ⇄ English"],
      ["invoice", "Manage your business"],
      ["buy", "Add Credit / VIP"],
      ["account", "My account"],
      ["referral", "Invite friends · free Credit"],
      ["language", "Change language"],
      ["help", "How to use"],
    ],
  },
};

// Only list a command whose feature is switched on, so "/dubbing" never
// appears in the menu of a deployment that has no studio to open.
const available = (command) => {
  if (command === "dubbing") return !!config.dubbingStudioUrl;
  if (command === "invoice") return !!config.khInvoiceBridgeSecret;
  return true;
};

/** Pushes description, short description and commands for every language. */
export async function applyBotProfile() {
  if (!config.telegramLoginBotToken) return;
  // [language_code | undefined = default, profile]
  const targets = [[undefined, PROFILE.km], ["km", PROFILE.km], ["en", PROFILE.en]];
  for (const [code, p] of targets) {
    const lang = code ? { language_code: code } : {};
    const results = await Promise.all([
      call("setMyDescription", { description: p.description, ...lang }),
      call("setMyShortDescription", { short_description: p.short, ...lang }),
      call("setMyCommands", {
        commands: p.commands.filter(([c]) => available(c)).map(([command, description]) => ({ command, description })),
        ...lang,
      }),
    ]).catch((err) => [{ ok: false, description: String(err?.message ?? err) }]);
    const bad = results.find((r) => r && r.ok === false);
    if (bad) console.error(`Bot profile (${code ?? "default"}) not fully applied:`, bad.description);
  }
  console.log("Bot description, short description and commands are up to date");
}
