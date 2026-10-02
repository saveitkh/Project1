/**
 * Free + paid use of the menu bot.
 *
 *   {:diamond:} Buy  →  pick a package  →  a KHQR for that exact amount arrives
 *   →  pay in ABA / any Bakong bank  →  confirmed one of two ways:
 *        - automatically, when BAKONG_API_TOKEN is set: the worker asks
 *          Bakong whether that exact QR (by md5) has been paid, for the
 *          right amount;
 *        - by the operator, who gets the payer's screenshot with
 *          Approve / Reject buttons.
 *
 * The QR is the owner's own bank QR with only the amount rewritten (see
 * khqr.js), set once by the operator sending it to the bot with /setqr.
 */
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { PNG } from "pngjs";

import { config } from "./config.js";
import { db, nowIso, rows } from "./db.js";
import { paymentSettings, savePaymentSettings } from "./botConfig.js";
import * as aiCredits from "./aiCredits.js";
import { buildPack, decorate, refusedEmoji } from "./customEmoji.js";
import { progressBar } from "./botText.js";
import { applyKhqrTemplate, khqrMd5, parseKhqr, validateKhqrTemplate } from "./khqr.js";
import { renderKhqrCard } from "./khqrCard.js";
import * as khInvoice from "./khInvoice.js";
import * as watch from "./watch.js";
import { call } from "./notifyBot.js";

// A payer has this long to pay one QR before the order lapses. Bakong
// payments land in seconds, so this is only generous for the screenshot path.
const ORDER_TTL_MS = 60 * 60 * 1000;
const BAKONG_BASE = (process.env.BAKONG_API_BASE || "https://api-bakong.nbc.gov.kh").replace(/\/+$/, "");

export function isAdminChat(chatId) {
  return Boolean(config.telegramAdminChatId) && String(chatId) === String(config.telegramAdminChatId);
}

