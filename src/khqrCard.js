/**
 * The KHQR card the bot sends as a photo: the familiar white card -- red
 * band, payee, amount, QR with the Bakong mark in the middle -- and nothing
 * else around it.
 *
 * Drawn with @napi-rs/canvas and fonts shipped in assets/fonts, so it needs
 * nothing from the system. The payee and amount are read from the payload
 * itself, so the picture can never disagree with what the bank will show.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import QRCode from "qrcode";

import { parseKhqr } from "./khqr.js";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

let fontsReady = false;
function registerFonts() {
  if (fontsReady) return;
  fontsReady = true;
  const fonts = [
    ["Inter_600SemiBold.ttf", "Inter"],
    ["Inter_800ExtraBold.ttf", "Inter"],
    ["Battambang_400Regular.ttf", "Battambang"],
    ["Battambang_700Bold.ttf", "Battambang"],
  ];
  for (const [file, family] of fonts) {
    try {
      GlobalFonts.registerFromPath(path.join(ASSETS, "fonts", file), family);
    } catch (err) {
      console.error(`Font ${file} unavailable:`, err?.message ?? err);
    }
  }
}

// Decorations are cached and optional: a missing file just leaves a gap,
// it never stops someone paying.
const imageCache = new Map();
async function asset(relative) {
  if (!imageCache.has(relative)) {
    imageCache.set(
      relative,
      loadImage(path.join(ASSETS, relative)).catch((err) => {
        console.error(`KHQR ticket asset ${relative} unavailable:`, err?.message ?? err);
        return null;
      })
    );
  }
  return imageCache.get(relative);
}

const C = {
  red: "#E11B24",
  ink: "#111111",
  muted: "#8A8A8A",
  dash: "#DCDCDC",
};

/** Text with letter spacing, drawn a glyph at a time (canvas spacing support varies). */
function spaced(g, text, x, y, spacing, align = "left") {
  const widths = [...text].map((ch) => g.measureText(ch).width);
  const total = widths.reduce((a, w) => a + w, 0) + spacing * (widths.length - 1);
  let cx = align === "center" ? x - total / 2 : align === "right" ? x - total : x;
  const saved = g.textAlign;
  g.textAlign = "left";
  [...text].forEach((ch, i) => {
    g.fillText(ch, cx, y);
    cx += widths[i] + spacing;
  });
  g.textAlign = saved;
}

function ellipsize(g, text, maxWidth) {
  if (g.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function dashedLine(g, x0, x1, y, colour, dash = 5, gap = 4) {
  g.save();
  g.strokeStyle = colour;
  g.lineWidth = 1;
  g.setLineDash([dash, gap]);
  g.beginPath();
  g.moveTo(x0, y + 0.5);
  g.lineTo(x1, y + 0.5);
  g.stroke();
  g.restore();
}

function payloadFacts(payload) {
  const fields = parseKhqr(payload) ?? [];
  const get = (tag) => fields.find((f) => f.tag === tag)?.value ?? null;
  const currency = get("53") === "116" ? "KHR" : "USD";
  const amount = Number(get("54") ?? 0);
  const value =
    currency === "KHR"
      ? Math.round(amount).toLocaleString("en-US")
      : amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { name: get("59") ?? "", value, currency };
}

/** Draws the QR modules crisply at an exact pixel size. */
function drawQr(g, payload, x, y, size, scale) {
  // H: survives the ~20% the centre mark covers, with room to spare.
  const qr = QRCode.create(payload, { errorCorrectionLevel: "H" });
  const n = qr.modules.size;
  const quiet = 1;
  const total = n + quiet * 2;
  // The module size is snapped to whole device pixels: at a small card size
  // `size / total` lands between pixels, and rounding each module's edges
  // out independently (the old approach) then makes some a pixel wider than
  // others. A camera reads that fine, but it was enough to confuse a strict
  // decoder -- the very thing this card exists to be scanned by.
  const cellPx = Math.max(1, Math.round((size * scale) / total));
  const cell = cellPx / scale;
  const drawn = cell * total;
  const ox = x + (size - drawn) / 2; // centre the (slightly smaller) grid in the box
  const oy = y + (size - drawn) / 2;
  g.fillStyle = "#FFFFFF";
  g.fillRect(x, y, size, size);
  g.fillStyle = "#0A101E";
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.modules.get(r, c)) {
        g.fillRect(ox + (c + quiet) * cell, oy + (r + quiet) * cell, cell, cell);
      }
    }
  }
}

