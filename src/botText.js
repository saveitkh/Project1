diff --git a/src/botText.js b/src/botText.js
index 59cb5b4..45c86ce 100644
--- a/src/botText.js
+++ b/src/botText.js
@@ -13,6 +13,9 @@ export const LANGUAGES = ["km", "en"];
  * the label the user tapped arrives as ordinary message text, so both
  * languages' labels have to map back to the same action (see actionForLabel).
  */
+// Button colours (`style`) carry meaning, so only a few buttons have one:
+// green = free / pay, blue = the main tools, red = shows. Everything else is
+// plain, so the coloured ones stand out. Remove or add a `style` to change it.
 const MENU = [
   { action: "account", emoji: "m_account", km: "👤 គណនី", en: "👤 Account" },
   // Two doors instead of one: the public sites anyone may use, and the
@@ -60,11 +63,12 @@ const MENU = [
     // it made the main-menu button wrap to two lines on a phone.
     aliases: ["🎬 មើលរឿង", "🎬 រឿងនិយាយខ្មែរ (សម្រាប់លក់)", "🎬 Khmer-dubbed Shows (for sale)", "🎬 Watch"],
   },
-  { action: "emoji", emoji: "sparkle", style: "primary", km: "✨ Emoji Maker", en: "✨ Emoji Maker", aliases: ["✨ Emoji Maker · បង្កើត Emoji"] },
+  // The AI tools door; the Emoji Maker is what it opens for now. The old label
+  // stays an alias so a keyboard still on someone's screen keeps working.
+  { action: "emoji", emoji: "sparkle", style: "primary", km: "✨ SaveIt AI", en: "✨ SaveIt AI", aliases: ["✨ Emoji Maker", "✨ Emoji Maker · បង្កើត Emoji"] },
   {
     action: "translate",
     emoji: "m_language",
-    style: "success",
     km: "🌐 បកប្រែភាសា",
     en: "🌐 Translate",
     aliases: ["🌐 Translate · ខ្មែរ ⇄ English"],
@@ -73,16 +77,19 @@ const MENU = [
     action: "buy",
     emoji: "credit",
     style: "success",
-    km: "💲 បញ្ចូល Credit សម្រាប់ Download Private",
-    en: "💲 Add Credit for Private Downloads",
-    aliases: ["💲 បន្ថែម Credit", "💲 Add Credit", "💎 ទិញ VIP", "💎 Buy VIP", "💎 ទិញ / VIP", "💎 Buy / VIP"],
+    km: "💲 បញ្ចូល Credit",
+    en: "💲 Add Credit",
+    aliases: [
+      "💲 បញ្ចូល Credit សម្រាប់ Download Private", "💲 Add Credit for Private Downloads",
+      "💲 បន្ថែម Credit", "💎 ទិញ VIP", "💎 Buy VIP", "💎 ទិញ / VIP", "💎 Buy / VIP",
+    ],
   },
   {
     action: "referral",
     emoji: "invite",
-    km: "🎁 ណែនាំមិត្ត · ទទួល Free Credit",
-    en: "🎁 Invite friends · Get Free Credit",
-    aliases: ["👥 ណែនាំមិត្ត", "👥 Referral"],
+    km: "🎁 ណែនាំមិត្ត",
+    en: "🎁 Invite Friends",
+    aliases: ["🎁 ណែនាំមិត្ត · ទទួល Free Credit", "🎁 Invite friends · Get Free Credit", "👥 ណែនាំមិត្ត", "👥 Referral"],
   },
   // Kept for the commands and older keyboards; now reached from Account.
   { action: "history", emoji: "m_history", km: "📜 ប្រវត្តិ", en: "📜 History" },
@@ -121,10 +128,59 @@ export function actionForLabel(text) {
 }
 
 /**
- * The persistent keyboard under the message box. The "open the app" button is
- * a real Mini App button when WEB_APP_URL is set -- Telegram then opens the
- * web UI inside the chat instead of a browser -- and is left out entirely
- * when it isn't, rather than showing a button that does nothing.
+ * The Mini Apps the bot can open: the SaveIt web app and KH Invoice. Each is
+ * only listed when its URL is configured, so a button never does nothing.
+ */
+export function miniApps() {
+  const apps = [];
+  if (config.webAppUrl) apps.push({ key: "saveit", url: config.webAppUrl });
+  const base = (config.publicUrl ?? "").replace(/\/$/, "");
+  const invoiceUrl = config.khInvoiceWebUrl || (base ? `${base}/invoice/` : "");
+  if (config.khInvoiceBridgeSecret && invoiceUrl) apps.push({ key: "invoice", url: invoiceUrl });
+  return apps;
+}
+
+/**
+ * The "Open App" screen: one inline Mini App button per app. Inline (not
+ * reply-keyboard) buttons, because only those are handed the signed initData
+ * the apps sign in with. Null when no app is configured.
+ */
+export function appKeyboard(language) {
+  const t = texts(language);
+  const rows = miniApps().map((app) => [
+    { text: t.appNames[app.key], emoji: app.key === "invoice" ? "inv_app" : "logo", web_app: { url: app.url } },
+  ]);
+  return rows.length ? { inline_keyboard: rows } : null;
+}
+
+/**
+ * The commands listed by the chat's Menu button (see registerBotWebhook),
+ * /start first. Each description carries both languages, so it reads right
+ * whatever language the person's Telegram is in.
+ */
+export function botCommands() {
+  return [
+    { command: "start", description: "ចាប់ផ្ដើម · Start" },
+    { command: "free", description: "ទាញយកវីដេអូ Free · Free downloads" },
+    { command: "premium", description: "Telegram Private Link" },
+    ...(config.khInvoiceBridgeSecret ? [{ command: "invoice", description: "គ្រប់គ្រងអាជីវកម្ម · KH Invoice" }] : []),
+    { command: "watch", description: "រឿងនិយាយខ្មែរ · Khmer-dubbed Shows" },
+    { command: "translate", description: "បកប្រែភាសា · Translate" },
+    { command: "emoji", description: "SaveIt AI · Emoji Maker" },
+    { command: "account", description: "គណនី · Account" },
+    { command: "buy", description: "បញ្ចូល Credit · Add Credit" },
+    { command: "referral", description: "ណែនាំមិត្ត · Invite friends" },
+    ...(miniApps().length ? [{ command: "app", description: "បើកកម្មវិធី · Open App" }] : []),
+    { command: "language", description: "ភាសា · Language" },
+  ];
+}
+
+/**
+ * The persistent keyboard under the message box, in pairs so it stays short
+ * (a phone doesn't scroll a reply keyboard into view, and a tall one pushes
+ * the chat away). "Open App" is left out when no Mini App is configured,
+ * rather than showing a button that does nothing; tapping it opens the app
+ * chooser (appKeyboard).
  */
 export function mainKeyboard(language) {
   const button = (action) => {
@@ -132,26 +188,28 @@ export function mainKeyboard(language) {
     // `style` tints a few key buttons (Telegram's primary / success colours).
     return { text: item[language] ?? item.en, emoji: item.emoji, ...(item.style ? { style: item.style } : {}) };
   };
-  const appUrl = config.webAppUrl || (config.khInvoiceBridgeSecret && config.publicUrl ? `${config.publicUrl.replace(/\/$/, "")}/invoice/` : "");
-  // Only what people use every day; history, language and help are under
-  // Account. Open App closes the list.
-  const rows = [
-    [button("free"), button("premium")],
-    config.khInvoiceBridgeSecret ? [button("invoice"), button("emoji")] : [button("emoji")],
-    [button("translate"), button("watch")],
-    [button("account")],
-    [button("buy")],
-    [button("referral")],
-  ];
-  if (appUrl) rows.push([{ ...button("app"), web_app: { url: appUrl } }]);
-  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
+  const pairs = (list) => Array.from({ length: Math.ceil(list.length / 2) }, (_, i) => list.slice(i * 2, i * 2 + 2));
+  // Free and Private Link head the keyboard; everything else follows in pairs,
+  // so whatever is switched off (KH Invoice, Open App) never leaves a gap in
+  // the middle -- only the last button can stand alone. History, language and
+  // help live under Account.
+  const rest = [config.khInvoiceBridgeSecret && "invoice", "watch", "translate", "emoji", "account", "buy", "referral", miniApps().length && "app"]
+    .filter(Boolean)
+    .map(button);
+  return {
+    keyboard: [[button("free"), button("premium")], ...pairs(rest)],
+    resize_keyboard: true,
+    is_persistent: true,
+  };
 }
 
 export function languageKeyboard() {
   return {
     inline_keyboard: [[
-      { text: "🇰🇭 ភាសាខ្មែរ", emoji: "m_language", callback_data: "bot:lang:km" },
-      { text: "🇬🇧 English", emoji: "m_language", callback_data: "bot:lang:en" },
+      // No `emoji` here: the flag isn't stripped as a leading emoji, so a logo icon
+      // would show the same globe on both buttons next to the flag.
+      { text: "🇰🇭 ភាសាខ្មែរ", callback_data: "bot:lang:km" },
+      { text: "🇬🇧 English", callback_data: "bot:lang:en" },
     ]],
   };
 }
@@ -198,6 +256,8 @@ const TEXT = {
     btnHistory: "📜 ប្រវត្តិ",
     btnLanguage: "🌐 ភាសា",
     btnHelp: "❓ ជំនួយ",
+    appChoose: "{:app_tg:} បើកកម្មវិធី\n\nជ្រើសរើសកម្មវិធីដែលអ្នកចង់បើក៖",
+    appNames: { saveit: "⬇️ SaveIt App", invoice: "🧾 KH Invoice" },
     openApp: (url) => `{:m_desktop:} បើកកម្មវិធីពេញលេញ៖\n${url}`,
     openAppMissing: "{:m_desktop:} កម្មវិធីលើបណ្ដាញមិនទាន់បានកំណត់ទេ។",
     sendLink: "{:dl:} ផ្ញើតំណវីដេអូមកទីនេះ (YouTube, Facebook, TikTok, Telegram, .mp4, .m3u8…)។",
@@ -303,6 +363,8 @@ const TEXT = {
     btnHistory: "📜 History",
     btnLanguage: "🌐 Language",
     btnHelp: "❓ Help",
+    appChoose: "{:app_tg:} Open App\n\nChoose the app to open:",
+    appNames: { saveit: "⬇️ SaveIt App", invoice: "🧾 KH Invoice" },
     openApp: (url) => `{:m_desktop:} Open the full app:\n${url}`,
     openAppMissing: "{:m_desktop:} The web app URL isn't configured yet.",
     sendLink: "{:dl:} Send a video link here (YouTube, Facebook, TikTok, Telegram, .mp4, .m3u8…).",
diff --git a/src/linkBot.js b/src/linkBot.js
index 93cfb42..f38a0ee 100644
--- a/src/linkBot.js
+++ b/src/linkBot.js
@@ -17,7 +17,7 @@ import path from "node:path";
 import { fileURLToPath } from "node:url";
 
 import { config } from "./config.js";
-import { actionForLabel, languageKeyboard, mainKeyboard, progressBar, texts } from "./botText.js";
+import { actionForLabel, appKeyboard, languageKeyboard, mainKeyboard, progressBar, texts } from "./botText.js";
 import * as botDeliver from "./botDeliver.js";
 import * as botJobs from "./botJobs.js";
 import * as botPay from "./botPay.js";
@@ -361,8 +361,11 @@ export async function handleMessage(message) {
       const quota = await quotaFor(user);
       return botPay.showPackages(chatId, user, quota);
     }
-    case "app":
-      return send(chatId, config.webAppUrl ? t.openApp(config.webAppUrl) : t.openAppMissing);
+    case "app": {
+      // The SaveIt and KH Invoice Mini Apps, as inline buttons (see appKeyboard).
+      const keyboard = appKeyboard(user.language);
+      return keyboard ? send(chatId, t.appChoose, { reply_markup: keyboard }) : send(chatId, t.openAppMissing);
+    }
     default:
       break;
   }
@@ -655,6 +658,7 @@ function commandAction(text) {
     case "/invoice": return "invoice";
     case "/emoji": return "emoji";
     case "/translate": return "translate";
+    case "/watch": return "watch";
     default: return null;
   }
 }
diff --git a/src/notifyBot.js b/src/notifyBot.js
index 75baa68..e60cd0f 100644
--- a/src/notifyBot.js
+++ b/src/notifyBot.js
@@ -38,7 +38,10 @@ export async function call(method, body) {
 // Payment approvals and order QRs are never cleared. In memory on purpose:
 // after a restart, old screens just stay.
 const screens = new Map();
-const KEEP = /^bot:(pay_|cancel)/;
+// The admin's claim buttons (notifyAdminOfSubmission) use plain `pay_approve:` /
+// `pay_reject:` with no `bot:` prefix, so the prefix has to be optional or those
+// messages get deleted the moment the operator taps a main-menu button.
+const KEEP = /^(bot:)?(pay_|cancel)/;
 
 function rememberScreen(method, body, result) {
   if (method !== "sendMessage" && method !== "sendPhoto") return;
diff --git a/src/server.js b/src/server.js
index 8c3869b..64835c5 100644
--- a/src/server.js
+++ b/src/server.js
@@ -36,6 +36,7 @@ import * as telegram from "./telegram.js";
 import * as telegramStorage from "./telegramStorage.js";
 import { signInWithTelegram, signInWithTelegramMiniApp } from "./telegramLogin.js";
 import { answerCallbackQuery, call as botApi, stampDecision } from "./notifyBot.js";
+import { botCommands } from "./botText.js";
 import { loop } from "./worker.js";
 
 const app = express();
@@ -1055,13 +1056,13 @@ async function registerBotWebhook() {
   } catch (err) {
     console.error("Could not set the Telegram bot webhook:", err?.message ?? err);
   }
-  // The button beside the message box: always in view, and a Mini App opened
-  // from it receives the signed initData (a reply-keyboard one does not).
-  const appUrl = config.webAppUrl || (config.khInvoiceBridgeSecret ? `${config.publicUrl.replace(/\/$/, "")}/invoice/` : "");
-  if (appUrl) {
-    const menu = await botApi("setChatMenuButton", { menu_button: { type: "web_app", text: "📲 Open App", web_app: { url: appUrl } } }).catch(() => null);
-    if (menu?.ok) console.log(`Chat menu button opens ${appUrl}`);
-  }
+  // The Menu button beside the message box lists the bot's commands, /start
+  // first. The Mini Apps (SaveIt, KH Invoice) open from "Open App"'s inline
+  // buttons instead, which are handed the signed initData just as the menu
+  // button was. This replaces any command list set by hand in @BotFather.
+  const commands = await botApi("setMyCommands", { commands: botCommands() }).catch(() => null);
+  const menu = await botApi("setChatMenuButton", { menu_button: { type: "commands" } }).catch(() => null);
+  if (commands?.ok && menu?.ok) console.log("Chat menu button lists the bot commands (/start first)");
 }
 
 const server = app.listen(config.port, () => {