const L = {
  km: {
    creditScreen: (standing) =>
      `{:credit:} Credit របស់អ្នក\n${standing}\n\n` +
      `📌 1 Credit = ទាញវីដេអូ Telegram ឯកជន 1\n` +
      `{:m_free:} YouTube · FB · IG · TikTok — ឥតគិតថ្លៃ មិនប្រើ Credit\n\n` +
      `{:m_buy:} ជ្រើសរើសកញ្ចប់៖`,
    creditLine: (bar, left, total) => `${bar}  នៅសល់ ${left} / ${total} Credit`,
    premiumLine: (until) => `{:m_pro:} VIP មិនកំណត់ — រហូតដល់ ${until}`,
    creditPack: (n) => `+${n} Credit`,
    vipPack: (days) => `VIP ${days} ថ្ងៃ · មិនកំណត់`,
    notReady: "ការទូទាត់មិនទាន់បានរៀបចំនៅឡើយទេ។ សូមទាក់ទងអ្នកគ្រប់គ្រង។",
    qrCaption: (pkg, amount, ticket) =>
      `{:khqr:} ${pkg} — $${amount}\n{:ticket:} ${ticket} · {:wait:} ៦០ នាទី\n\n` +
      `{:camera:} ស្កេនដោយ App ធនាគារណាមួយ៖ {:aba:} {:bankc:} {:wing:} {:bakong:}\n` +
      `{:bulb:} ទូរស័ព្ទតែមួយ៖ ចុចសង្កត់រូប → រក្សាទុក → បើកក្នុង App ធនាគារ\n` +
      `{:ok:} បង់រួច ផ្ញើ screenshot វិក្កយបត្រមកទីនេះ`,
    cancel: "❌ បោះបង់",
    cancelled: "បានបោះបង់ការបញ្ជាទិញ។",
    screenshotReceived: "{:ok:} ទទួលបាន screenshot។ កំពុងរង់ចាំការបញ្ជាក់ — ជាធម្មតាតិចជាងពីរបីនាទី។",
    noPendingOrder: "មិនមានការបញ្ជាទិញកំពុងរង់ចាំទេ។ ចុច {:diamond:} ទិញ ដើម្បីចាប់ផ្ដើម។",
    grantedCredit: (n, left) => `{:party:} ការទូទាត់បានបញ្ជាក់! +${n} Credit\n{:credit:} Credit នៅសល់៖ ${left}\n\nអរគុណ! ផ្ញើតំណ Telegram មកបានឥឡូវនេះ។`,
    grantedVip: (until) => `{:party:} ការទូទាត់បានបញ្ជាក់!\n{:m_pro:} VIP មិនកំណត់ — រហូតដល់ ${until}\n\nអរគុណ! ផ្ញើតំណ Telegram មកបានឥឡូវនេះ។`,
    rejected: "{:fail:} ការទូទាត់មិនត្រូវបានបញ្ជាក់ទេ។ បើអ្នកបានបង់ពិតប្រាកដ សូមទាក់ទងអ្នកគ្រប់គ្រង។",
  },
  en: {
    creditScreen: (standing) =>
      `{:credit:} Your Credit\n${standing}\n\n` +
      `📌 1 Credit = 1 private Telegram video\n` +
      `{:m_free:} YouTube · FB · IG · TikTok — free, no Credit used\n\n` +
      `{:m_buy:} Choose a package:`,
    creditLine: (bar, left, total) => `${bar}  ${left} / ${total} Credit left`,
    premiumLine: (until) => `{:m_pro:} VIP unlimited — until ${until}`,
    creditPack: (n) => `+${n} Credit`,
    vipPack: (days) => `VIP ${days} days · unlimited`,
    notReady: "Payments aren't set up yet. Please contact the operator.",
    qrCaption: (pkg, amount, ticket) =>
      `{:khqr:} ${pkg} — $${amount}\n{:ticket:} ${ticket} · {:wait:} 60 min\n\n` +
      `{:camera:} Scan with any bank app: {:aba:} {:bankc:} {:wing:} {:bakong:}\n` +
      `{:bulb:} Same phone: long-press the picture → save → open it in your bank app\n` +
      `{:ok:} Paid? Send the receipt screenshot here`,
    cancel: "❌ Cancel",
    cancelled: "Order cancelled.",
    screenshotReceived: "{:ok:} Screenshot received. Waiting for confirmation — usually a few minutes.",
    noPendingOrder: "You have no pending order. Tap {:diamond:} Buy to start.",
    grantedCredit: (n, left) => `{:party:} Payment confirmed! +${n} Credit\n{:credit:} Credit left: ${left}\n\nThank you! Send a Telegram link any time.`,
    grantedVip: (until) => `{:party:} Payment confirmed!\n{:m_pro:} VIP unlimited — until ${until}\n\nThank you! Send a Telegram link any time.`,
    rejected: "{:fail:} The payment couldn't be confirmed. If you really paid, please contact the operator.",
  },
};
const t = (language) => L[language] ?? L.km;

// ------------------------------------------------------------- telegram io

