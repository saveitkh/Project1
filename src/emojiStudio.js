/**
 * Emoji studio for the Dubber bot. Self-contained (own bot API client, no database):
 *
 *  - mediaToEmoji: a photo / GIF / video / sticker becomes a custom emoji in the sender's
 *    own pack AND downloadable files (PNG 512, WebP 512, and for moving sources WebM 100 + GIF).
 *  - codingPack:   26 "Coding & Terminal" icons in one of four themes: a custom emoji pack
 *    plus a ZIP (PNG 512 / PNG 100 / README) to use in other projects.
 *  - badge:        any short text as a terminal-style badge (PNG 512 + 100, + pack-ready).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const MAX_WEBM = 256 * 1024;
const MAX_TELEGRAM_FILE = 20 * 1024 * 1024; // what getFile lets a bot download
const PACK_LIMIT = 200;

const FONT_DIR = new URL("../assets/fonts/", import.meta.url).pathname;
try {
  GlobalFonts.registerFromPath(`${FONT_DIR}Inter_800ExtraBold.ttf`, "Inter");
} catch {
  /* falls back to the system sans-serif */
}
const FONT = '"Inter", "DejaVu Sans Mono", sans-serif';

/* ───────────────────────────── themes + icons ───────────────────────────── */

export const THEMES = {
  terminal: { label: "🟩 Terminal Green", bg: "#0b1410", fg: "#39ff88", accent: "#b6ffd2", dim: "#1c5a3a", bad: "#ff5f6d" },
  neon: { label: "🟦 Neon Blue", bg: "#0a1020", fg: "#38bdf8", accent: "#a78bfa", dim: "#1e3a5f", bad: "#fb7185" },
  dracula: { label: "🟪 Dracula", bg: "#282a36", fg: "#bd93f9", accent: "#50fa7b", dim: "#44475a", bad: "#ff5555" },
  light: { label: "⬜ Light", bg: "#ffffff", fg: "#0f172a", accent: "#2563eb", dim: "#cbd5e1", bad: "#dc2626" },
};

const roundRect = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

