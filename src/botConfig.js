/**
 * Small bot settings that have no column of their own: the second bank's
 * KHQR (ACLEDA) and the names on the bank-choice buttons.
 *
 * Kept as one private JSON file in Supabase Storage (bucket "bot-config"),
 * which the service key can create and write -- no schema change needed.
 * Read through a short cache; every write refreshes it.
 */
import { db } from "./db.js";

const BUCKET = "bot-config";
const FILE = "payments.json";
const CACHE_MS = 60_000;

const DEFAULTS = {
  primary_label: "ABA",
  alt_label: "ACLEDA",
  alt_template: null,
  // ACLEDA accepts a QR whose payee name was rewritten, so the second bank's
  // QR carries the service's name; ABA's never does.
  rename_alt: true,
};

let cache = null;
let cachedAt = 0;

export async function paymentSettings() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  try {
    const { data, error } = await db().storage.from(BUCKET).download(FILE);
    if (error || !data) throw error ?? new Error("missing");
    cache = { ...DEFAULTS, ...JSON.parse(await data.text()) };
  } catch {
    cache = { ...DEFAULTS };
  }
  cachedAt = Date.now();
  return cache;
}

export async function savePaymentSettings(patch) {
  const next = { ...(await paymentSettings()), ...patch };
  const storage = db().storage;
  const body = new Blob([JSON.stringify(next, null, 2)], { type: "application/json" });
  let { error } = await storage.from(BUCKET).upload(FILE, body, { upsert: true, contentType: "application/json" });
  if (error && /bucket not found|not found/i.test(String(error.message ?? error))) {
    await storage.createBucket(BUCKET, { public: false });
    ({ error } = await storage.from(BUCKET).upload(FILE, body, { upsert: true, contentType: "application/json" }));
  }
  if (error) throw new Error(`Could not save bot settings: ${error.message ?? error}`);
  cache = next;
  cachedAt = Date.now();
  return next;
}