/** sendPhoto with bytes (multipart) -- JSON can't carry a generated PNG. */
async function sendPhotoBuffer(chatId, buffer, caption, replyMarkup) {
  // A multipart body sends every "\n" in a text field as "\r\n" (FormData
  // does this on its own), and Telegram checks entity offsets against the
  // text as it arrives -- so every custom emoji after the first line break
  // landed one position off and the whole caption was refused. Counting the
  // "\r"s up front makes the offsets match what is actually sent.
  const crlfCaption = typeof caption === "string" ? caption.replace(/\r?\n/g, "\r\n") : caption;
  const attempt = async (plain) => {
    const body = await decorate({ caption: crlfCaption, reply_markup: replyMarkup }, { plain });
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("photo", new Blob([buffer], { type: "image/png" }), "khqr.png");
    if (body.caption) form.set("caption", body.caption);
    if (body.caption_entities) form.set("caption_entities", JSON.stringify(body.caption_entities));
    if (body.reply_markup) form.set("reply_markup", JSON.stringify(body.reply_markup));
    const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/sendPhoto`, {
      method: "POST",
      body: form,
    });
    return res.json().catch(() => ({}));
  };
  let data = await attempt(false);
  if (!data.ok && refusedEmoji(data)) data = await attempt(true);
  if (!data.ok) console.error("Telegram sendPhoto failed:", JSON.stringify(data));
  return data;
}

/** Downloads a photo the bot was sent, as raw bytes. */
async function fetchTelegramFile(fileId) {
  const info = await call("getFile", { file_id: fileId });
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error("Telegram did not return the file.");
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramLoginBotToken}/${filePath}`);
  if (!res.ok) throw new Error(`Downloading the photo failed (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/** Reads a QR code out of a JPEG/PNG. Null when none is found. */
function decodeQr(buffer) {
  const isPng = buffer.subarray(0, 4).toString("hex") === "89504e47";
  const image = isPng ? PNG.sync.read(buffer) : jpeg.decode(buffer, { useTArray: true });
  const code = jsQR(new Uint8ClampedArray(image.data), image.width, image.height, {
    inversionAttempts: "attemptBoth",
  });
  return code?.data ?? null;
}

// ----------------------------------------------------------------- quota

/** True while a VIP period is running. */
export function isPremium(user) {
  return Boolean(user?.premium_until) && new Date(user.premium_until).getTime() > Date.now();
}

function formatDate(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

/** SaveIt's own packs. KH Invoice plans live in the same table but have their own screen. */
async function packages() {
  const all = rows(await db().from("bot_packages").select("*").eq("active", true).order("sort"));
  return all.filter((pkg) => !khInvoice.isInvoicePackage(pkg.id) && !watch.isWatchPackage(pkg.id) && !aiCredits.isAiPackage(pkg.id));
}

function packageTitle(pkg, language) {
  return language === "en" ? pkg.title_en : pkg.title_km;
}

/**
 * What a SaveIt pack gives, worded from its own numbers ("+30 Credit",
 * "VIP 30 days · unlimited") so a button can never disagree with what is
 * granted. KH Invoice plans keep their own titles.
 */
function packageLabel(pkg, language) {
  if (khInvoice.isInvoicePackage(pkg.id) || watch.isWatchPackage(pkg.id) || aiCredits.isAiPackage(pkg.id)) return packageTitle(pkg, language);
  const s = t(language);
  return pkg.downloads ? s.creditPack(pkg.downloads) : s.vipPack(pkg.days);
}

// ----------------------------------------------------------------- flows

/**
 * "{:credit:} Add Credit": the balance (or VIP), what one Credit buys, then one
 * button per package -- a Credit pack with the Credit icon, VIP with the crown.
 */
export async function showPackages(chatId, user, quota) {
  const s = t(user.language);
  const list = await packages();
  const standing = isPremium(user)
    ? s.premiumLine(formatDate(user.premium_until))
    : s.creditLine(progressBar(quota.left, quota.total), quota.left, quota.total);
  await call("sendMessage", {
    chat_id: chatId,
    text: s.creditScreen(standing),
    reply_markup: {
      inline_keyboard: list.map((pkg) => [
        {
          text: `${pkg.downloads ? "{:credit:}" : "{:m_pro:}"} ${packageLabel(pkg, user.language)} — $${Number(pkg.price_usd).toFixed(2)}`,
          emoji: pkg.downloads ? "credit" : "m_pro",
          style: "success",
          callback_data: `bot:buy:${pkg.id}`,
        },
      ]),
    },
  });
}

function newTicket() {
  return `KH${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36 ** 2).toString(36).toUpperCase().padStart(2, "0")}`;
}

/** The name printed on (and, for a bank that allows it, written into) the QR --
 * one name for every product, so the payer's bank app always shows the same
 * merchant regardless of what they're buying. */
const serviceName = () => "SaveIt KH";

/**
 * A package was tapped: build its QR and send it. One KHQR for everyone --
 * whichever bank the operator registered it with, any bank's own app can
 * scan a standard KHQR to pay it, so there's no "which bank" question for
 * the payer to answer first. (The `bank` param stays for old inline
 * buttons still sitting in someone's chat from before this; see
 * handlePayCallback's "bank" case.)
 */
async function startOrder(chatId, user, packageId, bank = null) {
  const s = t(user.language);
  const [pkg] = rows(await db().from("bot_packages").select("*").eq("id", packageId).eq("active", true).limit(1));
  const [settings] = rows(await db().from("bot_settings").select("khqr_template").eq("id", 1).limit(1));
  const extra = await paymentSettings();
  const primary = settings?.khqr_template ?? null;
  const alt = extra.alt_template ?? null;
  if (!pkg || (!primary && !alt)) {
    await call("sendMessage", { chat_id: chatId, text: s.notReady });
    return;
  }
  const amount = Number(pkg.price_usd);

  const useAlt = (bank === "a" && Boolean(alt)) || !primary;
  const template = useAlt ? alt : primary;
  const built = applyKhqrTemplate(template, amount, {
    merchantName: useAlt && extra.rename_alt ? serviceName() : null,
  });
  if (!built.ok) {
    console.error("Bot KHQR build failed:", built.reason);
    await call("sendMessage", { chat_id: chatId, text: s.notReady });
    return;
  }

  // One live order per person: a new QR replaces an unpaid one rather than
  // leaving two open that could both be screenshotted.
  await db()
    .from("bot_orders")
    .update({ status: "expired" })
    .eq("telegram_user_id", user.telegram_user_id)
    .eq("status", "pending");

  const ticket = newTicket();
  const [order] = rows(
    await db()
      .from("bot_orders")
      .insert({
        ticket,
        telegram_user_id: user.telegram_user_id,
        chat_id: chatId,
        package_id: pkg.id,
        amount_usd: amount,
        khqr: built.payload,
        khqr_md5: khqrMd5(built.payload),
      })
      .select("*")
  );

  const png = await renderKhqrCard(built.payload, { merchantName: serviceName() });
  const keyboard = [[{ text: s.cancel, emoji: "fail", callback_data: `bot:cancel:${order.id}` }]];

  await sendPhotoBuffer(chatId, png, s.qrCaption(packageLabel(pkg, user.language), amount.toFixed(2), ticket), {
    inline_keyboard: keyboard,
  });
}

/** Adds what a paid order bought, and tells the payer. */
async function grant(order, confirmedBy, bankHash = null) {
  // Conditional on still being pending, so a double tap (or Bakong and the
  // operator confirming at the same moment) can only grant once.
  const updated = rows(
    await db()
      .from("bot_orders")
      .update({ status: "paid", paid_at: nowIso(), confirmed_by: confirmedBy, bank_hash: bankHash })
      .eq("id", order.id)
      .eq("status", "pending")
      .select("*")
  );
  if (updated.length === 0) return false;

  const [pkg] = rows(await db().from("bot_packages").select("*").eq("id", order.package_id).limit(1));
  const [user] = rows(
    await db().from("bot_users").select("*").eq("telegram_user_id", order.telegram_user_id).limit(1)
  );
  if (!pkg || !user) return false;

  if (khInvoice.isInvoicePackage(pkg.id)) {
    // Paid for KH Invoice, not for downloads: the order is already marked
    // paid, so if the app can't be reached the operator is told and can
    // retry by hand -- the payer is never charged twice.
    try {
      const until = await khInvoice.activatePlan(order, user);
      await call("sendMessage", { chat_id: order.chat_id, text: khInvoice.grantedText(user.language, until) });
    } catch (err) {
      console.error(`KH Invoice activation for ${order.ticket} failed:`, err?.message ?? err);
      if (config.telegramAdminChatId) {
        await call("sendMessage", {
          chat_id: config.telegramAdminChatId,
          text: `{:warn:} KH Invoice activation failed for paid order ${order.ticket} (user ${order.telegram_user_id}): ${String(err?.message ?? err).slice(0, 300)}\nRetry with /invactivate ${order.ticket}`,
        });
      }
    }
    return true;
  }

  if (aiCredits.isAiPackage(pkg.id)) {
    // AI Credit, its own balance (aiCredits.js). The order is already
    // marked paid, so a failed write is the operator's to fix by hand with
    // /aigive -- the payer is never asked to pay twice.
    try {
      await call("sendMessage", { chat_id: order.chat_id, text: await aiCredits.grantedText(user.language, pkg.downloads, user) });
    } catch (err) {
      console.error(`AI Credit grant for ${order.ticket} failed:`, err?.message ?? err);
      if (config.telegramAdminChatId) {
        await call("sendMessage", {
          chat_id: config.telegramAdminChatId,
          text: `{:warn:} AI Credit grant failed for paid order ${order.ticket}: ${String(err?.message ?? err).slice(0, 300)}\nGive it by hand: /aigive ${user.telegram_user_id} ${pkg.downloads}`,
        });
      }
    }
    return true;
  }

  if (watch.isWatchPackage(pkg.id)) {
    // Paid for Watch Credit, not for Telegram-download Credit: a separate
    // balance, kept in the watch catalog's own store.
    const text = await watch.grantedText(user.language, pkg.downloads, user);
    await call("sendMessage", { chat_id: order.chat_id, text });
    return true;
  }

  const patch = { updated_at: nowIso() };
  if (pkg.downloads) {
    patch.paid_downloads = (user.paid_downloads ?? 0) + pkg.downloads;
  } else {
    // A renewal before the old period ends stacks on top of it.
    const from = isPremium(user) ? new Date(user.premium_until).getTime() : Date.now();
    patch.premium_until = new Date(from + pkg.days * 24 * 60 * 60 * 1000).toISOString();
  }
  await db().from("bot_users").update(patch).eq("telegram_user_id", user.telegram_user_id);

  // Says what the payment bought in the same terms as the Credit screen:
  // the new balance, or the date VIP now runs to.
  const s = t(user.language);
  let text;
  if (pkg.downloads) {
    const [usage] = rows(
      await db().from("bot_link_downloads").select("free_used").eq("telegram_user_id", user.telegram_user_id).limit(1)
    );
    const total = config.botFreeDownloads + (user.bonus_downloads ?? 0) + patch.paid_downloads;
    text = s.grantedCredit(pkg.downloads, Math.max(total - (usage?.free_used ?? 0), 0));
  } else {
    text = s.grantedVip(formatDate(patch.premium_until));
  }
  await call("sendMessage", { chat_id: order.chat_id, text });
  return true;
}

/**
 * A photo arrived. From the operator after /setqr it's the bank QR to build
 * orders from; from anyone else it's a payment screenshot for their pending
 * order. Returns true when it handled the message.
 */
export async function handlePhoto(message, user) {
  const photo = message.photo?.[message.photo.length - 1];
  if (!photo) return false;
  const chatId = message.chat.id;
  const caption = String(message.caption ?? "").trim();

  const setqr = /^\/setqr(2)?\b/i.exec(caption);
  if (isAdminChat(chatId) && setqr) {
    await saveQrFromPhoto(chatId, photo.file_id, setqr[1] ? "alt" : "primary");
    return true;
  }

  const s = t(user.language);
  const [order] = rows(
    await db()
      .from("bot_orders")
      .select("*, package:bot_packages(title_en, title_km)")
      .eq("telegram_user_id", user.telegram_user_id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
  );
  if (!order) {
    await call("sendMessage", { chat_id: chatId, text: s.noPendingOrder });
    return true;
  }

  await db().from("bot_orders").update({ screenshot_file_id: photo.file_id }).eq("id", order.id);
  await call("sendMessage", { chat_id: chatId, text: s.screenshotReceived });

  if (config.telegramAdminChatId) {
    const who = user.username ? `@${user.username}` : user.first_name || user.telegram_user_id;
    await call("sendPhoto", {
      chat_id: config.telegramAdminChatId,
      photo: photo.file_id,
      caption:
        `{:admin:} Payment screenshot\n` +
        `From: ${who} (${user.telegram_user_id})\n` +
        `Package: ${order.package?.title_en ?? order.package_id} — $${Number(order.amount_usd).toFixed(2)}\n` +
        `Ticket: ${order.ticket}`,
      reply_markup: {
        inline_keyboard: [[
          { text: "{:ok:} Approve", emoji: "ok", callback_data: `bot:pay_ok:${order.id}` },
          { text: "{:fail:} Reject", emoji: "fail", callback_data: `bot:pay_no:${order.id}` },
        ]],
      },
    });
  }
  return true;
}

async function saveQrFromPhoto(chatId, fileId, slot) {
  try {
    const payload = decodeQr(await fetchTelegramFile(fileId));
    if (!payload) {
      await call("sendMessage", { chat_id: chatId, text: "{:fail:} No QR code found in that photo. Send a clear, uncropped screenshot of your KHQR." });
      return;
    }
    await saveTemplate(chatId, payload, slot);
  } catch (err) {
    await call("sendMessage", { chat_id: chatId, text: `{:fail:} Couldn't read that photo: ${String(err?.message ?? err).slice(0, 200)}` });
  }
}