/** Draws `text` as large as fits `maxW`, centred on (cx, cy). */
const fitText = (ctx, text, cx, cy, maxW, startPx) => {
  let px = startPx;
  ctx.font = `800 ${px}px ${FONT}`;
  while (ctx.measureText(text).width > maxW && px > 10) {
    px -= 2;
    ctx.font = `800 ${px}px ${FONT}`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
};

const text = (t, size = 0.36, color = "fg") => (ctx, S, th) => {
  ctx.fillStyle = th[color];
  fitText(ctx, t, S / 2, S / 2 + S * 0.02, S * 0.72, S * size * 1.6);
};

const stroke = (ctx, S, th, color, w) => {
  ctx.strokeStyle = th[color];
  ctx.lineWidth = S * w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
};

export const ICONS = [
  { id: "prompt", draw: text(">_") },
  { id: "braces", draw: text("{ }") },
  { id: "tags", draw: text("</>") },
  { id: "shell", draw: text("$", 0.5, "accent") },
  { id: "comment", draw: text("//", 0.45, "dim") },
  { id: "arrow", draw: text("=>", 0.42, "accent") },
  { id: "shebang", draw: text("#!", 0.45) },
  { id: "brackets", draw: text("[ ]", 0.42) },
  { id: "npm", draw: text("npm", 0.3) },
  { id: "sudo", draw: text("sudo", 0.27, "bad") },
  { id: "api", draw: text("API", 0.3, "accent") },
  { id: "sql", draw: text("SQL", 0.3) },
  { id: "gpu", draw: text("GPU", 0.3, "accent") },
  { id: "pr", draw: text("PR", 0.36) },
  { id: "lgtm", draw: text("LGTM", 0.24, "accent") },
  { id: "v1", draw: text("v1.0", 0.27) },
  { id: "e404", draw: text("404", 0.32, "bad") },
  {
    id: "ok",
    draw: (ctx, S, th) => {
      stroke(ctx, S, th, "fg", 0.1);
      ctx.beginPath();
      ctx.moveTo(S * 0.26, S * 0.53);
      ctx.lineTo(S * 0.44, S * 0.7);
      ctx.lineTo(S * 0.76, S * 0.32);
      ctx.stroke();
    },
  },
  {
    id: "error",
    draw: (ctx, S, th) => {
      stroke(ctx, S, th, "bad", 0.1);
      ctx.beginPath();
      ctx.moveTo(S * 0.3, S * 0.3);
      ctx.lineTo(S * 0.7, S * 0.7);
      ctx.moveTo(S * 0.7, S * 0.3);
      ctx.lineTo(S * 0.3, S * 0.7);
      ctx.stroke();
    },
  },
  {
    id: "warn",
    draw: (ctx, S, th) => {
      stroke(ctx, S, th, "accent", 0.07);
      ctx.beginPath();
      ctx.moveTo(S * 0.5, S * 0.22);
      ctx.lineTo(S * 0.78, S * 0.74);
      ctx.lineTo(S * 0.22, S * 0.74);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = th.accent;
      fitText(ctx, "!", S * 0.5, S * 0.58, S * 0.3, S * 0.3);
    },
  },
  {
    id: "bug",
    draw: (ctx, S, th) => {
      stroke(ctx, S, th, "bad", 0.055);
      ctx.fillStyle = th.bad;
      ctx.beginPath();
      ctx.ellipse(S * 0.5, S * 0.55, S * 0.17, S * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(S * 0.5, S * 0.3, S * 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      for (const y of [0.45, 0.57, 0.69]) {
        ctx.moveTo(S * 0.33, S * y);
        ctx.lineTo(S * 0.2, S * (y - 0.06));
        ctx.moveTo(S * 0.67, S * y);
        ctx.lineTo(S * 0.8, S * (y - 0.06));
      }
      ctx.stroke();
    },
  },
  {
    id: "branch",
    draw: (ctx, S, th) => {
      stroke(ctx, S, th, "fg", 0.05);
      ctx.beginPath();
      ctx.moveTo(S * 0.34, S * 0.24);
      ctx.lineTo(S * 0.34, S * 0.76);
      ctx.moveTo(S * 0.34, S * 0.56);
      ctx.bezierCurveTo(S * 0.34, S * 0.4, S * 0.66, S * 0.5, S * 0.66, S * 0.34);
      ctx.stroke();
      ctx.fillStyle = th.accent;
      for (const [x, y] of [[0.34, 0.24], [0.34, 0.76], [0.66, 0.34]]) {
        ctx.beginPath();
        ctx.arc(S * x, S * y, S * 0.075, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  {
    id: "loading",
    draw: (ctx, S, th) => {
      [th.dim, th.fg, th.accent].forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(S * (0.28 + i * 0.22), S * 0.52, S * 0.075, 0, Math.PI * 2);
        ctx.fill();
      });
    },
  },
  {
    id: "play",
    draw: (ctx, S, th) => {
      ctx.fillStyle = th.fg;
      ctx.beginPath();
      ctx.moveTo(S * 0.36, S * 0.27);
      ctx.lineTo(S * 0.74, S * 0.5);
      ctx.lineTo(S * 0.36, S * 0.73);
      ctx.closePath();
      ctx.fill();
    },
  },
  {
    id: "stop",
    draw: (ctx, S, th) => {
      ctx.fillStyle = th.bad;
      roundRect(ctx, S * 0.31, S * 0.31, S * 0.38, S * 0.38, S * 0.05);
      ctx.fill();
    },
  },
  {
    id: "lock",
    draw: (ctx, S, th) => {
      stroke(ctx, S, th, "accent", 0.06);
      ctx.beginPath();
      ctx.arc(S * 0.5, S * 0.4, S * 0.14, Math.PI, 0);
      ctx.stroke();
      ctx.fillStyle = th.fg;
      roundRect(ctx, S * 0.3, S * 0.4, S * 0.4, S * 0.3, S * 0.05);
      ctx.fill();
      ctx.fillStyle = th.bg;
      ctx.beginPath();
      ctx.arc(S * 0.5, S * 0.55, S * 0.04, 0, Math.PI * 2);
      ctx.fill();
    },
  },
];

const withBase = (th, size, drawFn) => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = th.bg;
  roundRect(ctx, size * 0.04, size * 0.04, size * 0.92, size * 0.92, size * 0.2);
  ctx.fill();
  ctx.strokeStyle = th.dim;
  ctx.lineWidth = Math.max(1, size * 0.018);
  roundRect(ctx, size * 0.04, size * 0.04, size * 0.92, size * 0.92, size * 0.2);
  ctx.stroke();
  drawFn(ctx, size, th);
  return canvas.encode("png");
};

export const renderIcon = (icon, theme, size = 512) => withBase(THEMES[theme] ?? THEMES.terminal, size, icon.draw);

/** Short text as a terminal badge: up to 2 balanced lines. */
const breakLines = (words) => {
  for (const limit of [7, 9, 12]) {
    const lines = [];
    for (const w of words) {
      const last = lines[lines.length - 1];
      if (last !== undefined && `${last} ${w}`.length <= limit) lines[lines.length - 1] = `${last} ${w}`;
      else lines.push(w);
    }
    if (lines.length <= 2) return lines;
  }
  return words.slice(0, 2);
};

export const renderBadge = (raw, theme, size = 512) => {
  const words = String(raw).trim().replace(/\s+/g, " ").slice(0, 25).split(" ").map((w) => w.slice(0, 12));
  const lines = breakLines(words);
  const shown = lines.slice(0, 2);
  return withBase(THEMES[theme] ?? THEMES.terminal, size, (ctx, S, th) => {
    shown.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? th.fg : th.accent;
      const y = shown.length === 1 ? S * 0.52 : S * (0.4 + i * 0.22);
      fitText(ctx, line, S / 2, y, S * 0.74, S * (shown.length === 1 ? 0.3 : 0.24));
    });
  });
};

/* ───────────────────────────── media conversion ───────────────────────────── */

const square = (n) => `scale=${n}:${n}:force_original_aspect_ratio=increase:flags=lanczos,crop=${n}:${n}`;
const ffmpegError = (err, fallback) => new Error(`${fallback} (${String(err?.stderr ?? err?.message ?? "").trim().split("\n").pop()?.slice(0, 120) || "ffmpeg failed"})`);

async function isWebm(file) {
  const fh = await fs.open(file);
  const head = Buffer.alloc(4);
  await fh.read(head, 0, 4, 0).finally(() => fh.close());
  return head.toString("hex") === "1a45dfa3";
}

/** 100x100 VP9 clip (<= 2.9 s) shrunk until it is under Telegram's 256 KB cap. */
async function toWebm(source, dir) {
  const out = path.join(dir, "emoji.webm");
  const webm = await isWebm(source);
  for (const [crf, fps] of [[32, 30], [40, 30], [48, 24], [56, 20]]) {
    const args = ["-y", "-loglevel", "error"];
    if (webm) args.push("-c:v", "libvpx-vp9"); // a video sticker's alpha is only kept by libvpx's decoder
    args.push("-t", "2.9", "-i", source, "-t", "2.9", "-vf", `fps=${fps},${square(100)}`,
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", String(crf), "-an", "-map_metadata", "-1", out);
    try {
      await run(FFMPEG, args, { timeout: 120_000 });
    } catch (err) {
      throw ffmpegError(err, "could not read that video");
    }
    const size = (await fs.stat(out).catch(() => ({ size: 0 }))).size;
    if (!size) throw new Error("the video has no frames");
    if (size <= MAX_WEBM) return out;
  }
  throw new Error("the clip stays over 256 KB — try a calmer part of it");
}

async function still(source, dir, name, n, ext) {
  const out = path.join(dir, `${name}.${ext}`);
  const codec = ext === "webp" ? ["-c:v", "libwebp", "-lossless", "0", "-quality", "92"] : [];
  try {
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", source, "-vf", square(n), "-frames:v", "1", ...codec, out], { timeout: 60_000 });
  } catch (err) {
    throw ffmpegError(err, "could not read that picture");
  }
  return out;
}

async function toGif(source, dir) {
  const out = path.join(dir, "emoji.gif");
  const webm = await isWebm(source);
  try {
    await run(
      FFMPEG,
      ["-y", "-loglevel", "error", ...(webm ? ["-c:v", "libvpx-vp9"] : []), "-t", "3", "-i", source,
        "-vf", `fps=15,${square(256)},split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse`, "-loop", "0", out],
      { timeout: 120_000 },
    );
  } catch {
    return null; // the GIF is a bonus; the emoji itself still works
  }
  return out;
}

/* ───────────────────────────── Telegram helpers ───────────────────────────── */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_]/g, "");

async function botName(api) {
  if (!api.username) api.username = slug((await api.call("getMe", {}))?.username ?? "");
  return api.username;
}

const blob = async (file, type) => new Blob([await fs.readFile(file)], { type });

const friendly = (why) => {
  const w = String(why ?? "Telegram refused it");
  if (/PEER_ID_INVALID|user not found|bot was blocked/i.test(w)) return "សូមចុច /start ជាមួយ bot ជាមុនសិន ហើយសាកម្ដងទៀត";
  return w.replace(/^Bad Request:\s*/, "");
};

async function sendFiles(api, chatId, files, caption) {
  for (const [i, f] of files.entries()) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", await blob(f.file, f.type), f.name);
    if (i === 0 && caption) form.set("caption", caption);
    await api.form("sendDocument", form);
  }
}

