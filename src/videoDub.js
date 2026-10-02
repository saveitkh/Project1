/**
 * /dub: a short video in, the same video back with its speech translated and
 * read aloud in Khmer -- a free Microsoft Edge neural voice, not a clone of
 * the original speaker. Flow: "🎬 ប្រែវីដេអូជាខ្មែរ" (or /dub) asks for a
 * clip; the next video (or one captioned /dub) is downloaded, its audio is
 * sent to Gemini to transcribe + translate to natural spoken Khmer, that text
 * is synthesized, and muxed back over the original picture.
 *
 * Capped at Telegram's own 20MB bot-download ceiling and ~6 minutes, and at
 * DUB_FREE_DAILY runs per person per day since it shares Gemini's one free
 * quota with the rest of the bot (see ai.js's 🆓 Gemini Free).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

import { geminiFreeModel } from "./ai.js";
import { config } from "./config.js";
import { call } from "./notifyBot.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const MAX_TELEGRAM_FILE = 20 * 1024 * 1024; // what getFile lets a bot download
const MAX_SECONDS = 6 * 60 + 30;
const WAIT_MS = 10 * 60_000;

const TEXT = {
  km: {
    ask:
      "{:video:} ប្រែវីដេអូជាខ្មែរ (AI voice)\n\n" +
      "ផ្ញើវីដេអូមក ខ្ញុំនឹង៖\n" +
      "1️⃣ ស្ដាប់សំឡេងដើម ហើយបកប្រែជាខ្មែរ (Gemini)\n" +
      "2️⃣ អានសំឡេងខ្មែរនោះឡើងវិញ ដោយ AI voice ឥតគិតថ្លៃ\n" +
      "3️⃣ ផ្ញើវីដេអូដែលមានសំឡេងខ្មែរថ្មីមកវិញ\n\n" +
      "{:bulb:} សំឡេងជា AI narrator ខ្មែរទូទៅ (មិនមែនចម្លងសំឡេងតួដើមទេ)\n" +
      "{:bulb:} កំណត់៖ តិចជាង 20MB និង មិនលើសពី 6 នាទី\n" +
      `{:bulb:} ប្រើបាន ${config.dubFreeDaily} ដង/ថ្ងៃ`,
    working: "{:wait:} កំពុងស្ដាប់ និងបកប្រែ… (អាចចំណាយពេល 1-3 នាទី)",
    busy: "{:wait:} កំពុងធ្វើមួយរួចហើយ សូមរង់ចាំបន្តិច។",
    tooBig: "{:fail:} ឯកសារធំពេក (លើស 20MB)។ សូមផ្ញើវីដេអូខ្លី ឬតូចជាងនេះ។",
    tooLong: "{:fail:} វីដេអូវែងពេក (លើស 6 នាទី)។ សូមកាត់ឲ្យខ្លីជាងនេះ។",
    noAudio: "{:fail:} ត្រូវការ Gemini API key ដើម្បីប្រើមុខងារនេះ — សូមទាក់ទងអ្នកគ្រប់គ្រង bot។",
    dailyLimit: (n) => `{:fail:} អ្នកប្រើអស់ ${n} ដងឥតគិតថ្លៃសម្រាប់ថ្ងៃនេះហើយ។ សូមសាកម្ដងទៀតថ្ងៃស្អែក។`,
    failed: (why) => `{:fail:} ប្រែវីដេអូមិនបានទេ៖ ${why}`,
  },
  en: {
    ask:
      "{:video:} Dub a video into Khmer (AI voice)\n\n" +
      "Send me a video and I will:\n" +
      "1️⃣ Listen to the original audio and translate it to Khmer (Gemini)\n" +
      "2️⃣ Read that Khmer text aloud with a free AI voice\n" +
      "3️⃣ Send the video back with the new Khmer audio\n\n" +
      "{:bulb:} The voice is a generic Khmer AI narrator (not a clone of the original speaker)\n" +
      "{:bulb:} Limits: under 20MB and at most 6 minutes\n" +
      `{:bulb:} ${config.dubFreeDaily} runs a day`,
    working: "{:wait:} Listening and translating… (can take 1-3 minutes)",
    busy: "{:wait:} Still working on the last one -- a moment please.",
    tooBig: "{:fail:} That file is too big (over 20 MB). Send a shorter or smaller video.",
    tooLong: "{:fail:} That video is too long (over 6 minutes). Please trim it first.",
    noAudio: "{:fail:} This needs a Gemini API key -- ask the bot operator to set one up.",
    dailyLimit: (n) => `{:fail:} You've used your ${n} free runs for today. Try again tomorrow.`,
    failed: (why) => `{:fail:} Could not dub that video: ${why}`,
  },
};
const tx = (language) => TEXT[language] ?? TEXT.km;

const waiting = new Map(); // chatId -> expiry
const working = new Set(); // chatIds with a job running
const dailyUses = new Map(); // telegram_user_id -> { day, count }

function takeDaily(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const entry = dailyUses.get(userId);
  if (!entry || entry.day !== day) {
    dailyUses.set(userId, { day, count: 1 });
    return true;
  }
  if (entry.count >= config.dubFreeDaily) return false;
  entry.count += 1;
  return true;
}

export async function ask(chatId, user) {
  waiting.set(chatId, Date.now() + WAIT_MS);
  await call("sendMessage", { chat_id: chatId, text: tx(user.language).ask });
}

export function cancel(chatId) {
  waiting.delete(chatId);
}

const isWaiting = (chatId) => (waiting.get(chatId) ?? 0) > Date.now();

/** The Telegram video in a message, if there is one -- a real video, or a file sent as a document. */
function videoOf(message) {
  if (message.video) return message.video;
  const doc = message.document;
  if (doc && /^video\//.test(doc.mime_type ?? "")) return doc;
  return null;
}

/**
 * Handles the message when it's for /dub: a video while it waits for one, or
 * a video captioned /dub. Returns true when handled.
 */
export async function handleMessage(message, user) {
  const chatId = message.chat.id;
  const caption = String(message.caption ?? "").trim();
  const video = videoOf(message);
  const captioned = /^\/dub\b/i.test(caption);

  if (!video || !(captioned || isWaiting(chatId))) return false;
  const t = tx(user.language);
  if (!config.geminiApiKey) {
    await call("sendMessage", { chat_id: chatId, text: t.noAudio });
    return true;
  }
  if (working.has(chatId)) {
    await call("sendMessage", { chat_id: chatId, text: t.busy });
    return true;
  }
  if (video.file_size > MAX_TELEGRAM_FILE) {
    await call("sendMessage", { chat_id: chatId, text: t.tooBig });
    return true;
  }
  if (video.duration > MAX_SECONDS) {
    await call("sendMessage", { chat_id: chatId, text: t.tooLong });
    return true;
  }
  if (!takeDaily(user.telegram_user_id)) {
    await call("sendMessage", { chat_id: chatId, text: t.dailyLimit(config.dubFreeDaily) });
    return true;
  }

  working.add(chatId);
  waiting.delete(chatId);
  const status = await call("sendMessage", { chat_id: chatId, text: t.working });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dub-"));
  try {
    const source = path.join(dir, "source.mp4");
    await fs.writeFile(source, await telegramFile(video.file_id));

    const audio = path.join(dir, "audio.mp3");
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audio], { timeout: 120_000 });

    const khmerText = await translateAudio(audio);
    if (!khmerText) throw new Error("Gemini returned nothing to say");

    const voiceFile = await synthesize(khmerText, dir);

    const out = path.join(dir, "dubbed.mp4");
    await run(
      FFMPEG,
      ["-y", "-loglevel", "error", "-i", source, "-i", voiceFile, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", out],
      { timeout: 120_000 }
    );

    await sendVideoFile(chatId, out);
  } catch (err) {
    console.error("Video dub failed:", err?.message ?? err);
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
  if (!res.ok) throw new Error(`downloading the video failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Gemini listens to the clip and writes back a natural, spoken Khmer script. */
async function translateAudio(audioPath) {
  const model = await geminiFreeModel();
  const base64 = (await fs.readFile(audioPath)).toString("base64");
  const prompt =
    "Listen to this audio clip. If people are speaking, translate everything said into natural, " +
    "spoken Khmer (Cambodian), as one flowing narration suitable for a voiceover -- no speaker labels, " +
    "no timestamps, no notes, just the Khmer text to read aloud. If there is no speech, instead write a " +
    "short Khmer narration describing what is happening in the audio. Reply with the Khmer text only.";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "audio/mp3", data: base64 } }] }],
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Gemini returned ${res.status}`);
  return String(data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "").trim();
}

/** Free Microsoft Edge neural voice -- no API key needed. */
async function synthesize(text, dir) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(config.dubVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(dir, text);
  return audioFilePath;
}

async function sendVideoFile(chatId, filePath) {
  const buffer = await fs.readFile(filePath);
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("video", new Blob([buffer], { type: "video/mp4" }), "dubbed.mp4");
  const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/sendVideo`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data?.description || "Telegram refused the video");
  return data;
}