const TEMPLATE_PROBLEMS = {
  unparseable: "that isn't a KHQR payload.",
  "bad-checksum": "the checksum doesn't match -- it looks cut off or altered.",
  "no-amount-field":
    "it's a static QR (no amount). In ABA, create a QR *with an amount* (any amount, e.g. $1) and send that one -- the bot replaces the amount per order.",
};

async function saveTemplate(chatId, payload, slot = "primary") {
  const valid = validateKhqrTemplate(payload);
  if (!valid.ok) {
    await call("sendMessage", { chat_id: chatId, text: `{:fail:} Can't use this QR: ${TEMPLATE_PROBLEMS[valid.reason] ?? valid.reason}` });
    return;
  }
  if (slot === "alt") {
    await savePaymentSettings({ alt_template: valid.payload });
    await call("sendMessage", {
      chat_id: chatId,
      text:
        "{:ok:} Second bank QR saved (ACLEDA). Payers now choose ABA or ACLEDA; the ACLEDA QR carries the service name " +
        "(KH Invoice Pro / SaveIt Pro). /qrstatus shows both, /setqr2 off removes it.",
    });
    return;
  }
  await db().from("bot_settings").update({ khqr_template: valid.payload, updated_at: nowIso() }).eq("id", 1);
  await call("sendMessage", {
    chat_id: chatId,
    text: "{:ok:} Payment QR saved. Every order now gets this QR with its own exact amount. Tap {:diamond:} to try it.",
  });
}

