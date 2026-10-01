/**
 * Emoji Maker: anyone can turn a GIF, a video, a sticker, a photo -- or a
 * TikTok / Facebook / YouTube / Instagram link -- into a custom emoji in
 * their own pack (t.me/addemoji/...), made by the bot and owned by them.
 *
 * Moving sources become WEBM (VP9, 100x100, at most 3 s, under 256 KB --
 * Telegram's format for video emoji); photos become a 100x100 PNG. The
 * picture is cropped to the middle square.
 *
 * Flow: the "✨ Emoji Maker" button (or /emoji) asks for the source; the next
 * GIF/video/photo/link is made into an emoji. A GIF or video sent with the
 * caption /emoji works straight away. A number after the link or in the
 * caption is where to start, in seconds ("… 12" or "/emoji 1:05").
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "./config.js";
import { call } from "./notifyBot.js";
import { downloadWithYtdlp } from "./ytdlp.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const MAX_WEBM = 256 * 1024;
const MAX_TELEGRAM_FILE = 20 * 1024 * 1024; // what getFile lets a bot download
const WAIT_MS = 10 * 60_000;
const URL_RE = /https?:\/\/\S+/i;

const TEXT = {
  km: {
    ask:
      "{:sparkle:} Emoji Maker — បង្កើត Emoji ផ្ទាល់ខ្លួន\n\n" +
      "ផ្ញើមកខ្ញុំមួយក្នុងចំណោមទាំងនេះ៖\n" +
      "{:video:} វីដេអូ ឬ GIF (កាត់យក 3 វិនាទី)\n" +
      "{:tt:} {:fb:} {:yt:} {:ig:} តំណ TikTok / Facebook / YouTube / Instagram\n" +
      "🖼 រូបភាព ឬ Sticker\n\n" +
      "⏱ ចង់ចាប់ផ្តើមពីវិនាទីណា? ដាក់លេខក្រោយតំណ ឧ. https://… 12\n" +
      "{:diamond:} Emoji ចូលក្នុងកញ្ចប់ផ្ទាល់ខ្លួនរបស់អ្នក",
    working: "{:wait:} កំពុងបង្កើត Emoji…",
    done: (emoji, link, count) =>
      `{:ok:} រួចរាល់! Emoji ថ្មីរបស់អ្នក៖ ${emoji}\n\n` +
      `{:diamond:} កញ្ចប់របស់អ្នក (${count} emoji)៖\n${link}\n\n` +
      `ចុចតំណដើម្បីបន្ថែមកញ្ចប់ ហើយប្រើក្នុងសារបាន (ត្រូវការ Telegram Premium)។ ផ្ញើមកទៀតដើម្បីបន្ថែម។`,
    busy: "{:wait:} កំពុងធ្វើមួយរួចហើយ សូមរង់ចាំបន្តិច។",
    tooBig: "{:fail:} ឯកសារធំពេក (លើស 20MB)។ សូមផ្ញើតំណ ឬវីដេអូខ្លីជាងនេះ។",
    failed: (why) => `{:fail:} បង្កើត Emoji មិនបាន៖ ${why}`,
    full: "{:fail:} កញ្ចប់របស់អ្នកពេញហើយ (200 emoji)។",
  },
  en: {
    ask:
      "{:sparkle:} Emoji Maker — make your own custom emoji\n\n" +
      "Send me one of these:\n" +
      "{:video:} a video or GIF (3 seconds are used)\n" +
      "{:tt:} {:fb:} {:yt:} {:ig:} a TikTok / Facebook / YouTube / Instagram link\n" +
      "🖼 a photo or a sticker\n\n" +
      "⏱ Start later in the clip? Put the second after the link, e.g. https://… 12\n" +
      "{:diamond:} The emoji goes into your own pack",
    working: "{:wait:} Making your emoji…",
    done: (emoji, link, count) =>
      `{:ok:} Done! Your new emoji: ${emoji}\n\n` +
      `{:diamond:} Your pack (${count} emoji):\n${link}\n\n` +
      `Open the link to add the pack and use it in messages (needs Telegram Premium). Send more to add them.`,
    busy: "{:wait:} Still making the last one -- a moment please.",
    tooBig: "{:fail:} That file is too big (over 20 MB). Send a link or a shorter clip.",
    failed: (why) => `{:fail:} Could not make the emoji: ${why}`,
    full: "{:fail:} Your pack is full (200 emoji).",
  },
};
const tx = (language) => TEXT[language] ?? TEXT.km;

const waiting = new Map(); // chatId -> expiry
const working = new Set(); // chatIds with a job running

let botName = null;
async function botUsername() {
  if (!botName) botName = (await call("getMe", {}))?.result?.username ?? null;
  return botName;
}

/** The menu button / command: waits for the next GIF, video, photo or link. */
export async function ask(chatId, user) {
  waiting.set(chatId, Date.now() + WAIT_MS);
  await call("sendMessage", { chat_id: chatId, text: tx(user.language).ask });
}

