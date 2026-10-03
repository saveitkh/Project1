/**
 * /redub: put your own voice into a video in place of the original speech,
 * keeping the original background music -- no AI voice, no GPU, no API key.
 * Flow: "/redub" asks for a video; once it's in, asks for a voice recording
 * (a Telegram voice note or an audio file); once that's in, the two are
 * combined and sent back.
 *
 * The original speech is pulled out with ffmpeg's classic center-channel
 * cancellation trick (what a "karaoke" / vocal remover does): on a stereo
 * track, content panned dead-center -- usually the voice -- cancels out when
 * one channel is subtracted from the other, leaving mostly the music/effects
 * behind. It's free and instant, but it's an approximation: a mono source
 * can't be split this way at all (subtracting a channel from itself erases
 * everything), and a music-heavy or off-center original mix leaves more of
 * the original voice behind than a real AI source-separation model (like
 * Demucs) would. Good enough for "replace my voice over this clip"; not a
 * clean isolate.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "./config.js";
import { call } from "./notifyBot.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const MAX_TELEGRAM_FILE = 20 * 1024 * 1024; // what getFile lets a bot download
const MAX_SECONDS = 6 * 60 + 30;
const WAIT_MS = 10 * 60_000;

const TEXT = {
  km: {
    askVideo:
      "{:video:} ប្ដូរសំឡេងជារបស់អ្នក (/redub)\n\n" +
      "ជំហានទី ១៖ ផ្ញើវីដេអូមកមុន\n\n" +
      "{:bulb:} ខ្ញុំព្យាយាមលុបតែសំឡេងនិយាយដើម ទុកភ្លេងកំដរ (មិនមែន AI ពិតប្រាកដទេ — បច្ចេកទេសសាមញ្ញ ដូច្នេះលទ្ធផលប្រែប្រួលទៅតាមវីដេអូនីមួយៗ)\n" +
      "{:bulb:} កំណត់៖ តិចជាង 20MB និង មិនលើសពី 6 នាទី",
    askVoice: "{:ok:} ទទួលវីដេអូរួចហើយ! ជំហានទី ២៖ ឥឡូវផ្ញើសំឡេងអ្នក (Voice message ឬឯកសារសំឡេង)។",
    working: "{:wait:} កំពុងលុបសំឡេងដើម និងលាយសំឡេងអ្នកចូល…",
    busy: "{:wait:} កំពុងធ្វើមួយរួចហើយ សូមរង់ចាំបន្តិច។",
    tooBig: "{:fail:} ឯកសារធំពេក (លើស 20MB)។",
    tooLong: "{:fail:} វីដេអូវែងពេក (លើស 6 នាទី)។",
    monoWarn: "\n{:bulb:} វីដេអូនេះជាសំឡេង mono -- លុបសំឡេងដើមមិនបានស្អាតទេ អាចនៅឮបន្តិច។",
    failed: (why) => `{:fail:} ប្ដូរសំឡេងមិនបានទេ៖ ${why}`,
  },
  en: {
    askVideo:
      "{:video:} Put your own voice into a video (/redub)\n\n" +
      "Step 1: send the video first\n\n" +
      "{:bulb:} I try to remove just the original speech and keep the music (not real AI -- a simple trick, so results vary clip to clip)\n" +
      "{:bulb:} Limits: under 20MB and at most 6 minutes",
    askVoice: "{:ok:} Got the video! Step 2: now send your voice (a voice message or an audio file).",
    working: "{:wait:} Removing the original speech and mixing yours in…",
    busy: "{:wait:} Still working on the last one -- a moment please.",
    tooBig: "{:fail:} That file is too big (over 20 MB).",
    tooLong: "{:fail:} That video is too long (over 6 minutes).",
    monoWarn: "\n{:bulb:} This video's audio is mono -- the original speech couldn't be cleanly removed, so it may still be faintly audible.",
    failed: (why) => `{:fail:} Could not redub that video: ${why}`,
  },
};
const tx = (language) => TEXT[language] ?? TEXT.km;

const waiting = new Map(); // chatId -> { stage: "video"|"voice", dir?, videoPath?, expiry }
const working = new Set();

export async function ask(chatId, user) {
  await cleanupEntry(waiting.get(chatId));
  waiting.set(chatId, { stage: "video", expiry: Date.now() + WAIT_MS });
  await call("sendMessage", { chat_id: chatId, text: tx(user.language).askVideo });
}

export function cancel(chatId) {
  const entry = waiting.get(chatId);
  waiting.delete(chatId);
  cleanupEntry(entry);
}

async function cleanupEntry(entry) {
  if (entry?.dir) await fs.rm(entry.dir, { recursive: true, force: true }).catch(() => {});
}

function videoOf(message) {
  if (message.video) return message.video;
  const doc = message.document;
  if (doc && /^video\//.test(doc.mime_type ?? "")) return doc;
  return null;
}

function voiceOf(message) {
  if (message.voice) return message.voice;
  if (message.audio) return message.audio;
  const doc = message.document;
  if (doc && /^audio\//.test(doc.mime_type ?? "")) return doc;
  return null;
}

/** Handles the message when it's for /redub. Returns true when handled. */
export async function handleMessage(message, user) {
  const chatId = message.chat.id;
  const caption = String(message.caption ?? "").trim();
  const captioned = /^\/redub\b/i.test(caption);

  let entry = waiting.get(chatId);
  if (entry && entry.expiry <= Date.now()) {
    await cleanupEntry(entry);
    waiting.delete(chatId);
    entry = null;
  }
  if (!entry && captioned) entry = { stage: "video", expiry: Date.now() + WAIT_MS };
  if (!entry) return false;

  const t = tx(user.language);

  if (entry.stage === "video") {
    const video = videoOf(message);
    if (!video) return false;
    if (video.file_size > MAX_TELEGRAM_FILE) {
      await call("sendMessage", { chat_id: chatId, text: t.tooBig });
      return true;
    }
    if (video.duration > MAX_SECONDS) {
      await call("sendMessage", { chat_id: chatId, text: t.tooLong });
      return true;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "redub-"));
    const videoPath = path.join(dir, "source.mp4");
    try {
      await fs.writeFile(videoPath, await telegramFile(video.file_id));
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await call("sendMessage", { chat_id: chatId, text: t.failed(String(err?.message ?? err)) });
      waiting.delete(chatId);
      return true;
    }
    waiting.set(chatId, { stage: "voice", dir, videoPath, expiry: Date.now() + WAIT_MS });
    await call("sendMessage", { chat_id: chatId, text: t.askVoice });
    return true;
  }

  // stage === "voice"
  const voice = voiceOf(message);
  if (!voice) return false;
  if (working.has(chatId)) {
    await call("sendMessage", { chat_id: chatId, text: t.busy });
    return true;
  }
  if (voice.file_size > MAX_TELEGRAM_FILE) {
    await call("sendMessage", { chat_id: chatId, text: t.tooBig });
    return true;
  }

  working.add(chatId);
  waiting.delete(chatId);
  const { dir, videoPath } = entry;
  const status = await call("sendMessage", { chat_id: chatId, text: t.working });
  try {
    const voicePath = path.join(dir, "voice.src");
    await fs.writeFile(voicePath, await telegramFile(voice.file_id));

    const original = path.join(dir, "original.wav");
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", videoPath, "-vn", "-ar", "44100", "-ac", "2", original], { timeout: 60_000 });

    const channels = Number((await run(FFPROBE, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", videoPath])).stdout.trim()) || 2;

    const bgm = path.join(dir, "bgm.wav");
    if (channels >= 2) {
      await run(FFMPEG, ["-y", "-loglevel", "error", "-i", original, "-af", "pan=mono|c0=0.5*c0-0.5*c1,pan=stereo|c0=c0|c1=c0", bgm], { timeout: 60_000 });
    } else {
      await run(FFMPEG, ["-y", "-loglevel", "error", "-i", original, "-ac", "2", bgm], { timeout: 60_000 });
    }

    const duration = (await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath])).stdout.trim();

    const voiceWav = path.join(dir, "voice.wav");
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", voicePath, "-ar", "44100", "-ac", "2", "-af", "loudnorm,apad", "-t", duration, voiceWav], { timeout: 60_000 });

    const mixed = path.join(dir, "mixed.wav");
    await run(
      FFMPEG,
      [
        "-y", "-loglevel", "error",
        "-i", bgm, "-i", voiceWav,
        "-filter_complex", "[0:a]volume=0.5[bg];[1:a]volume=1.4[vo];[bg][vo]amix=inputs=2:duration=first:dropout_transition=0",
        "-ac", "2", mixed,
      ],
      { timeout: 60_000 }
    );

    const out = path.join(dir, "redub.mp4");
    await run(
      FFMPEG,
      ["-y", "-loglevel", "error", "-i", videoPath, "-i", mixed, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", out],
      { timeout: 120_000 }
    );

    await sendVideoFile(chatId, out, channels < 2 ? t.monoWarn : "");
  } catch (err) {
    console.error("Voice redub failed:", err?.message ?? err);
    const why = String(err?.stderr ?? err?.message ?? err).trim().split("\n").pop()?.slice(0, 180) ?? "unknown error";
    await call("sendMessage", { chat_id: chatId, text: t.failed(why) });
  } finally {
    working.delete(chatId);
    if (status?.result?.message_id) await call("deleteMessage", { chat_id: chatId, message_id: status.result.message_id });
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
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

async function sendVideoFile(chatId, filePath, caption) {
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  if (caption) form.set("caption", caption);
  form.set("video", new Blob([buffer], { type: "video/mp4" }), "redub.mp4");
  const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/sendVideo`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data?.description || "Telegram refused the video");
  return data;
}
