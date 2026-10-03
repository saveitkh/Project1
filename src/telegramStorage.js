/**
 * "Telegram as storage": an alternative to R2 for a group whose
 * `storage_backend` is set to "telegram" -- the source message is forwarded
 * into one private storage chat the userbot already has access to, exactly
 * like the existing "Mirror to new group" forward path, so the file is
 * copied server-side by Telegram and never touches this process's disk or
 * bandwidth. Free, but retrieval later has to go back through Telegram
 * (see downloadStoredMessage) rather than a static CDN URL.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import { db, rows, telegramSettings } from "./db.js";
import { withFloodRetry } from "./floodRetry.js";
import { isCopyRefused } from "./forwarder.js";
import { mediaInfo } from "./scanner.js";
import { getClient, listAccounts, normalizeChatId, resolveEntity } from "./telegram.js";

// Not imported from downloader.js's own safeFilename: that module imports
// storeMessage() from this one, and a cycle is one risk not worth taking for
// one regex.
const ILLEGAL_IN_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;
const safeFilename = (name) => ((name || "").replace(ILLEGAL_IN_FILENAME, "_").replace(/^[\s.]+|[\s.]+$/g, "") || "video.mp4").slice(0, 120);

/**
 * A connected account that can see both the source group and the storage
 * channel. The source group's own account goes first -- the VIP group is
 * joined by a different account than the default one, and always using the
 * default account here is what made every forward fail with CHANNEL_INVALID.
 */
async function clientForBoth(sourceChatId, storageChatId) {
  const candidates = [];
  const [known] = rows(
    await db().from("groups").select("account_id").eq("chat_id", String(sourceChatId)).limit(1)
  );
  if (known) candidates.push(known.account_id ?? null);
  candidates.push(null);
  for (const account of await listAccounts()) if (account.connected) candidates.push(account.id);

  let lastErr = null;
  for (const accountId of [...new Set(candidates)]) {
    try {
      const client = await getClient({ accountId });
      const sourceEntity = await resolveEntity(client, normalizeChatId(sourceChatId));
      const storageEntity = await resolveEntity(client, storageChatId);
      return { client, sourceEntity, storageEntity };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    "No connected Telegram account is in both the source group and the storage channel -- " +
      `add the account that is in the source group to the storage channel. (${lastErr?.message ?? lastErr})`
  );
}

/** Forwards one source message into the configured storage chat. */
export async function storeMessage(sourceChatId, messageId) {
  const conf = await telegramSettings();
  if (!conf.storageChatId) {
    throw new Error("No Telegram storage channel is configured (Settings › Telegram).");
  }

  const storageChatId = normalizeChatId(conf.storageChatId);
  const { client, sourceEntity, storageEntity } = await clientForBoth(sourceChatId, storageChatId);

  try {
    const sent = await withFloodRetry(
      () => client.forwardMessages(storageEntity, { messages: [Number(messageId)], fromPeer: sourceEntity }),
      { label: `telegram-storage forward ${sourceChatId}/${messageId}` }
    );
    const first = Array.isArray(sent) ? sent[0] : sent;
    if (!first?.id) throw new Error("Telegram did not confirm the forward.");
    return { chatId: String(storageChatId), messageId: first.id };
  } catch (err) {
    if (!isCopyRefused(err)) throw err;
    // Content protection on the source group: Telegram will never copy this
    // by reference, forever, no matter how many accounts are tried -- the
    // only way to get the file into storage is to download it and upload it
    // again, the same fallback forwarder.js already uses for protected
    // groups elsewhere in this bot.
    return reuploadToStorage({ client, sourceEntity, storageEntity, storageChatId, messageId });
  }
}

/** Downloads the source message's video and uploads it fresh into storage. */
async function reuploadToStorage({ client, sourceEntity, storageEntity, storageChatId, messageId }) {
  const found = await withFloodRetry(() => client.getMessages(sourceEntity, { ids: Number(messageId) }), {
    label: `telegram-storage getMessages ${messageId}`,
  });
  const message = Array.isArray(found) ? found[0] : found;
  if (!message?.media) throw new Error("This message no longer has any media to store.");

  await fsp.mkdir(config.downloadDir, { recursive: true });
  const info = mediaInfo(message);
  const localPath = path.join(config.downloadDir, `tgstore-reupload-${messageId}-${safeFilename(info?.fileName || "video.mp4")}`);
  try {
    await withFloodRetry(() => client.downloadMedia(message, { outputFile: localPath }), {
      label: `telegram-storage download ${messageId} for re-upload`,
    });
    const sent = await withFloodRetry(
      () => client.sendFile(storageEntity, { file: localPath, caption: message.message || "", supportsStreaming: true, forceDocument: false }),
      { label: `telegram-storage re-upload ${messageId}` }
    );
    const first = Array.isArray(sent) ? sent[0] : sent;
    if (!first?.id) throw new Error("Telegram did not confirm the upload.");
    return { chatId: String(storageChatId), messageId: first.id };
  } finally {
    await fsp.rm(localPath, { force: true }).catch(() => {});
  }
}

/**
 * Fetches a previously-stored message's media into a temp file so it can be
 * streamed to a browser -- the same download-then-relay shape as linkBot.js,
 * including the same "always clean up after" contract on the caller.
 */
export async function downloadStoredMessage(chatId, messageId) {
  const client = await getClient();
  const entity = await resolveEntity(client, normalizeChatId(chatId));
  const found = await withFloodRetry(() => client.getMessages(entity, { ids: Number(messageId) }), {
    label: `telegram-storage fetch ${chatId}/${messageId}`,
  });
  const msg = Array.isArray(found) ? found[0] : found;
  if (!msg?.media) throw new Error("This stored message no longer has any media.");

  const info = mediaInfo(msg);
  await fsp.mkdir(config.downloadDir, { recursive: true });
  const localPath = path.join(config.downloadDir, `tgstore-${chatId}-${messageId}-${info?.fileName || "file"}`);
  await withFloodRetry(() => client.downloadMedia(msg, { outputFile: localPath }), {
    label: `telegram-storage download ${chatId}/${messageId}`,
  });

  const stream = fs.createReadStream(localPath);
  stream.on("close", () => {
    fsp.unlink(localPath).catch(() => {});
  });
  const stat = await fsp.stat(localPath);
  return {
    stream,
    contentType: info?.mimeType || "application/octet-stream",
    contentLength: stat.size,
    fileName: info?.fileName || `${messageId}`,
  };
}