/** Adds one sticker to the sender's personal pack, creating the pack on the first one. */
async function addToPersonalPack(api, user, file, moving) {
  const bot = await botName(api);
  const name = `emoji${user.id}_by_${bot}`;
  const form = new FormData();
  form.set("user_id", String(user.id));
  form.set("name", name);
  form.set("file", await blob(file, moving ? "video/webm" : "image/png"), path.basename(file));
  const sticker = { sticker: "attach://file", format: moving ? "video" : "static", emoji_list: ["✨"] };

  const existing = await api.call("getStickerSet", { name });
  let res;
  if (existing && existing.stickers) {
    if (existing.stickers.length >= PACK_LIMIT) throw new Error("កញ្ចប់ពេញហើយ (200 emoji)");
    form.set("sticker", JSON.stringify(sticker));
    res = await api.form("addStickerToSet", form);
  } else {
    form.set("title", `${(user.first_name || "My").slice(0, 30)} · Khmer Dubber Emoji`);
    form.set("sticker_type", "custom_emoji");
    form.set("stickers", JSON.stringify([sticker]));
    res = await api.form("createNewStickerSet", form);
  }
  if (!res.ok) throw new Error(friendly(res.description));
  const set = await api.call("getStickerSet", { name });
  return { link: `https://t.me/addemoji/${name}`, count: set?.stickers?.length ?? 1 };
}

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "emoji-"));
const cleanup = (dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {});

