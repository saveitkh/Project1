/**
 * KHQR payload surgery -- ported from the telegrambot- app
 * (src/lib/khqrTemplate.ts), where it is already proven against ABA.
 *
 * Banks will not accept a payload a third party assembled from scratch (ABA
 * carries a proprietary tag 40 with a per-account reference and rejects a
 * QR without it: "Invalid Qr Merchant Data"). So instead of building a QR,
 * this reuses one the owner's own bank app generated: per order only the
 * amount is swapped and the checksum recomputed. Every other field travels
 * through byte for byte.
 */
import crypto from "node:crypto";

const TAG_POINT_OF_INITIATION = "01";
const TAG_AMOUNT = "54";
const TAG_CRC = "63";

/** Splits an EMVCo payload into top-level tag/value pairs, or null if it does not parse cleanly. */
export function parseKhqr(payload) {
  const fields = [];
  let i = 0;
  while (i < payload.length) {
    if (i + 4 > payload.length) return null;
    const tag = payload.slice(i, i + 2);
    const lenText = payload.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(lenText)) return null;
    const len = Number(lenText);
    if (i + 4 + len > payload.length) return null;
    fields.push({ tag, value: payload.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return fields.length ? fields : null;
}

function serialise(fields) {
  return fields.map(({ tag, value }) => `${tag}${String(value.length).padStart(2, "0")}${value}`).join("");
}

/** CRC-16/CCITT-FALSE -- the checksum KHQR carries in tag 63. */
export function khqrCrc(input) {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function hasValidCrc(payload) {
  if (payload.length < 8 || payload.slice(-8, -4) !== "6304") return false;
  return khqrCrc(payload.slice(0, -4)) === payload.slice(-4).toUpperCase();
}

/**
 * Checks a payload is a KHQR this bot can safely reuse. Returns
 * { ok: true, payload } or { ok: false, reason }.
 *
 * The checksum is what proves a paste is complete; the amount field is what
 * proves it's a fixed-amount QR -- a static one lets the payer type any
 * amount, which is exactly what per-order QRs exist to prevent.
 */
export function validateKhqrTemplate(payload) {
  const trimmed = String(payload ?? "").trim();
  const fields = parseKhqr(trimmed);
  if (!fields) return { ok: false, reason: "unparseable" };
  if (!hasValidCrc(trimmed)) return { ok: false, reason: "bad-checksum" };
  if (!fields.some((f) => f.tag === TAG_AMOUNT)) return { ok: false, reason: "no-amount-field" };
  return { ok: true, payload: trimmed };
}

/**
 * The owner's QR rewritten for one payment of `amount` USD. `merchantName`
 * replaces the payee name (tag 59) -- only for a bank that accepts that:
 * ACLEDA does, ABA refuses such a QR outright.
 */
export function applyKhqrTemplate(template, amount, { merchantName = null } = {}) {
  const valid = validateKhqrTemplate(template);
  if (!valid.ok) return valid;
  const name = merchantName ? String(merchantName).trim() : "";
  // EMV caps the merchant name at 25 characters.
  if (name.length > 25) return { ok: false, reason: "name-too-long" };

  const out = [];
  for (const field of parseKhqr(valid.payload)) {
    if (field.tag === TAG_CRC) continue; // recomputed below, over the result
    if (field.tag === TAG_AMOUNT) {
      out.push({ tag: TAG_AMOUNT, value: Number(amount).toFixed(2) });
    } else if (field.tag === "59" && name) {
      out.push({ tag: "59", value: name });
    } else if (field.tag === TAG_POINT_OF_INITIATION) {
      // 11 = static, 12 = dynamic; carrying an amount makes it dynamic.
      out.push({ tag: TAG_POINT_OF_INITIATION, value: "12" });
    } else {
      out.push(field);
    }
  }
  const body = `${serialise(out)}${TAG_CRC}04`;
  return { ok: true, payload: `${body}${khqrCrc(body)}` };
}

/** What Bakong's check_transaction_by_md5 is asked about. */
export function khqrMd5(payload) {
  return crypto.createHash("md5").update(payload).digest("hex");
}
