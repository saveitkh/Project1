/**
 * Supabase access for the service.
 *
 * Everything here runs with the service-role key, so it bypasses RLS. Only
 * this process should ever hold that key.
 */
import { createClient } from "@supabase/supabase-js";

import { config } from "./config.js";

let client = null;

export function db() {
  if (!client) {
    if (!config.supabaseUrl || !config.supabaseServiceKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
    }
    client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

/** Throws on a Supabase error, otherwise hands back the rows. */
export function rows(result) {
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}

/**
 * PostgREST caps one response at 1000 rows and says nothing about it: a plain
 * .select() over a group with 1500 videos quietly returns the first 1000. That
 * silently truncated every count this service recomputes (a topic with 247
 * videos was stored as 24) and made a re-scan miss episodes it had already
 * seen, so any query that means "all of them" has to page.
 *
 * `build` is called once per page and must return a fresh query ordered by
 * something stable (id), which is what makes consecutive pages line up.
 */
export const PAGE_SIZE = 1000;

export async function fetchAll(build) {
  const all = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = rows(await build().range(from, from + PAGE_SIZE - 1));
    all.push(...page);
    if (page.length < PAGE_SIZE) return all;
  }
}

/** Reads the one settings row a table is expected to hold ({} when empty). */
export async function single(table) {
  const data = rows(await db().from(table).select("*").limit(1));
  return data[0] ?? {};
}

/** Updates the single settings row, inserting it when the table is empty. */
export async function upsertSingle(table, values) {
  const existing = await single(table);
  const result = existing.id
    ? await db().from(table).update(values).eq("id", existing.id).select()
    : await db().from(table).insert(values).select();
  return rows(result)[0] ?? {};
}

/** Telegram credentials, preferring environment variables over the database. */
export async function telegramSettings() {
  const row = await single("telegram_settings");
  return {
    id: row.id,
    apiId: config.telegramApiId || row.api_id || "",
    apiHash: config.telegramApiHash || row.api_hash || "",
    phone: config.telegramPhone || row.phone || "",
    // The database first. Signing in again through the web app writes the new
    // session there -- but this used to prefer TELEGRAM_SESSION_STRING, so the
    // next restart loaded the old, already-invalidated env session straight
    // back and a fresh login never survived a deploy. The env var is now only
    // a first-boot seed for a database that has never held a session.
    sessionString: row.session_string || config.telegramSession || "",
    storageChatId: row.storage_chat_id || "",
  };
}

/** Every account added beyond the default one (telegram_settings). */
export async function telegramAccounts() {
  return rows(await db().from("telegram_accounts").select("*").order("created_at", { ascending: true }));
}

/** One extra account by id, or null. account_id on a group is always one of these ids, never telegram_settings'. */
export async function telegramAccountById(id) {
  if (!id) return null;
  const [row] = rows(await db().from("telegram_accounts").select("*").eq("id", id).limit(1));
  return row ?? null;
}

/** R2 credentials, preferring environment variables over the database. */
export async function r2Settings() {
  const fromEnv = {
    accountId: config.r2AccountId,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    bucketName: config.r2BucketName,
    endpointUrl: config.r2EndpointUrl,
    publicUrl: config.r2PublicUrl,
    region: config.r2Region || "auto",
  };
  // Fully configured by environment variables -- skip Supabase entirely, so a
  // local one-off script (e.g. the S3-to-R2 migration) needs no
  // SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY just to read R2 credentials.
  if (fromEnv.accessKeyId && fromEnv.secretAccessKey && fromEnv.bucketName && (fromEnv.endpointUrl || fromEnv.accountId)) {
    return fromEnv;
  }
  const row = await single("r2_settings");
  return {
    accountId: fromEnv.accountId || row.account_id || "",
    accessKeyId: fromEnv.accessKeyId || row.access_key_id || "",
    secretAccessKey: fromEnv.secretAccessKey || row.secret_access_key || "",
    bucketName: fromEnv.bucketName || row.bucket_name || "",
    endpointUrl: fromEnv.endpointUrl || row.endpoint_url || "",
    publicUrl: fromEnv.publicUrl || row.public_url || "",
    region: fromEnv.region || row.region || "auto",
  };
}

/** Source S3-compatible credentials, preferring environment variables over the database. */
export async function s3SourceSettings() {
  const fromEnv = {
    endpointUrl: config.s3Endpoint,
    accessKeyId: config.s3AccessKeyId,
    secretAccessKey: config.s3SecretAccessKey,
    bucketName: config.s3BucketName,
    region: config.s3Region || "us-east-1",
    forcePathStyle: config.s3ForcePathStyle,
  };
  // Fully configured by environment variables -- skip Supabase entirely, so a
  // local one-off script (e.g. the S3-to-R2 migration CLI) needs no
  // SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY just to read these credentials.
  if (fromEnv.endpointUrl && fromEnv.accessKeyId && fromEnv.secretAccessKey && fromEnv.bucketName) {
    return fromEnv;
  }
  const row = await single("s3_source_settings");
  return {
    endpointUrl: fromEnv.endpointUrl || row.endpoint_url || "",
    accessKeyId: fromEnv.accessKeyId || row.access_key_id || "",
    secretAccessKey: fromEnv.secretAccessKey || row.secret_access_key || "",
    bucketName: fromEnv.bucketName || row.bucket_name || "",
    region: fromEnv.region || row.region || "us-east-1",
    forcePathStyle: row.force_path_style ?? fromEnv.forcePathStyle ?? true,
  };
}

export async function downloadSettings() {
  const row = await single("download_settings");
  return {
    concurrentDownloads: row.concurrent_downloads ?? 3,
    autoR2Upload: row.auto_r2_upload ?? true,
    r2FolderPattern: row.r2_folder_pattern || "{group}/{topic}/EP{ep}",
    retryOnFail: row.retry_on_fail ?? true,
  };
}

export const nowIso = () => new Date().toISOString();