export function cancel(chatId) {
  waiting.delete(chatId);
}

const isWaiting = (chatId) => (waiting.get(chatId) ?? 0) > Date.now();

/** "12", "1:05", "0:01:05" -> seconds. */
function startAt(text) {
  const m = /(?:^|\s)(\d{1,2}(?::\d{1,2}){0,2})(?:s)?\s*$/.exec(String(text ?? "").replace(URL_RE, " ").replace(/^\/emoji\b/i, " "));
  if (!m) return 0;
  return m[1].split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
}

/** The Telegram file in a message that can become an emoji, if there is one. */
function mediaOf(message) {
  if (message.animation) return { ...message.animation, moving: true };
  if (message.video) return { ...message.video, moving: true };
  if (message.video_note) return { ...message.video_note, moving: true };
  if (message.sticker) return { ...message.sticker, moving: !!(message.sticker.is_video || message.sticker.is_animated), tgs: message.sticker.is_animated };
  if (message.photo?.length) return { ...message.photo[message.photo.length - 1], moving: false };
  const doc = message.document;
  if (doc && /^(image|video)\//.test(doc.mime_type ?? "")) return { ...doc, moving: !/^image\/(png|jpe?g|webp)$/.test(doc.mime_type) };
  return null;
}

/**
 * Handles the message when it is for the Emoji Maker: a medium or link while
 * it waits for one, or a medium captioned /emoji. Returns true when handled.
 */
export async function handleMessage(message, user) {
  const chatId = message.chat.id;
  const caption = String(message.caption ?? "").trim();
  const text = String(message.text ?? "").trim();
  const media = mediaOf(message);
  const captioned = /^\/emoji\b/i.test(caption);
  const url = URL_RE.exec(text)?.[0];

  if (!(captioned && media) && !(isWaiting(chatId) && (media || url))) return false;
  const t = tx(user.language);
  if (media?.tgs) {
    await call("sendMessage", { chat_id: chatId, text: t.failed("animated (.tgs) stickers can't be converted -- send a video sticker, GIF or clip") });
    return true;
  }
  if (working.has(chatId)) {
    await call("sendMessage", { chat_id: chatId, text: t.busy });
    return true;
  }
  if (media?.file_size > MAX_TELEGRAM_FILE) {
    await call("sendMessage", { chat_id: chatId, text: t.tooBig });
    return true;
  }

  working.add(chatId);
  waiting.set(chatId, Date.now() + WAIT_MS); // keep going: the next one is added too
  const status = await call("sendMessage", { chat_id: chatId, text: t.working });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "emoji-"));
  let downloaded = null;
  try {
    let source;
    let moving = true;
    if (media) {
      source = path.join(dir, "source");
      await fs.writeFile(source, await telegramFile(media.file_id));
      moving = media.moving;
    } else {
      downloaded = (await downloadWithYtdlp(url, null, "emoji.mp4", null, "small")).path;
      source = downloaded;
    }
    const sticker = moving ? await toWebm(source, dir, startAt(caption || text)) : await toPng(source, dir);
    const result = await addToPack(user, sticker, moving);
    // {:<id>:} is the new emoji itself (see customEmoji.js).
    await call("sendMessage", {
      chat_id: chatId,
      text: t.done(result.id ? `{:${result.id}:}` : "✨", result.link, result.count),
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    console.error("Emoji Maker failed:", err?.message ?? err);
    const why = String(err?.message ?? err);
    await call("sendMessage", { chat_id: chatId, text: /full/i.test(why) ? t.full : t.failed(why.slice(0, 180)) });
  } finally {
    working.delete(chatId);
    if (status?.result?.message_id) await call("deleteMessage", { chat_id: chatId, message_id: status.result.message_id });
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (downloaded) await fs.rm(downloaded, { force: true }).catch(() => {});
  }
  return true;
}

async function telegramFile(fileId) {
  const info = await call("getFile", { file_id: fileId });
  const filePath = info?.result?.file_path;
  if (!filePath) throw new Error("Telegram did not return the file");
  const res = await fetch(`https://api.telegram.org/file/bot${config.telegramLoginBotToken}/${filePath}`);
  if (!res.ok) throw new Error(`downloading the file failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

const SQUARE = "scale=100:100:force_original_aspect_ratio=increase:flags=lanczos,crop=100:100";

/** A 100x100 VP9 clip of under 3 s, shrunk until it is under Telegram's cap. */
async function toWebm(source, dir, start) {
  const out = path.join(dir, "emoji.webm");
  const head = Buffer.alloc(4);
  const fh = await fs.open(source);
  await fh.read(head, 0, 4, 0).finally(() => fh.close());
  const webm = head.toString("hex") === "1a45dfa3";
  for (const [crf, fps] of [[32, 30], [40, 30], [48, 24], [56, 20]]) {
    const args = ["-y", "-loglevel", "error"];
    if (start > 0) args.push("-ss", String(start));
    // A video sticker is VP9 with alpha: only libvpx's decoder keeps it clear.
    if (webm) args.push("-c:v", "libvpx-vp9");
    args.push(
      "-t", "2.9", "-i", source, "-t", "2.9",
      "-vf", `fps=${fps},${SQUARE}`,
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", String(crf),
      "-an", "-map_metadata", "-1", out,
    );
    try {
      await run(FFMPEG, args, { timeout: 120_000 });
    } catch (err) {
      throw new Error(`could not read that video (${String(err?.stderr ?? err?.message ?? "").trim().split("\n").pop()?.slice(0, 120) || "ffmpeg failed"})`);
    }
    const size = (await fs.stat(out).catch(() => ({ size: 0 }))).size;
    if (!size) throw new Error(start > 0 ? "the clip is shorter than that start time" : "the video has no frames");
    if (size <= MAX_WEBM) return out;
  }
  throw new Error("the clip stays over 256 KB -- try a calmer part of it");
}

async function toPng(source, dir) {
  const out = path.join(dir, "emoji.png");
  try {
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", source, "-vf", SQUARE, "-frames:v", "1", out], { timeout: 60_000 });
  } catch {
    throw new Error("could not read that picture");
  }
  return out;
}

/** Adds the sticker to the user's pack, making the pack on the first one. */
async function addToPack(user, file, moving) {
  const username = await botUsername();
  if (!username) throw new Error("the bot is not ready");
  const name = `u${user.telegram_user_id}_by_${username}`;
  const sticker = { sticker: "attach://file", format: moving ? "video" : "static", emoji_list: ["✨"] };
  const form = new FormData();
  form.set("user_id", String(user.telegram_user_id));
  form.set("name", name);
  const bytes = await fs.readFile(file);
  form.set("file", new Blob([bytes], { type: moving ? "video/webm" : "image/png" }), path.basename(file));

  const existing = await call("getStickerSet", { name });
  let data;
  if (existing?.ok) {
    if ((existing.result.stickers?.length ?? 0) >= 200) throw new Error("pack full");
    form.set("sticker", JSON.stringify(sticker));
    data = await botForm("addStickerToSet", form);
  } else {
    const who = (user.first_name || user.username || "My").slice(0, 30);
    form.set("title", `${who} · SaveIt KH Emoji`);
    form.set("sticker_type", "custom_emoji");
    form.set("stickers", JSON.stringify([sticker]));
    data = await botForm("createNewStickerSet", form);
  }
  if (!data?.ok) {
    const why = String(data?.description ?? "Telegram refused it");
    throw new Error(/PEER_ID_INVALID|user not found/i.test(why) ? "press /start first, then try again" : why.replace(/^Bad Request:\s*/, ""));
  }
  const set = await call("getStickerSet", { name });
  const list = set?.result?.stickers ?? [];
  return { id: list[list.length - 1]?.custom_emoji_id, count: list.length, link: `https://t.me/addemoji/${name}` };
}

async function botForm(method, form) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/${method}`, { method: "POST", body: form });
  return res.json().catch(() => ({}));
}