async function qrStatus(chatId) {
  const [settings] = rows(await db().from("bot_settings").select("khqr_template").eq("id", 1).limit(1));
  const extra = await paymentSettings();
  const describe = (payload) => {
    if (!payload) return "— not set";
    const name = parseKhqr(payload)?.find((f) => f.tag === "59")?.value;
    return `✓ set (payee: ${name ?? "?"})`;
  };
  await call("sendMessage", {
    chat_id: chatId,
    text:
      `{:admin:} Payment QRs\n\n` +
      `1️⃣ ${extra.primary_label}: ${describe(settings?.khqr_template)} (name kept as the bank wrote it)\n` +
      `2️⃣ ${extra.alt_label}: ${describe(extra.alt_template)}${extra.alt_template && extra.rename_alt ? " (shows the service name)" : ""}\n\n` +
      `/setqr — photo or text, bank 1\n/setqr2 — photo or text, bank 2\n/setqr2 off — remove bank 2`,
  });
}

/** Operator text commands for payments. Returns true when handled. */
export async function handleAdminPayCommand(chatId, text) {
  if (!isAdminChat(chatId)) return false;
  if (/^\/makeemoji$/i.test(text)) {
    await call("sendMessage", { chat_id: chatId, text: "{:wait:} Building the custom emoji pack…" });
    await call("sendMessage", { chat_id: chatId, text: await buildPack(chatId) });
    return true;
  }
  if (/^\/qrstatus$/i.test(text)) {
    await qrStatus(chatId);
    return true;
  }
  if (/^\/setqr2\s+off$/i.test(text)) {
    await savePaymentSettings({ alt_template: null });
    await call("sendMessage", { chat_id: chatId, text: "{:ok:} Second bank removed — only bank 1 is offered now." });
    return true;
  }
  const setKhqr = /^\/setqr(2)?\s+(\S+)$/i.exec(text);
  if (setKhqr) {
    await saveTemplate(chatId, setKhqr[2], setKhqr[1] ? "alt" : "primary");
    return true;
  }
  if (/^\/setqr2$/i.test(text)) {
    await call("sendMessage", {
      chat_id: chatId,
      text: "Send your ACLEDA KHQR (one created WITH an amount) as a photo with the caption /setqr2, or /setqr2 <KHQR text>.",
    });
    return true;
  }
  const retry = /^\/invactivate\s+(\S+)$/i.exec(text);
  if (retry) {
    const [order] = rows(await db().from("bot_orders").select("*").eq("ticket", retry[1]).limit(1));
    if (!order || order.status !== "paid" || !khInvoice.isInvoicePackage(order.package_id)) {
      await call("sendMessage", { chat_id: chatId, text: "No paid KH Invoice order with that ticket." });
      return true;
    }
    const [user] = rows(await db().from("bot_users").select("*").eq("telegram_user_id", order.telegram_user_id).limit(1));
    try {
      const until = await khInvoice.activatePlan(order, user ?? { telegram_user_id: order.telegram_user_id });
      await call("sendMessage", { chat_id: order.chat_id, text: khInvoice.grantedText(user?.language, until) });
      await call("sendMessage", { chat_id: chatId, text: `{:ok:} Activated until ${String(until).slice(0, 10)}.` });
    } catch (err) {
      await call("sendMessage", { chat_id: chatId, text: `{:fail:} ${String(err?.message ?? err).slice(0, 300)}` });
    }
    return true;
  }
  if (/^\/setqr$/i.test(text)) {
    await call("sendMessage", {
      chat_id: chatId,
      text: "Send your bank's KHQR screenshot as a photo with the caption /setqr (or /setqr <KHQR text>).",
    });
    return true;
  }
  return false;
}

