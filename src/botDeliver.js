/**
 * Sending a full-size video back through the bot.
 *
 * A bot may only upload 50MB, which is smaller than every real episode, so
 * the bot used to answer with an R2 link instead of the video itself. But
 * that limit is on UPLOADING new bytes -- a file already sitting on
 * Telegram's servers can be copied to anyone, at any size, instantly.
 *
 * So: the userbot forwards the original post into a private storage channel
 * (server-side, no bytes through this process at all), and the bot copies it
 * from there to whoever asked. The person gets a real, playable video in the
 * chat, and nothing is downloaded or re-uploaded on the way.
 *
 * The one requirement is that the bot is a member of that storage channel --
 * copyMessage cannot read a chat the bot is not in. When it isn't, every
 * call here fails cleanly and the caller falls back to the old path.
 */
import { db, nowIso, rows, telegramSettings } from "./db.js";
import { call } from "./notifyBot.js";
import * as telegramStorage from "./telegramStorage.js";

/** The storage channel id, or "" when the operator has not set one. */
export async function storageChatId() {
  const conf = await telegramSettings();
  return conf.storageChatId || "";
}

/**
 * Copies one already-stored Telegram message to a chat. Returns true when
 * Telegram accepted it -- false means the bot cannot see the storage channel,
 * which is the caller's cue to fall back.
 */
async function copyToUser(userChatId, fromChatId, messageId, caption) {
  const result = await call("copyMessage", {
    chat_id: userChatId,
    from_chat_id: fromChatId,
    message_id: Number(messageId),
    ...(caption ? { caption } : {}),
  });
  return Boolean(result?.ok);
}

/**
 * Delivers one Telegram post as a real video, via the storage channel.
 * Returns { ok } -- ok false leaves it to the caller to try another way.
 */
export async function deliverTelegramPost({ userChatId, sourceChatId, messageId, caption }) {
  const storage = await storageChatId();
  if (!storage) return { ok: false, reason: "no-storage" };

  try {
    // Forwarded server-side: Telegram copies its own file, so a 1.5GB episode
    // costs this process nothing and takes about as long as a text message.
    const stored = await telegramStorage.storeMessage(sourceChatId, messageId);
    const sent = await copyToUser(userChatId, stored.chatId, stored.messageId, caption);
    return sent ? { ok: true } : { ok: false, reason: "bot-not-in-storage" };
  } catch (err) {
    // A group with content protection on refuses to be forwarded at all.
    return { ok: false, reason: "forward-refused", error: err?.message ?? String(err) };
  }
}

/**
 * Delivers a library episode. One that has been through the storage channel
 * before is copied straight from it; otherwise its original post is forwarded
 * there first and the id remembered, so the second person to ask for the same
 * episode costs nothing at all.
 */
export async function deliverEpisode({ userChatId, episodeId, caption }) {
  const [episode] = rows(
    await db()
      .from("episodes")
      .select("id, message_id, tg_storage_chat_id, tg_storage_message_id, group:groups(chat_id)")
      .eq("id", episodeId)
      .limit(1)
  );
  if (!episode) return { ok: false, reason: "no-episode" };

  if (episode.tg_storage_chat_id && episode.tg_storage_message_id) {
    const sent = await copyToUser(
      userChatId,
      episode.tg_storage_chat_id,
      episode.tg_storage_message_id,
      caption
    );
    if (sent) return { ok: true };
  }

  const sourceChatId = episode.group?.chat_id;
  if (!sourceChatId || !episode.message_id) return { ok: false, reason: "no-source" };

  const storage = await storageChatId();
  if (!storage) return { ok: false, reason: "no-storage" };

  try {
    const stored = await telegramStorage.storeMessage(sourceChatId, episode.message_id);
    await db()
      .from("episodes")
      .update({
        tg_storage_chat_id: stored.chatId,
        tg_storage_message_id: stored.messageId,
        updated_at: nowIso(),
      })
      .eq("id", episode.id);

    const sent = await copyToUser(userChatId, stored.chatId, stored.messageId, caption);
    return sent ? { ok: true } : { ok: false, reason: "bot-not-in-storage" };
  } catch (err) {
    return { ok: false, reason: "forward-refused", error: err?.message ?? String(err) };
  }
}

/**
 * Saves the storage channel from a message the operator forwarded out of it.
 * Reading the id off a forward means nobody has to find a raw -100... chat id
 * by hand. Returns a message to show the operator.
 */
export async function setStorageFromForward(message) {
  const origin = message?.forward_from_chat;
  if (!origin?.id) {
    return (
      "Forward any message from your storage channel to me with the caption /setstorage " +
      "(or send /setstorage <chat id>).\n\n" +
      "The channel must be private, the userbot account must be in it, and this bot must be an admin of it."
    );
  }
  return saveStorageChat(origin.id, origin.title);
}

export async function saveStorageChat(chatId, title) {
  const [settings] = rows(await db().from("telegram_settings").select("id").limit(1));
  if (!settings?.id) return "No telegram_settings row to save this on.";

  // Prove the bot can actually read the channel before saving an id that
  // would otherwise fail silently on every later delivery.
  const check = await call("getChat", { chat_id: String(chatId) });
  if (!check?.ok) {
    return (
      `❌ I can't see that chat (${chatId}). Add this bot to the channel as an admin, then try again.`
    );
  }

  await db()
    .from("telegram_settings")
    .update({ storage_chat_id: String(chatId), updated_at: nowIso() })
    .eq("id", settings.id);
  return `✅ Storage channel set: ${title || check.result?.title || chatId}\n\nFull-size videos will now be delivered in the chat instead of as a link.`;
}