/* ───────────────────────────── public flows ───────────────────────────── */

/** A photo / GIF / video / sticker in a message -> emoji + files. Returns false when there is no usable media. */
export function mediaOf(message) {
  if (message.animation) return { ...message.animation, moving: true };
  if (message.video) return { ...message.video, moving: true };
  if (message.video_note) return { ...message.video_note, moving: true };
  if (message.sticker) return { ...message.sticker, moving: !!(message.sticker.is_video || message.sticker.is_animated), tgs: !!message.sticker.is_animated };
  if (message.photo?.length) return { ...message.photo[message.photo.length - 1], moving: false };
  const doc = message.document;
  if (doc && /^(image|video)\//.test(doc.mime_type ?? "")) return { ...doc, moving: !/^image\/(png|jpe?g|webp)$/.test(doc.mime_type) };
  return null;
}

export async function mediaToEmoji(api, message) {
  const media = mediaOf(message);
  const chatId = message.chat.id;
  const user = message.from;
  if (media.tgs) throw new Error("Sticker ចល័ត (.tgs) មិនអាចបំប្លែងបានទេ — ផ្ញើ GIF វីដេអូ ឬ Sticker វីដេអូ");
  if (media.file_size && media.file_size > MAX_TELEGRAM_FILE) throw new Error("ឯកសារធំពេក (លើស 20MB) — ផ្ញើឯកសារតូចជាងនេះ");

  const dir = await tmp();
  try {
    const info = await api.call("getFile", { file_id: media.file_id });
    if (!info?.file_path) throw new Error("Telegram មិនឲ្យឯកសារ");
    const source = path.join(dir, "source");
    await fs.writeFile(source, Buffer.from(await (await fetch(api.fileUrl(info.file_path))).arrayBuffer()));

    const files = [];
    const png100 = await still(source, dir, "emoji_100", 100, "png");
    const png512 = await still(source, dir, "emoji_512", 512, "png");
    const webp512 = await still(source, dir, "emoji_512", 512, "webp").catch(() => null);
    let pack;
    if (media.moving) {
      const webm = await toWebm(source, dir);
      pack = await addToPersonalPack(api, user, webm, true);
      files.push({ file: webm, name: "emoji_100.webm", type: "video/webm" });
      const gif = await toGif(source, dir);
      if (gif) files.push({ file: gif, name: "emoji_256.gif", type: "image/gif" });
    } else {
      pack = await addToPersonalPack(api, user, png100, false);
    }
    files.push({ file: png512, name: "emoji_512.png", type: "image/png" });
    if (webp512) files.push({ file: webp512, name: "emoji_512.webp", type: "image/webp" });
    files.push({ file: png100, name: "emoji_100.png", type: "image/png" });

    await sendFiles(api, chatId, files, "📁 ឯកសារគ្រប់ទម្រង់ (ប្រើក្នុង project ផ្សេង បាន)");
    return pack;
  } finally {
    await cleanup(dir);
  }
}

/** The coding icon set: custom emoji pack + ZIP of PNGs. */
export async function codingPack(api, user, chatId, theme) {
  if (!THEMES[theme]) theme = "terminal";
  const bot = await botName(api);
  const name = `code${theme}${user.id}_by_${bot}`;
  const dir = await tmp();
  try {
    await fs.mkdir(path.join(dir, "png512"));
    await fs.mkdir(path.join(dir, "png100"));
    const stickers = [];
    for (const icon of ICONS) {
      await fs.writeFile(path.join(dir, "png512", `${icon.id}.png`), await renderIcon(icon, theme, 512));
      await fs.writeFile(path.join(dir, "png100", `${icon.id}.png`), await renderIcon(icon, theme, 100));
      stickers.push(icon.id);
    }
    await fs.writeFile(
      path.join(dir, "README.txt"),
      `Khmer Dubber — Coding & Terminal emoji (${theme})\n\npng512/  512x512 transparent PNG: README, Discord/Slack custom emoji, docs, slides\npng100/  100x100 PNG: Telegram custom emoji size\n\nMarkdown:  ![ok](png512/ok.png)\nHTML:      <img src="png512/ok.png" width="24" alt="ok">\n`,
    );

    let created = false;
    const existing = await api.call("getStickerSet", { name });
    if (!existing?.stickers) {
      const form = new FormData();
      form.set("user_id", String(user.id));
      form.set("name", name);
      form.set("title", `Coding · ${THEMES[theme].label.slice(2)}`.slice(0, 64));
      form.set("sticker_type", "custom_emoji");
      const list = [];
      for (const id of stickers) {
        form.set(`f_${id}`, await blob(path.join(dir, "png100", `${id}.png`), "image/png"), `${id}.png`);
        list.push({ sticker: `attach://f_${id}`, format: "static", emoji_list: ["💻"] });
      }
      form.set("stickers", JSON.stringify(list));
      const res = await api.form("createNewStickerSet", form);
      if (!res.ok) throw new Error(friendly(res.description));
      created = true;
    }

    const zip = path.join(dir, `coding-emoji-${theme}.zip`);
    await run("python3", ["-m", "zipfile", "-c", zip, "README.txt", "png512", "png100"], { cwd: dir, timeout: 60_000 });
    await sendFiles(api, chatId, [{ file: zip, name: `coding-emoji-${theme}.zip`, type: "application/zip" }], "📦 ZIP: PNG 512 + 100 + README");
    return { link: `https://t.me/addemoji/${name}`, created, count: ICONS.length };
  } finally {
    await cleanup(dir);
  }
}

/** Short text as a terminal-style badge (PNG 512 + 100) and an emoji in the sender's personal pack. */
export async function badge(api, user, chatId, label, theme) {
  const dir = await tmp();
  try {
    const p512 = path.join(dir, "badge_512.png");
    const p100 = path.join(dir, "badge_100.png");
    await fs.writeFile(p512, await renderBadge(label, theme, 512));
    await fs.writeFile(p100, await renderBadge(label, theme, 100));
    const pack = await addToPersonalPack(api, user, p100, false);
    await sendFiles(api, chatId, [
      { file: p512, name: "badge_512.png", type: "image/png" },
      { file: p100, name: "badge_100.png", type: "image/png" },
    ], `🏷 ${label}`);
    return pack;
  } finally {
    await cleanup(dir);
  }
}