/** Buy / cancel / approve / reject buttons. Returns true when handled. */
export async function handlePayCallback(cq, user) {
  const [, kind, value] = String(cq.data ?? "").split(":");
  const chatId = cq.message?.chat?.id;

  if (kind === "buy") {
    await call("answerCallbackQuery", { callback_query_id: cq.id });
    await startOrder(chatId, user, value);
    return true;
  }

  if (kind === "bank") {
    const [packageId, bank] = String(value ?? "").split("~");
    await call("answerCallbackQuery", { callback_query_id: cq.id });
    await startOrder(chatId, user, packageId, bank === "a" ? "a" : "p");
    return true;
  }

  if (kind === "cancel") {
    await db()
      .from("bot_orders")
      .update({ status: "expired" })
      .eq("id", value)
      .eq("telegram_user_id", cq.from.id)
      .eq("status", "pending");
    await call("answerCallbackQuery", { callback_query_id: cq.id, text: t(user.language).cancelled });
    return true;
  }

  if (kind === "pay_ok" || kind === "pay_no") {
    if (!isAdminChat(chatId)) {
      await call("answerCallbackQuery", { callback_query_id: cq.id, text: "Not authorized." });
      return true;
    }
    const [order] = rows(await db().from("bot_orders").select("*").eq("id", value).limit(1));
    if (!order || order.status !== "pending") {
      await call("answerCallbackQuery", { callback_query_id: cq.id, text: `Already ${order?.status ?? "gone"}.` });
      return true;
    }
    let verdict;
    if (kind === "pay_ok") {
      await grant(order, "operator");
      verdict = "{:ok:} APPROVED";
    } else {
      await db().from("bot_orders").update({ status: "rejected", confirmed_by: "operator" }).eq("id", order.id).eq("status", "pending");
      const [payer] = rows(await db().from("bot_users").select("language").eq("telegram_user_id", order.telegram_user_id).limit(1));
      await call("sendMessage", { chat_id: order.chat_id, text: t(payer?.language).rejected });
      verdict = "{:fail:} REJECTED";
    }
    await call("answerCallbackQuery", { callback_query_id: cq.id, text: verdict });
    await call("editMessageCaption", {
      chat_id: chatId,
      message_id: cq.message.message_id,
      caption: `${cq.message.caption ?? ""}\n\n${verdict}`,
    });
    return true;
  }
  return false;
}

