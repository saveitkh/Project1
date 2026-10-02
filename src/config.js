import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "dotenv/config";

const str = (name, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const int = (name, fallback) => {
  const parsed = Number.parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * YTDLP_COOKIES_FILE wants a path on disk, but a host like Railway only
 * offers plain env vars, not file uploads -- there is nowhere to put a
 * cookies.txt for that variable to point at. YTDLP_COOKIES_CONTENT lets the
 * whole Netscape-format file be pasted as the variable's value instead; this
 * writes it out once at startup and points ytdlpCookiesFile at the result,
 * so ytdlp.js's `--cookies` flag works the same either way. An explicit
 * YTDLP_COOKIES_FILE always wins, for a setup that does have a real path.
 */
function resolveCookiesFile() {
  const explicitPath = str("YTDLP_COOKIES_FILE");
  if (explicitPath) return explicitPath;
  const content = str("YTDLP_COOKIES_CONTENT");
  if (!content) return "";
  const written = path.join(os.tmpdir(), "ytdlp-cookies.txt");
  try {
    fs.writeFileSync(written, content, "utf8");
    return written;
  } catch (err) {
    console.error("Could not write YTDLP_COOKIES_CONTENT to a file:", err?.message ?? err);
    return "";
  }
}

export const config = {
  apiKey: str("BACKEND_API_KEY"),
  corsOrigins: str("CORS_ORIGINS", "*").split(",").map((o) => o.trim()).filter(Boolean),
  port: int("PORT", 8000),

  supabaseUrl: str("SUPABASE_URL"),
  supabaseServiceKey: str("SUPABASE_SERVICE_ROLE_KEY"),
  anthropicApiKey: str("ANTHROPIC_API_KEY"),

  // SaveIt AI (ai.js), through OpenRouter. Unset key = the AI button says
  // it's off. AI_MODELS ("id|Label,id|Label") replaces the auto-picked menu.
  // Uses are paid in AI Credit (aiCredits.js): AI_FREE_DAILY free Credit per
  // person per day, AI_COSTS the price per kind of use. ELEVENLABS_API_KEY
  // turns on 🎵 songs, AI_SONG_SECONDS their length.
  openrouterApiKey: str("OPENROUTER_API_KEY"),
  elevenlabsApiKey: str("ELEVENLABS_API_KEY"),
  aiModels: str("AI_MODELS")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, label] = entry.split("|").map((x) => x.trim());
      return { id, label: label || id };
    }),
  aiFreeDaily: int("AI_FREE_DAILY", 5),
  aiCosts: str("AI_COSTS"),
  aiSongSeconds: int("AI_SONG_SECONDS", 120),
  // 🆓 Gemini Free: Google's own free Gemini API tier (a key from
  // aistudio.google.com), costing no AI Credit. Google's free quota is per
  // project -- shared by every user of the bot -- so each person also gets
  // at most AI_GEMINI_FREE_DAILY messages a day. GEMINI_FREE_MODEL pins a
  // model; unset picks Google's newest Flash.
  geminiApiKey: str("GEMINI_API_KEY"),
  geminiFreeModel: str("GEMINI_FREE_MODEL"),
  aiGeminiFreeDaily: int("AI_GEMINI_FREE_DAILY", 20),
  // 🆓 Llama Free: Groq's own free tier (groq.com -> API Keys), no card
  // needed, no cost ever (unlike Gemini's, which Google has cut before).
  // Its free quota is also one pool for the whole bot, hence a daily cap
  // per person too. Kept well under Groq's org-wide ceiling by default.
  groqApiKey: str("GROQ_API_KEY"),
  groqFreeModel: str("GROQ_FREE_MODEL"),
  aiGroqFreeDaily: int("AI_GROQ_FREE_DAILY", 15),

  telegramApiId: str("TELEGRAM_API_ID"),
  telegramApiHash: str("TELEGRAM_API_HASH"),
  telegramPhone: str("TELEGRAM_PHONE"),
  telegramSession: str("TELEGRAM_SESSION_STRING"),

  // A separate, lightweight Bot API bot used only for "Log in with Telegram"
  // on the sign-in screen -- unrelated to the userbot above, which needs a
  // full phone-number MTProto session instead. Create one with @BotFather,
  // then run /setdomain in the same chat pointed at the deployed frontend
  // origin, or the Login Widget refuses to render there.
  telegramLoginBotToken: str("TELEGRAM_LOGIN_BOT_TOKEN"),

  // Subscriptions: the same Login Widget bot above also DMs the operator a
  // payment claim with Approve/Reject buttons (one bot, two jobs, so there's
  // only one to create). TELEGRAM_ADMIN_CHAT_ID is the operator's own chat
  // id with that bot -- send it any message and check getUpdates to find it.
  telegramAdminChatId: str("TELEGRAM_ADMIN_CHAT_ID"),
  // The bot menu's "open the app" button. Telegram only accepts an https URL
  // here, and only opens it as a Mini App when the same URL is registered
  // with @BotFather -- otherwise the button is simply a link.
  webAppUrl: str("WEB_APP_URL"),
  // KH Invoice, the separate invoicing app the bot also fronts (see
  // khInvoice.js). The bridge is that app's telegram-bridge edge function;
  // the secret is the one stored in its bridge_config row. The web URL is
  // what "📱 Open KH Invoice" opens as a Mini App.
  khInvoiceBridgeUrl: str(
    "KH_INVOICE_BRIDGE_URL",
    "https://xwtzoeegwfhtvyhydeyy.supabase.co/functions/v1/telegram-bridge"
  ),
  khInvoiceBridgeSecret: str("KH_INVOICE_BRIDGE_SECRET"),
  khInvoiceWebUrl: str("KH_INVOICE_WEB_URL"),
  // This service's own public origin, used to register the bot's webhook on
  // startup. Railway sets RAILWAY_PUBLIC_DOMAIN for us; PUBLIC_URL overrides
  // it anywhere else.
  publicUrl:
    str("PUBLIC_URL") ||
    (str("RAILWAY_PUBLIC_DOMAIN") ? `https://${str("RAILWAY_PUBLIC_DOMAIN")}` : ""),
  // The SaveIt Pro free trial: how many Telegram videos a new bot user gets
  // before a pack or VIP is needed. Referring someone adds REFERRAL_BONUS.
  botFreeDownloads: int("BOT_FREE_DOWNLOADS", 10),
  botReferralBonus: int("BOT_REFERRAL_BONUS", 5),
  // How the bot treats Telegram links (SaveIt Pro). They run through the
  // operator's own accounts, so without a meter anyone holding one link into
  // a paid VIP group could take its videos for free. "trial" (default):
  // BOT_FREE_DOWNLOADS free, then packs or VIP; "all": anyone, uncounted;
  // "admin": the operator only. YouTube/FB/TikTok are never metered.
  botPrivateLinks: str("BOT_PRIVATE_LINKS", "trial"),
  // Shared secret a phone-automation app (Tasker/MacroDroid/...) presents
  // when POSTing a raw ABA payment-notification text to /api/subscription/aba-ingest.
  // Unset means the endpoint refuses everything -- fail-closed on purpose.
  abaIngestSecret: str("ABA_INGEST_SECRET"),
  // The account name ABA's own notification text shows for a payment
  // addressed to the operator -- matched literally against incoming text
  // before an amount is ever trusted, so a notification for someone else's
  // account can't be replayed here.
  abaMerchantName: str("ABA_MERCHANT_NAME"),

  r2AccountId: str("R2_ACCOUNT_ID"),
  r2AccessKeyId: str("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: str("R2_SECRET_ACCESS_KEY"),
  r2BucketName: str("R2_BUCKET_NAME"),
  r2EndpointUrl: str("R2_ENDPOINT_URL"),
  r2PublicUrl: str("R2_PUBLIC_URL"),
  r2Region: str("R2_REGION", "auto"),

  // Source S3-compatible bucket (e.g. Contabo), used only by
  // src/migrate-s3-to-r2.js / POST /api/s3import/* to pull existing videos
  // into R2 once and then delete them here. Both key names are accepted
  // since providers' setup docs disagree on which one they show.
  s3Endpoint: str("S3_ENDPOINT"),
  s3AccessKeyId: str("S3_ACCESS_KEY_ID", str("S3_ACCESS_KEY")),
  s3SecretAccessKey: str("S3_SECRET_ACCESS_KEY", str("S3_SECRET_KEY")),
  s3BucketName: str("S3_BUCKET_NAME"),
  s3Region: str("S3_REGION", "us-east-1"),
  s3ForcePathStyle: str("S3_FORCE_PATH_STYLE") === "true",

  workerInterval: int("WORKER_INTERVAL", 30),
  // Minutes between automatic re-scans of a group with auto_rescan enabled --
  // keeps new episodes showing up on their own instead of only ever appearing
  // after someone clicks "Scan" by hand.
  autoRescanMinutes: int("AUTO_RESCAN_MINUTES", 30),
  // How many list URLs are pulled into R2 at once. These are plain HTTP
  // transfers with no Telegram flood limit behind them, so the only ceiling is
  // the link -- but two at a time keeps one slow host from stalling the rest.
  maxConcurrentUrlFetches: int("MAX_CONCURRENT_URL_FETCHES", 2),
  // Where saved URL-list videos land in the bucket.
  urlFetchFolder: str("URL_FETCH_FOLDER", "urls"),
  // Sent with every ytdlp.js request; some CDNs 403 a request with no
  // recognizable browser User-Agent even when the Referer is correct.
  m3u8UserAgent: str(
    "M3U8_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  ),
  // Path to a Netscape-format cookies.txt, passed to yt-dlp via --cookies
  // for sources that only serve the real video (or, as with tk12000real.com,
  // only serve segment .ts files rather than 403ing them) to a session with
  // valid cookies. Set YTDLP_COOKIES_FILE to a real path, or paste the
  // file's whole content into YTDLP_COOKIES_CONTENT when there is nowhere to
  // upload an actual file (see resolveCookiesFile above). Unset by default --
  // ytdlp.js runs without cookies until one of the two is set.
  ytdlpCookiesFile: resolveCookiesFile(),
  maxConcurrentDownloads: int("MAX_CONCURRENT_DOWNLOADS", 0),
  // Telegram's own per-account throttle, not a cap we invent: teleproto already
  // opens up to 8 parallel connections per download and grows the window
  // automatically. Raising this trades a small chance of an extra FLOOD_WAIT
  // for more throughput on fast links; 0 leaves the library's own default.
  maxDownloadSessions: int("TELEGRAM_MAX_DOWNLOAD_SESSIONS", 0),
  // How many times one downloaded chunk may be retried (a flood wait counts)
  // before the whole file is given up on and restarted. See telegram.js.
  downloadChunkRetries: int("TELEGRAM_DOWNLOAD_CHUNK_RETRIES", 60),
  // How long the forwarder waits between messages by choice, to stay well
  // under Telegram's flood limits. Any FLOOD_WAIT Telegram actually returns is
  // honored in full regardless of this value -- see floodRetry.js.
  forwardPauseMs: int("FORWARD_PAUSE_MS", 1500),
  // teleproto itself already sleeps out any FLOOD_WAIT at or under this many
  // seconds, transparently, for every single API call the client makes --
  // not just the ones floodRetry.js wraps. Its own default is a conservative
  // 60s; raising it here gives that blanket coverage to scanning, entity
  // lookups and everything else, while floodRetry.js still catches the rarer
  // waits that land above it (for the download/forward calls it wraps).
  floodSleepThresholdSeconds: int("TELEGRAM_FLOOD_SLEEP_THRESHOLD", 300),
  // Default per platform, so Windows does not end up with a stray C:\tmp.
  downloadDir: str("DOWNLOAD_DIR") || path.join(os.tmpdir(), "tg-downloads"),
};
