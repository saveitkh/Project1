/**
 * The Telegram bot people actually talk to: a menu, a quota, referrals, and
 * one job -- send it a link, get the video back.
 *
 * Two kinds of link are handled, and the difference matters:
 *   - a Telegram post link (t.me/...) is fetched through the shared userbot
 *     (telegram.js), since only a real account can read a group's media;
 *   - anything else (YouTube, Facebook, TikTok, a direct .mp4/.m3u8, ...) is
 *     queued into the same url_list_items pipeline the web app uses, and
 *     botJobs.notifyFinishedJobs() sends the result back when it lands.
 *
 * Reuses the same bot token as the Login Widget / payment notifications
 * (config.telegramLoginBotToken) so there is only one bot to set up.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { actionForLabel, languageKeyboard, mainKeyboard, progressBar, texts } from "./botText.js";
import * as ai from "./ai.js";
import * as aiCredits from "./aiCredits.js";
import * as botDeliver from "./botDeliver.js";
import * as botJobs from "./botJobs.js";
import * as botPay from "./botPay.js";
import * as emojiMaker from "./emojiMaker.js";
import * as khInvoice from "./khInvoice.js";
import * as translate from "./translate.js";
import * as watch from "./watch.js";
import { db, nowIso, rows } from "./db.js";
import { withFloodRetry } from "./floodRetry.js";
import { call, clearScreens } from "./notifyBot.js";
import * as r2 from "./r2.js";
import { mediaInfo } from "./scanner.js";
import { getClient, getClientForChat, isAuthorized, listAccounts, parseTelegramLink, TelegramBusyError } from "./telegram.js";

// Telegram's own Bot API cap for a bot sending a file -- not configurable,
// and well below what the userbot itself can fetch, so this only limits the
// reply, not the download.
const BOT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const URL_PATTERN = /https?:\/\/\S+/i;
const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "profile");

async function send(chatId, text, extra = {}) {
  return call("sendMessage", { chat_id: chatId, text, ...extra });
}

/** Uploads a local file to the chat via multipart/form-data -- sendMessage's JSON body can't carry bytes. */
async function sendFile(chatId, method, filePath) {
  if (!config.telegramLoginBotToken) return null;
  const buffer = await fs.readFile(filePath);
  const field = method === "sendVideo" ? "video" : method === "sendAudio" ? "audio" : "document";
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set(field, new Blob([buffer]), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/${method}`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error(`Telegram ${method} failed:`, JSON.stringify(data));
  return data;
}

// --------------------------------------------------------------- bot users

/**
 * Finds or creates this person's row, and settles the referral on the very
 * first /start: referred_by is written once and never rewritten, so nobody
 * can re-enter through a second link to hand out another bonus.
 */
async function ensureUser(from, startPayload) {
  const id = from.id;
  const existing = rows(
    await db().from("bot_users").select("*").eq("telegram_user_id", id).limit(1)
  )[0];

  if (existing) {
    await db()
      .from("bot_users")
      .update({
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        last_seen_at: nowIso(),
        updated_at: nowIso(),
      })
      .eq("telegram_user_id", id);
    return existing;
  }

  const referrer = await resolveReferrer(startPayload, id);
  const created = rows(
    await db()
      .from("bot_users")
      .insert({
        telegram_user_id: id,
        username: from.username ?? null,
        first_name: from.first_name ?? null,
        language: from.language_code === "en" ? "en" : "km",
        referred_by: referrer,
      })
      .select("*")
  )[0];

  if (referrer) await rewardReferrer(referrer, from);
  return created;
}

/** The referrer id in a "ref_<id>" start payload, if it names a real, different user. */
async function resolveReferrer(startPayload, selfId) {
  const match = /^ref_(\d+)$/.exec(String(startPayload ?? "").trim());
  if (!match) return null;
  const referrer = Number(match[1]);
  if (!Number.isFinite(referrer) || referrer === selfId) return null;
  const found = rows(
    await db().from("bot_users").select("telegram_user_id").eq("telegram_user_id", referrer).limit(1)
  );
  return found[0] ? referrer : null;
}

async function rewardReferrer(referrerId, newUser) {
  const referrer = rows(
    await db().from("bot_users").select("*").eq("telegram_user_id", referrerId).limit(1)
  )[0];
  if (!referrer) return;

  await db()
    .from("bot_users")
    .update({
      bonus_downloads: referrer.bonus_downloads + config.botReferralBonus,
      updated_at: nowIso(),
    })
    .eq("telegram_user_id", referrerId);

  const t = texts(referrer.language);
  await send(referrerId, t.referralJoined(newUser.first_name || newUser.username || newUser.id));
}

// ------------------------------------------------------------------ quota

async function usageFor(telegramUserId) {
  const found = rows(
    await db().from("bot_link_downloads").select("*").eq("telegram_user_id", telegramUserId).limit(1)
  );
  return found[0] ?? null;
}

async function incrementUsage(telegramUserId, existing) {
  if (existing) {
    await db()
      .from("bot_link_downloads")
      .update({ free_used: existing.free_used + 1, updated_at: nowIso() })
      .eq("telegram_user_id", telegramUserId);
  } else {
    await db().from("bot_link_downloads").insert({ telegram_user_id: telegramUserId, free_used: 1 });
  }
}

/**
 * Counts one Telegram download against this person's Credit and tells them
 * what is left, so a balance never runs out unannounced. VIP is not counted.
 */
async function chargeCredit(chatId, user, quota) {
  if (quota.premium) return;
  await incrementUsage(user.telegram_user_id, quota.usage);
  await send(chatId, texts(user.language).creditUsed(Math.max(quota.left - 1, 0), quota.total));
}

/**
 * What this person may still download from TELEGRAM -- the only thing that
 * is counted. YouTube, Facebook, TikTok and the rest are free and unlimited,
 * because they cost nothing but bandwidth; a Telegram link runs through the
 * operator's own accounts and can pull a paid group's videos, so that is
 * what the trial and the packs meter.
 *
 * The free trial (BOT_FREE_DOWNLOADS), referral bonus and bought packs all
 * pool into one number; a running VIP period means no limit at all (left is
 * Infinity, and nothing is counted down).
 */
async function quotaFor(user) {
  const usage = await usageFor(user.telegram_user_id);
  const used = usage?.free_used ?? 0;
  const total = config.botFreeDownloads + (user.bonus_downloads ?? 0) + (user.paid_downloads ?? 0);
  if (botPay.isPremium(user)) return { usage, total, used, left: Infinity, premium: true };
  return { usage, total, used, left: Math.max(total - used, 0), premium: false };
}

// ------------------------------------------------------------ menu screens

async function showAccount(chatId, user) {
  const t = texts(user.language);
  const quota = await quotaFor(user);
  // No parse_mode anywhere in the bot: a username like "Lyna_produ" is an
  // unclosed italic marker to Telegram's legacy Markdown, and it rejects the
  // whole message ("Can't find end of the entity") rather than the one word.
  // Nothing here needs formatting enough to risk a screen that never arrives.
  const lines = [
    `{:m_account:} ${t.accountTitle}`,
    "",
    `├ ${t.fieldId}: ${user.telegram_user_id}`,
    `├ ${t.fieldUsername}: ${user.username ? "@" + user.username : "—"}`,
    `├ ${t.fieldLanguage}: ${user.language === "en" ? "English" : "ភាសាខ្មែរ"}`,
    `├ ${t.fieldPlan}: ${quota.premium ? t.planVip(new Date(user.premium_until).toISOString().slice(0, 10)) : t.planFree}`,
    `├ 🆓 YT · FB · IG · TikTok: ♾ ${t.unlimited}`,
    `└ {:credit:} Credit (Telegram): ${quota.premium ? `♾ ${t.unlimited}` : `${progressBar(quota.left, quota.total)} ${quota.left} / ${quota.total}`}`,
  ];
  // History, language and help live here rather than on the main keyboard.
  await send(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: t.btnHistory, emoji: "m_history", callback_data: "bot:acct:history" }, { text: t.btnLanguage, emoji: "m_language", callback_data: "bot:acct:language" }],
        [{ text: t.btnHelp, emoji: "m_help", callback_data: "bot:acct:help" }],
      ],
    },
  });
}

async function showHistory(chatId, user) {
  const t = texts(user.language);
  const jobs = await botJobs.recentJobs(user.telegram_user_id, 10);
  if (jobs.length === 0) {
    await send(chatId, t.historyEmpty);
    return;
  }
  const icon = (status) =>
    status === "completed" ? "✅" : status === "failed" ? "❌" : status === "downloading" ? "⏳" : "🕐";
  const lines = jobs.map((job) => `${icon(job.item?.status)} ${job.source_url.slice(0, 60)}`);
  await send(chatId, `{:m_history:} ${t.historyTitle}\n\n${lines.join("\n")}`);
}

async function showReferral(chatId, user, botUsername) {
  const t = texts(user.language);
  const count = rows(
    await db().from("bot_users").select("telegram_user_id").eq("referred_by", user.telegram_user_id)
  ).length;
  const link = `https://t.me/${botUsername}?start=ref_${user.telegram_user_id}`;
  await send(chatId, `{:m_referral:} ${t.referralTitle}\n\n${t.referralBody(count, config.botReferralBonus, link)}`);
}

/**
 * The bot's own @username, needed to build a referral link. Asked once and
 * kept for the life of the process -- it cannot change under us.
 */
let cachedBotUsername = null;
async function botUsername() {
  if (cachedBotUsername) return cachedBotUsername;
  const me = await call("getMe", {});
  cachedBotUsername = me?.result?.username ?? "";
  return cachedBotUsername;
}

// ----------------------------------------------------------------- updates

/** Handles one incoming Telegram `message` update. */
export async function handleMessage(message) {
  const chatId = message?.chat?.id;
  const from = message?.from;
  const text = String(message?.text ?? "").trim();
  if (!chatId || !from?.id) return;

  const startPayload = /^\/start(?:\s+(\S+))?$/.exec(text)?.[1] ?? null;
  const user = await ensureUser(from, startPayload);
  const t = texts(user.language);

  // A GIF / video / photo / link for the Emoji Maker (while it waits for
  // one, or captioned /emoji). Before the photo handling: a photo it waits
  // for is an emoji, not a payment screenshot.
  if (text !== "/emoji" && !/^\/start\b/.test(text) && !actionForLabel(text) && (await emojiMaker.handleMessage(message, user))) return;

  // A photo captioned /setshow, from the operator: the show's poster,
  // downloaded and turned into a custom emoji for it (see watch.setShow).
  if (message.photo && botPay.isAdminChat(chatId)) {
    // The photo the 🖼 "Set poster" button asked for.
    const posterFor = !message.caption ? watch.takePendingPoster(chatId) : null;
    if (posterFor) {
      try {
        const fileId = message.photo[message.photo.length - 1].file_id;
        await send(chatId, await watch.setPoster(posterFor, await fetchTelegramPhoto(fileId), fileId));
      } catch (err) {
        await send(chatId, `⚠️ ${err?.message ?? err}`);
      }
      return;
    }
    const setShow = /^\/setshow\s+(\S+)\s+(anime|donghua|movie)(?:\s+(ongoing|completed))?(?:\s+(\d+))?$/i.exec(
      String(message.caption ?? "").trim()
    );
    if (setShow) {
      try {
        const fileId = message.photo[message.photo.length - 1].file_id;
        const buffer = await fetchTelegramPhoto(fileId);
        await send(chatId, await watch.setShow(setShow[1], setShow[2].toLowerCase(), setShow[3]?.toLowerCase(), setShow[4], buffer, fileId));
      } catch (err) {
        await send(chatId, `⚠️ ${err?.message ?? err}`);
      }
      return;
    }
  }

  // A photo is a payment screenshot, or -- from the operator, captioned
  // /setqr -- the bank QR orders are built from. Checked before the text
  // handling below, since a photo usually has no text at all.
  // A photo (or text) while a SaveIt AI model is chosen goes to the AI --
  // ahead of the payment handler, which would otherwise claim any photo.
  if (message.photo && !actionForLabel(text)) {
    const caption = String(message.caption ?? "").trim();
    if (ai.isActive(chatId)) {
      let photo = null;
      try {
        photo = await fetchTelegramPhoto(message.photo[message.photo.length - 1].file_id);
      } catch (err) {
        console.error("AI photo download failed:", err?.message ?? err);
      }
      if (await ai.handleMessage(chatId, user, caption, photo)) return;
    }
  }

  if (message.photo && (await botPay.handlePhoto(message, user))) return;

  // A message forwarded out of the storage channel names it, so the operator
  // never has to dig a raw -100... id out of Telegram.
  if (message.forward_from_chat && botPay.isAdminChat(chatId)) {
    await send(chatId, await botDeliver.setStorageFromForward(message));
    return;
  }

  if (startPayload && (await khInvoice.handleStart(chatId, user, startPayload))) return;

  if (/^\/start\b/.test(text) || text === "/help" || !text) {
    const name = from.first_name || from.username || "";
    await send(chatId, t.welcome(name), { reply_markup: mainKeyboard(user.language) });
    return;
  }

  if (await handleAdminCommand(chatId, text)) return;
  if (await botPay.handleAdminPayCommand(chatId, text)) return;

  if (await khInvoice.handleSectionButton(chatId, user, text, mainKeyboard(user.language))) return;

  const watchButton = await watch.handleSectionButton(chatId, user, text);
  if (watchButton === "dlcredit") return botPay.showPackages(chatId, user, await quotaFor(user));
  if (watchButton) return;
  if (await watch.handleListButton(chatId, user, text)) return;

  const action = actionForLabel(text) ?? commandAction(text);
  if (action) {
    khInvoice.cancelPending(chatId);
    watch.cancelPending(chatId);
    if (action !== "emoji") emojiMaker.cancel(chatId);
    if (action !== "translate") translate.cancel(chatId);
    if (action !== "ai") ai.cancel(chatId);
    // A new section replaces the last one: its screens and the tapped
    // button's own message go, so only what was just asked for is shown.
    await clearScreens(chatId, message.message_id);
  }
  switch (action) {
    case "emoji":
      return emojiMaker.ask(chatId, user);
    case "translate":
      return translate.ask(chatId, user);
    case "ai":
      return ai.ask(chatId, user);
    case "invoice":
      return khInvoice.enterSection(chatId, user);
    case "watch":
      return watch.showGenres(chatId, user);
    case "account":
      return showAccount(chatId, user);
    case "history":
      return showHistory(chatId, user);
    case "referral":
      return showReferral(chatId, user, await botUsername());
    case "language":
      return send(chatId, t.languagePrompt, { reply_markup: languageKeyboard() });
    case "help":
      return send(chatId, t.help);
    case "free":
      return send(chatId, t.freeScreen());
    case "premium":
      return send(chatId, await proScreen(user, t));
    case "buy": {
      const quota = await quotaFor(user);
      return botPay.showPackages(chatId, user, quota);
    }
    case "app":
      return send(chatId, config.webAppUrl ? t.openApp(config.webAppUrl) : t.openAppMissing);
    default:
      break;
  }

  if (await ai.handleMessage(chatId, user, text, null)) return;

  const url = URL_PATTERN.exec(text)?.[0];
  if (url) {
    khInvoice.cancelPending(chatId);
    translate.cancel(chatId);
  } else if (await translate.handleText(chatId, user, text)) return;
  else if (await watch.handleText(chatId, user, text)) return; // an EP number, a show being open
  else if (await khInvoice.handleText(chatId, user, text)) return;
  if (!url) {
    await send(chatId, t.notALink, { reply_markup: mainKeyboard(user.language) });
    return;
  }

  // "…link audio" (or ជាសំឡេង) asks for the soundtrack only -- the same
  // audio_only quality the web app's quick-download box offers.
  const audioOnly = /\b(audio|mp3|សំឡេង)\b/i.test(text.replace(url, ""));

  // SaveIt Pro: a Telegram link is metered (see quotaFor).
  if (/^https?:\/\/(t\.me|telegram\.me)\//i.test(url)) {
    await sendTelegramPost(chatId, user, url, await quotaFor(user));
    return;
  }

  // SaveIt Free: everything else, never counted.
  try {
    await botJobs.createUrlJob({ telegramUserId: user.telegram_user_id, chatId, url, audioOnly });
    await send(chatId, t.queued);
  } catch (err) {
    console.error("Bot URL job failed:", err?.message ?? err);
    await send(chatId, t.failed(String(err?.message ?? err).slice(0, 200)));
  }
}

/**
 * Operator-only commands, answered only in the operator's own chat
 * (TELEGRAM_ADMIN_CHAT_ID). Returns true when it handled the message, so an
 * ordinary user typing /stats just falls through to the link handling.
 */
async function handleAdminCommand(chatId, text) {
  if (!config.telegramAdminChatId || String(chatId) !== String(config.telegramAdminChatId)) return false;

  if (text === "/aimodels") {
    try {
      await send(chatId, await ai.describeModels());
    } catch (err) {
      await send(chatId, `⚠️ ${err?.message ?? err}`);
    }
    return true;
  }

  // /aigive <telegram user id> <credits>: AI Credit by hand (a refund, a
  // gift, or a paid order whose grant failed). Negative takes it back.
  const aiGive = /^\/aigive\s+(\d+)\s+(-?\d+)$/.exec(text);
  if (aiGive) {
    try {
      const left = await aiCredits.grant(aiGive[1], Number(aiGive[2]));
      await send(chatId, `✅ ${aiGive[1]}: ${Number(aiGive[2]) >= 0 ? "+" : ""}${aiGive[2]} AI Credit → ${left}`);
    } catch (err) {
      await send(chatId, `⚠️ ${err?.message ?? err}`);
    }
    return true;
  }
  if (text === "/aigive" || text === "/aicredit") {
    await send(chatId, "/aigive <telegram user id> <credits> — add (or, negative, remove) AI Credit\n/aicredit <telegram user id> — show a balance\n/aimodels — models, prices, free Credit");
    return true;
  }
  const aiCredit = /^\/aicredit\s+(\d+)$/.exec(text);
  if (aiCredit) {
    const { free, paid } = await aiCredits.balance(aiCredit[1]);
    await send(chatId, `${aiCredit[1]}: 🎁 ${free} free today · 💳 ${paid} bought`);
    return true;
  }

  if (text === "/stats") {
    const users = rows(await db().from("bot_users").select("telegram_user_id, created_at"));
    const jobs = rows(await db().from("bot_jobs").select("id, created_at"));
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = (list) => list.filter((r) => new Date(r.created_at).getTime() >= since).length;
    await send(
      chatId,
      `{:admin:} Bot stats\n\n` +
        `Users: ${users.length} (+${recent(users)} this week)\n` +
        `Link downloads: ${jobs.length} (+${recent(jobs)} this week)`
    );
    return true;
  }

  const setStorage = /^\/setstorage(?:\s+(-?\d+))?$/i.exec(text);
  if (setStorage) {
    await send(
      chatId,
      setStorage[1]
        ? await botDeliver.saveStorageChat(setStorage[1], null)
        : await botDeliver.setStorageFromForward(null)
    );
    return true;
  }

  const setBotPic = /^\/setbotpic(?:\s+(\S+))?$/i.exec(text);
  if (setBotPic) {
    await send(chatId, await setBotProfileVideo(setBotPic[1]));
    return true;
  }

  const speedTest = /^\/dlspeed(?:\s+(\S+))?$/i.exec(text);
  if (speedTest) {
    await send(chatId, await benchmarkDownload(speedTest[1]));
    return true;
  }

  const watchGroup = /^\/watchgroup(?:\s+(\S+))?$/i.exec(text);
  if (watchGroup) {
    if (!watchGroup[1]) {
      await send(chatId, watch.ADMIN_HELP);
      return true;
    }
    await send(chatId, "⏳ កំពុង scan Group… (Group ធំអាចចំណាយពេលពីរបីនាទី)");
    try {
      await sendLong(chatId, await watch.addOrScanGroup(watchGroup[1]));
    } catch (err) {
      await send(
        chatId,
        `⚠️ Scan មិនបាន៖ ${String(err?.message ?? err).slice(0, 200)}\n\n` +
          "ពិនិត្យ៖ គណនី userbot ជាសមាជិក Group នោះហើយឬនៅ? link/id ត្រឹមត្រូវទេ?"
      );
    }
    return true;
  }

  if (/^\/setshow\b/i.test(text) && !/^\/setshow\s+\S+\s+(anime|donghua|movie)\b/i.test(text)) {
    await send(chatId, watch.ADMIN_HELP);
    return true;
  }

  if (text === "/shows") {
    await sendLong(chatId, await watch.listAllTopics());
    return true;
  }

  const setGroup = /^\/setgroup(?:\s+(\S+)\s+(anime|donghua|movie)(?:\s+(ongoing|completed))?(?:\s+(\d+))?)?$/i.exec(text);
  if (setGroup) {
    if (!setGroup[1]) {
      await send(chatId, watch.ADMIN_HELP);
      return true;
    }
    try {
      await send(chatId, await watch.setGroupKind(setGroup[1], setGroup[2].toLowerCase(), setGroup[3]?.toLowerCase(), setGroup[4]));
    } catch (err) {
      await send(chatId, `⚠️ ${err?.message ?? err}`);
    }
    return true;
  }

  const setShow = /^\/setshow\s+(\S+)\s+(anime|donghua|movie)(?:\s+(ongoing|completed))?(?:\s+(\d+))?$/i.exec(text);
  if (setShow) {
    try {
      await send(chatId, await watch.setShow(setShow[1], setShow[2].toLowerCase(), setShow[3]?.toLowerCase(), setShow[4]));
    } catch (err) {
      await send(chatId, `⚠️ ${err?.message ?? err}`);
    }
    return true;
  }



  const broadcast = /^\/broadcast\s+([\s\S]+)$/.exec(text);
  if (broadcast) {
    const message = broadcast[1];
    const users = rows(await db().from("bot_users").select("telegram_user_id").eq("blocked", false));
    let delivered = 0;
    for (const user of users) {
      const result = await send(user.telegram_user_id, message);
      if (result?.ok) delivered += 1;
      // Telegram throttles a bot to ~30 messages a second; a small gap keeps a
      // broadcast to a few thousand people from tripping it.
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await send(chatId, `📣 Sent to ${delivered}/${users.length}.`);
    return true;
  }

  return false;
}

/**
 * Sets the bot's own profile to one of the spinning logo loops in
 * assets/profile. BotFather's Edit Botpic only takes a still photo; the Bot
 * API's setMyProfilePhoto takes an animated one (an MP4 of up to 5 s at
 * 640x640), uploaded fresh each time -- a file_id cannot be reused here.
 */
/**
 * /dlspeed alone: which connected account(s) have Telegram Premium (the
 * flag that raises Telegram's own per-connection speed cap -- nothing this
 * bot's code can grant or fake). /dlspeed <t.me/... link>: also downloads
 * that post's media through the userbot -- the same client.downloadMedia
 * path a fallback link download uses (skipping the forward-to-storage
 * shortcut, which never touches this code at all) -- and times it, so
 * "is it faster now" has a real MB/s next to it instead of a guess.
 */
async function benchmarkDownload(link) {
  const lines = ["⚡ Download speed"];
  const accounts = [
    { id: null, label: "default" },
    ...(await listAccounts()).map((a) => ({ id: a.id, label: a.label || a.phone || a.id })),
  ];
  for (const { id, label } of accounts) {
    try {
      const client = await getClient({ accountId: id, requireAuth: false });
      if (!(await client.isUserAuthorized())) continue;
      const me = await client.getMe();
      lines.push(`${me.premium ? "💎 Premium" : "◻️ Free"} · ${label} (@${me.username || me.id})`);
    } catch (err) {
      lines.push(`⚠️ ${label}: ${err?.message ?? err}`);
    }
  }

  if (link) {
    lines.push("");
    try {
      const parsed = parseTelegramLink(link);
      const { client, entity, accountId } = await getClientForChat(parsed.chatId);
      const found = await withFloodRetry(() => client.getMessages(entity, { ids: parsed.messageId }), {
        label: `speed test fetch ${parsed.chatId}/${parsed.messageId}`,
      });
      const msg = Array.isArray(found) ? found[0] : found;
      const info = msg?.media ? mediaInfo(msg) : null;
      if (!info) {
        lines.push("⚠️ That message has no downloadable media.");
        return lines.join("\n");
      }
      const account = accounts.find((a) => a.id === accountId);
      const me = await client.getMe();
      await fs.mkdir(config.downloadDir, { recursive: true });
      const localPath = path.join(config.downloadDir, `speedtest-${Date.now()}-${info.fileName}`);
      const started = Date.now();
      try {
        await withFloodRetry(() => client.downloadMedia(msg, { outputFile: localPath }), {
          label: `speed test download ${parsed.chatId}/${parsed.messageId}`,
        });
        const elapsedS = (Date.now() - started) / 1000;
        const { size } = await fs.stat(localPath);
        const mb = size / (1024 * 1024);
        lines.push(
          `Downloaded via ${account?.label ?? "default"} (${me.premium ? "💎 Premium" : "◻️ Free"}):\n` +
            `${mb.toFixed(1)} MB in ${elapsedS.toFixed(1)}s → ${(mb / Math.max(elapsedS, 0.01)).toFixed(2)} MB/s`
        );
      } finally {
        await fs.rm(localPath, { force: true }).catch(() => {});
      }
    } catch (err) {
      lines.push(`⚠️ Test download failed: ${err?.message ?? err}`);
    }
  } else {
    lines.push("", "Send /dlspeed <t.me/…> with a link to a video to also time a real download through it.");
  }
  return lines.join("\n");
}

/** Downloads a Telegram-hosted photo's bytes, for /setshow's poster. */
/** Sends text over Telegram's 4096-character limit as several messages, split on lines. */
async function sendLong(chatId, text, limit = 3800) {
  let chunk = "";
  for (const line of String(text).split("\n")) {
    if (chunk && chunk.length + line.length + 1 > limit) {
      await send(chatId, chunk);
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  if (chunk) await send(chatId, chunk);
}

async function fetchTelegramPhoto(fileId) {
  const info = await call("getFile", { file_id: fileId });
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error("Telegram did not return the file.");
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramLoginBotToken}/${filePath}`);
  if (!res.ok) throw new Error(`Downloading the photo failed (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

async function setBotProfileVideo(which) {
  if (!config.telegramLoginBotToken) return "⚠️ No bot token is set.";
  const name = /^(kh|inv|invoice)/i.test(which ?? "") ? "kh-invoice-logo" : "saveit-logo";
  let buffer;
  try {
    buffer = await fs.readFile(path.join(PROFILE_DIR, `${name}.mp4`));
  } catch {
    return `⚠️ assets/profile/${name}.mp4 is missing.`;
  }
  const form = new FormData();
  // The frame shown where the profile can't play: the logo at rest, face on,
  // after its turn (the loop is 2.4 s and the turn ends just past 1.3 s).
  form.set("photo", JSON.stringify({ type: "animated", animation: "attach://logo", main_frame_timestamp: 1.9 }));
  form.set("logo", new Blob([buffer], { type: "video/mp4" }), `${name}.mp4`);
  const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/setMyProfilePhoto`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("Telegram setMyProfilePhoto failed:", JSON.stringify(data));
    return `⚠️ Telegram refused it: ${String(data.description ?? res.status).slice(0, 200)}`;
  }
  return `✅ Bot profile set to ${name}.mp4 — reopen the chat to see it spin.`;
}

/** Slash commands, for anyone who prefers typing to tapping. */
function commandAction(text) {
  switch (text.split(/\s+/)[0].toLowerCase()) {
    case "/account": return "account";
    case "/history": return "history";
    case "/referral": return "referral";
    case "/language": return "language";
    case "/app": return "app";
    case "/buy": return "buy";
    case "/free": return "free";
    case "/premium": return "premium";
    case "/invoice": return "invoice";
    case "/emoji": return "emoji";
    case "/translate": return "translate";
    case "/ai": return "ai";
    default: return null;
  }
}

/** The language buttons under "🌐 ភាសា". Returns true when it handled the tap. */
export async function handleCallback(cq) {
  const data = String(cq?.data ?? "");
  if (data.startsWith("inv:") && cq.from?.id) {
    return khInvoice.handleCallback(cq, await ensureUser(cq.from, null));
  }
  if (data === "watch:dlcredit" && cq.from?.id) {
    // "Credit for Private downloads" from inside the shows section: the
    // same packages as the main menu's Credit button.
    const user = await ensureUser(cq.from, null);
    await call("answerCallbackQuery", { callback_query_id: cq.id });
    return botPay.showPackages(cq.message.chat.id, user, await quotaFor(user));
  }
  if (data.startsWith("ai:") && cq.from?.id) {
    return ai.handleCallback(cq, await ensureUser(cq.from, null));
  }
  if (data.startsWith("watch:") && cq.from?.id) {
    return watch.handleCallback(cq, await ensureUser(cq.from, null));
  }
  if (!data.startsWith("bot:")) return false;

  const [, kind, value] = data.split(":");
  const chatId = cq.message?.chat?.id;
  const userId = cq.from?.id;
  if (!chatId || !userId) return false;

  if (kind === "acct") {
    const user = await ensureUser(cq.from, null);
    const t = texts(user.language);
    await call("answerCallbackQuery", { callback_query_id: cq.id });
    if (value === "history") await showHistory(chatId, user);
    else if (value === "language") await send(chatId, t.languagePrompt, { reply_markup: languageKeyboard() });
    else await send(chatId, t.help);
    return true;
  }

  if (kind !== "lang") {
    const user = await ensureUser(cq.from, null);
    // Buying: the receipt screenshot that follows is for the payment, not
    // a question for an AI model still waiting in this chat.
    if (kind === "buy" || kind === "bank") ai.cancel(chatId);
    return botPay.handlePayCallback(cq, user);
  }

  const language = value === "en" ? "en" : "km";
  await db()
    .from("bot_users")
    .update({ language, updated_at: nowIso() })
    .eq("telegram_user_id", userId);

  await call("answerCallbackQuery", { callback_query_id: cq.id });
  await send(chatId, texts(language).languageSet, { reply_markup: mainKeyboard(language) });
  return true;
}

const isAdminChat = (chatId) =>
  Boolean(config.telegramAdminChatId) && String(chatId) === String(config.telegramAdminChatId);

/** Whether any Telegram account at all can be used right now. */
async function anyAccountSignedIn() {
  if (await isAuthorized()) return true;
  for (const account of await listAccounts()) {
    if (account.connected && (await isAuthorized(account.id))) return true;
  }
  return false;
}

/**
 * Tells the operator the userbot is signed out, at most once an hour: a
 * customer hitting it is the first sign anyone gets, and without this it
 * sat broken until somebody happened to look at the logs.
 */
let lastOfflineAlertAt = 0;
const OFFLINE_ALERT_EVERY_MS = 60 * 60 * 1000;

async function alertOperatorOffline() {
  if (!config.telegramAdminChatId) return;
  const now = Date.now();
  if (now - lastOfflineAlertAt < OFFLINE_ALERT_EVERY_MS) return;
  lastOfflineAlertAt = now;
  const appLink = config.webAppUrl ? `\n\n${config.webAppUrl}` : "";
  await send(
    config.telegramAdminChatId,
    "⚠️ Userbot ផ្ដាច់ — អតិថិជនម្នាក់ព្យាយាមទាញយកតំណ Telegram តែគ្មានគណនីណាមួយ sign in ទេ។\n\n" +
      "សូមចូលម្ដងទៀត៖ បើកកម្មវិធី → ការកំណត់ → Telegram → Connect" +
      appLink
  );
}

/**
 * Whether a Telegram link may go through. The operator always may.
 * BOT_PRIVATE_LINKS="admin" switches Telegram links off for everyone else;
 * "all" lets everyone through uncounted; the default meters them against
 * the free trial, referral bonus and bought packs, with VIP unlimited.
 */
function telegramAccess(chatId, quota) {
  if (isAdminChat(chatId)) return "ok";
  if (config.botPrivateLinks === "admin") return "off";
  if (config.botPrivateLinks === "all") return "ok";
  return quota.premium || quota.left > 0 ? "ok" : "used-up";
}

/** The Pro screen: trial progress, VIP, or trial spent. */
async function proScreen(user, t) {
  const quota = await quotaFor(user);
  if (quota.premium) {
    return t.proScreenVip(new Date(user.premium_until).toISOString().slice(0, 10)) + t.proOwnAccount;
  }
  if (quota.left <= 0) return t.proScreenEmpty(progressBar(quota.total, quota.total), quota.total);
  return (
    t.proScreenTrial(progressBar(quota.used, quota.total), quota.used, quota.total, quota.left) +
    t.proOwnAccount
  );
}

/**
 * The original flow: one Telegram post link in, its media back. Runs through
 * the shared userbot, since a bot cannot read a group it isn't in.
 */
async function sendTelegramPost(chatId, user, url, quota) {
  const t = texts(user.language);

  if (/t\.me\/(\+|joinchat\/)/i.test(url)) {
    await send(chatId, t.inviteLink);
    return;
  }

  let parsed;
  try {
    parsed = parseTelegramLink(url);
  } catch {
    await send(chatId, t.notALink);
    return;
  }
  if (!parsed.messageId) {
    await send(chatId, t.notALink);
    return;
  }

  // Every Telegram link, public channel or private group alike, runs through
  // the operator's own accounts -- so every one is metered, not just t.me/c.
  const access = telegramAccess(chatId, quota);
  if (access === "off") {
    await send(chatId, t.privateVipOnly);
    return;
  }
  if (access === "used-up") {
    await send(chatId, t.quotaOver(quota.total));
    return;
  }

  let client;
  let entity;
  try {
    ({ client, entity } = await getClientForChat(parsed.chatId));
  } catch (err) {
    // Three different failures used to share one message -- "the bot's
    // account isn't a member" -- which was wrong for two of them and sent
    // people chasing group membership when the userbot was simply offline.
    if (err instanceof TelegramBusyError) {
      await send(chatId, t.telegramBusy);
    } else if (!(await anyAccountSignedIn())) {
      await send(chatId, t.telegramOffline);
      await alertOperatorOffline();
    } else {
      await send(chatId, t.privateNoAccess);
    }
    return;
  }

  await send(chatId, t.working);

  // Fastest and best path: have the userbot forward the post into the storage
  // channel and let the bot copy it from there. Telegram moves its own file,
  // so the person gets a real, playable video of any size in seconds -- no
  // download here, and none of the Bot API's 50MB upload limit. Everything
  // below is the fallback for when that isn't set up (or the source group
  // forbids forwarding).
  const delivered = await botDeliver.deliverTelegramPost({
    userChatId: chatId,
    sourceChatId: parsed.chatId,
    messageId: parsed.messageId,
  });
  if (delivered.ok) {
    await chargeCredit(chatId, user, quota);
    return;
  }
  if (delivered.reason === "bot-not-in-storage" && isAdminChat(chatId)) {
    await send(chatId, "⚠️ Storage channel is set, but I'm not an admin of it — add me and try again.");
  }

  let localPath = null;
  try {
    const found = await withFloodRetry(() => client.getMessages(entity, { ids: parsed.messageId }), {
      label: `bot link fetch ${parsed.chatId}/${parsed.messageId}`,
    });
    const msg = Array.isArray(found) ? found[0] : found;
    const info = msg?.media ? mediaInfo(msg) : null;
    if (!info) {
      await send(chatId, t.noMedia);
      return;
    }

    await fs.mkdir(config.downloadDir, { recursive: true });
    localPath = path.join(config.downloadDir, `bot-${user.telegram_user_id}-${Date.now()}-${info.fileName}`);
    await withFloodRetry(() => client.downloadMedia(msg, { outputFile: localPath }), {
      label: `bot link download ${parsed.chatId}/${parsed.messageId}`,
    });

    const { size } = await fs.stat(localPath);
    if (size > BOT_UPLOAD_LIMIT_BYTES) {
      // Over the Bot API's 50MB send limit -- which is every full episode --
      // so it goes to R2 and comes back as a link instead of being refused.
      const key = r2.buildUploadKey(`bot/${user.telegram_user_id}`, info.fileName);
      const link = await r2.upload(localPath, key, info.mimeType);
      const mb = Math.round(size / (1024 * 1024));
      await send(chatId, `${t.tooBig(mb)}\n\n${t.doneWithLink(info.fileName, link)}`);
      await chargeCredit(chatId, user, quota);
      return;
    }

    await sendFile(chatId, info.mediaType === "audio" ? "sendAudio" : "sendVideo", localPath);
    await chargeCredit(chatId, user, quota);
  } catch (err) {
    console.error("Bot link download failed:", err?.message ?? err);
    await send(chatId, t.failed(String(err?.message ?? err).slice(0, 200)));
  } finally {
    if (localPath) await fs.unlink(localPath).catch(() => {});
  }
}