// ----------------------------------------------------------- worker pass

/**
 * Asks Bakong about every open order (when BAKONG_API_TOKEN is set), and
 * lapses the ones past their window. Approval needs Bakong to report the
 * exact QR paid, for the exact amount, in USD, with a transaction hash no
 * other order has used (bank_hash is unique).
 */
export async function checkPendingOrders() {
  if (!config.telegramLoginBotToken) return 0;

  const cutoff = new Date(Date.now() - ORDER_TTL_MS).toISOString();
  await db().from("bot_orders").update({ status: "expired" }).eq("status", "pending").lt("created_at", cutoff);

  const token = process.env.BAKONG_API_TOKEN;
  if (!token) return 0;

  const open = rows(
    await db().from("bot_orders").select("*").eq("status", "pending").order("created_at").limit(25)
  );
  let confirmed = 0;
  for (const order of open) {
    try {
      const res = await fetch(`${BAKONG_BASE}/v1/check_transaction_by_md5`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ md5: order.khqr_md5 }),
      });
      const envelope = await res.json().catch(() => ({}));
      const tx = envelope?.responseCode === 0 ? envelope.data : null;
      if (!tx) continue;
      if (Math.abs(Number(tx.amount) - Number(order.amount_usd)) > 0.001) continue;
      if (tx.currency && String(tx.currency).toUpperCase() !== "USD") continue;
      if (await grant(order, "bakong", tx.hash ?? null)) confirmed += 1;
    } catch (err) {
      // A unique-violation on bank_hash lands here too: that payment already
      // confirmed a different order, so this one must not be granted.
      console.error(`Bakong check for order ${order.ticket} failed:`, err?.message ?? err);
    }
  }
  return confirmed;
}
