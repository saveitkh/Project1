/**
 * The menu bot's link downloads.
 *
 * A link the bot is sent becomes an ordinary url_list_items row -- the very
 * same pipeline the web app's link lists use (yt-dlp or a direct fetch, then
 * straight into R2), so the bot adds no second downloader to maintain. All a
 * bot_jobs row remembers is who asked, so the result can be sent back to the
 * right chat once the worker has finished with it.
 */
import { config } from "./config.js";
import { db, rows } from "./db.js";
import { call } from "./notifyBot.js";
import { texts } from "./botText.js";
import * as urlfetch from "./urlfetch.js";

export const LIST_TITLE = "Bot Downloads";
// Telegram will fetch a remote URL for sendVideo/sendAudio only up to 20MB;
// anything larger has to go back as a plain link instead.
const SEND_BY_URL_LIMIT_BYTES = 20 * 1024 * 1024;

/** The one list every bot download lands in -- created on first use. */
async function botListId() {
  const found = rows(await db().from("url_lists").select("id").eq("title", LIST_TITLE).limit(1));
  if (found[0]) return found[0].id;
  const created = rows(
    await db()
      .from("url_lists")
      .insert({ title: LIST_TITLE, description: "Links people sent to the Telegram bot", color: "cyan" })
      .select("id")
  );
  return created[0].id;
}

/**
 * Queues one link for a bot user. Returns the job row, or throws with a
 * message that is safe to show the person who sent the link.
 */
export async function createUrlJob({ telegramUserId, chatId, url, audioOnly = false }) {
  const listId = await botListId();
  const item = rows(
    await db()
      .from("url_list_items")
      .insert({
        url_list_id: listId,
        url,
        download_mode: "auto",
        quality_pref: audioOnly ? "audio_only" : "best",
      })
      .select("id")
  )[0];

  const job = rows(
    await db()
      .from("bot_jobs")
      .insert({
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        url_list_item_id: item.id,
        source_url: url,
      })
      .select("*")
  )[0];

  await urlfetch.queueItems([item.id]);
  return job;
}

/** This user's most recent downloads, newest first. */
export async function recentJobs(telegramUserId, limit = 10) {
  const jobs = rows(
    await db()
      .from("bot_jobs")
      .select("*, item:url_list_items(status, file_size, r2_url, error)")
      .eq("telegram_user_id", telegramUserId)
      .order("created_at", { ascending: false })
      .limit(limit)
  );
  return jobs;
}

function fileNameOf(job) {
  const url = job.item?.r2_url || job.source_url;
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || "video");
  } catch {
    return "video";
  }
}

/** `name` without its extension, for Telegram's audio player title. */
function titleOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Sends back every finished download nobody has been told about yet. Called
 * once per worker pass rather than awaited inside the webhook, since a long
 * video can take minutes and Telegram wants its 200 immediately.
 */
export async function notifyFinishedJobs() {
  if (!config.telegramLoginBotToken) return 0;

  const pending = rows(
    await db()
      .from("bot_jobs")
      .select("*, item:url_list_items(status, file_size, r2_url, error, quality_pref)")
      .eq("notified", false)
      .order("created_at", { ascending: true })
      .limit(20)
  );

  let sent = 0;
  for (const job of pending) {
    const item = job.item;
    // The item was deleted out from under the job (the list was cleared, say):
    // nothing to report, and nothing to keep re-checking either.
    if (!item) {
      await markNotified(job.id);
      continue;
    }
    if (item.status !== "completed" && item.status !== "failed") continue;

    const language = await languageOf(job.telegram_user_id);
    const t = texts(language);
    const name = fileNameOf(job);

    if (item.status === "failed") {
      await call("sendMessage", {
        chat_id: job.chat_id,
        text: t.failed(String(item.error ?? "").slice(0, 200) || "unknown error"),
      });
    } else if (item.r2_url && Number(item.file_size ?? 0) <= SEND_BY_URL_LIMIT_BYTES) {
      // Small enough for Telegram to fetch the file itself, so it arrives as a
      // playable video or song rather than a link the person has to open.
      // An "…audio" request saved an .m4a, not a video container -- sendVideo
      // on that either gets refused outright or arrives as a silent black
      // clip, so it goes through sendAudio instead, with the title Telegram's
      // own player shows set from the file's real name.
      const isAudio = item.quality_pref === "audio_only";
      const result = await call(isAudio ? "sendAudio" : "sendVideo", {
        chat_id: job.chat_id,
        ...(isAudio ? { audio: item.r2_url, title: titleOf(name) } : { video: item.r2_url }),
        caption: t.doneNoLink(name),
      });
      if (!result?.ok) {
        await call("sendMessage", { chat_id: job.chat_id, text: t.doneWithLink(name, item.r2_url) });
      }
    } else if (item.r2_url) {
      const mb = Math.round(Number(item.file_size ?? 0) / (1024 * 1024));
      await call("sendMessage", {
        chat_id: job.chat_id,
        text: `${t.tooBig(mb)}\n\n${t.doneWithLink(name, item.r2_url)}`,
      });
    } else {
      await call("sendMessage", { chat_id: job.chat_id, text: t.doneNoLink(name) });
    }

    await markNotified(job.id);
    sent += 1;
  }
  return sent;
}

async function markNotified(jobId) {
  await db().from("bot_jobs").update({ notified: true }).eq("id", jobId);
}

async function languageOf(telegramUserId) {
  const found = rows(
    await db().from("bot_users").select("language").eq("telegram_user_id", telegramUserId).limit(1)
  );
  return found[0]?.language ?? "km";
}