async function drawCentreMark(g, cx, cy, qrSize) {
  const outer = qrSize * 0.1;
  g.fillStyle = "rgba(0,0,0,0.16)";
  g.beginPath();
  g.arc(cx, cy + outer * 0.05, outer * 1.04, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#FFFFFF";
  g.beginPath();
  g.arc(cx, cy, outer, 0, Math.PI * 2);
  g.fill();
  const mark = await asset("bakong-mark.png");
  const size = outer * 1.55;
  if (mark) {
    g.drawImage(mark, cx - size / 2, cy - size / 2, size, size);
  } else {
    g.fillStyle = C.red;
    g.beginPath();
    g.arc(cx, cy, outer * 0.86, 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * Renders the KHQR card alone as a PNG buffer -- the white card every
 * Cambodian bank app shows: red KHQR band, payee, amount, then the QR with
 * the Bakong mark in the middle. Nothing around it, so in the chat it is a
 * small, familiar card rather than a tall poster; what is being bought and
 * the ticket number go in the caption instead.
 *   merchantName -- the name printed on the card, e.g. the service being
 *     paid for. Display only: the payload keeps the account's real name,
 *     because ABA refuses a KHQR whose name was rewritten.
 * Drawn at 3x a 240-point layout: compact in the chat, sharp when opened
 * and easy for another phone's camera to read off the screen.
 */
export async function renderKhqrCard(payload, { merchantName = "", scale = 3 } = {}) {
  registerFonts();
  const facts = payloadFacts(payload);

  // A compact card: small enough in the chat to take in at a glance, still
  // sharp enough at 3x for another phone's camera to read off this screen.
  const W = 196;
  const pad = 14;
  const redH = 32;
  const qrSize = W - pad * 2;
  const nameY = redH + 21;
  const amountY = nameY + 25;
  const dashY = amountY + 12;
  const qrY = dashY + 8;
  const H = qrY + qrSize + pad - 4;

  const canvas = createCanvas(W * scale, H * scale);
  const g = canvas.getContext("2d");
  g.scale(scale, scale);
  g.textBaseline = "alphabetic";

  g.fillStyle = "#FFFFFF";
  g.fillRect(0, 0, W, H);

  // Red band with the KHQR card's clipped bottom-right corner.
  g.fillStyle = C.red;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(W, 0);
  g.lineTo(W, redH * 0.55);
  g.lineTo(W * 0.86, redH);
  g.lineTo(0, redH);
  g.closePath();
  g.fill();
  g.fillStyle = "#FFFFFF";
  g.font = "800 13px Inter";
  spaced(g, "KHQR", W / 2, redH / 2 + 4.5, 2.4, "center");

  g.textAlign = "left";
  g.fillStyle = C.ink;
  g.font = "600 11px Inter, Battambang";
  g.fillText(ellipsize(g, merchantName || facts.name, W - pad * 2), pad, nameY);
  g.font = "800 20px Inter";
  g.fillText(facts.value, pad, amountY);
  const valueW = g.measureText(facts.value).width;
  g.fillStyle = C.muted;
  g.font = "600 10.5px Inter";
  g.fillText(facts.currency, pad + valueW + 4, amountY);

  dashedLine(g, pad, W - pad, dashY, C.dash, 4, 3);

  drawQr(g, payload, pad, qrY, qrSize, scale);
  await drawCentreMark(g, pad + qrSize / 2, qrY + qrSize / 2, qrSize);

  return canvas.toBuffer("image/png");
}
