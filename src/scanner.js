/** Scans a Telegram group for its topics and video messages. */
import { Api } from "teleproto";

import { db, fetchAll, nowIso, rows } from "./db.js";
import { getClient, listTopics, normalizeChatId } from "./telegram.js";

// "EP 12", "EP12", "ep-012", "[EP 12]", "ភាគទី 12" and friends.
//
// No bare-number fallback on purpose: Khmer titles here look like
// "<show> វគ្គ 5 ភាគទី 186" (season 5, episode 186), and a catch-all
// "first number anywhere" pattern grabbed the season number -- tagging
// hundreds of different episodes as the same EP005. An episode with no
// recognizable marker now gets no number (null) rather than a wrong one.
const EP_PATTERNS = [
  // "S05E03" / "S5_EP03" -- a filename's season+episode pair.
  /S\d{1,2}[\s._-]*EP?[\s._-]*0*(\d{1,4})(?!\d)/i,
  /\bEP[\s._-]*0*(\d{1,4})\b/i,
  /\bEpisode[\s._-]*0*(\d{1,4})\b/i,
  /\bE[\s._-]*0*(\d{1,4})\b/i,
  // "ភាគទី 12" -- ទី ("number") usually sits between ភាគ and the digits.
  /ភាគ(?:ទី)?[\s._-]*0*(\d{1,4})/,
];

// Khmer captions usually write the number in Khmer digits ("ភាគទី១៩៤"),
// which \d doesn't match -- those episodes all came out unnumbered.
const toAsciiDigits = (text) => String(text).replace(/[០-៩]/g, (d) => String(d.charCodeAt(0) - 0x17e0));

/** Pulls an episode number out of a caption or filename, best effort. */
export function parseEpNumber(...sources) {
  for (const raw of sources) {
    if (!raw) continue;
    const text = toAsciiDigits(raw);
    for (const pattern of EP_PATTERNS) {
      const match = pattern.exec(text);
      if (match) {
        const parsed = Number.parseInt(match[1], 10);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
}

/**
 * Returns file details when the message carries a video or an audio file
 * (a "song" -- music, a voice note, anything Telegram tags as audio), else
 * null. Everything else (photos, plain documents, stickers) is skipped.
 */
export function mediaInfo(message) {
  const document = message.media?.document;
  if (!document) return null;

  const mime = document.mimeType ?? "";
  const attributes = document.attributes ?? [];
  const videoAttr = attributes.find((a) => a instanceof Api.DocumentAttributeVideo);
  const audioAttr = attributes.find((a) => a instanceof Api.DocumentAttributeAudio);

  let mediaType;
  if (mime.startsWith("video/") || videoAttr) mediaType = "video";
  else if (mime.startsWith("audio/") || audioAttr) mediaType = "audio";
  else return null;

  const nameAttr = attributes.find((a) => a instanceof Api.DocumentAttributeFilename);
  const fallbackExt = mediaType === "audio" ? "mp3" : "mp4";
  return {
    fileName: nameAttr?.fileName || `${message.id}.${fallbackExt}`,
    fileSize: Number(document.size ?? 0),
    duration: Math.round(Number(videoAttr?.duration ?? audioAttr?.duration ?? 0)),
    mimeType: mime || (mediaType === "audio" ? "audio/mpeg" : "video/mp4"),
    mediaType,
  };
}

/** The forum topic a message belongs to, or null outside a forum. */
function topicIdOf(message) {
  const replyTo = message.replyTo;
  if (!replyTo || !replyTo.forumTopic) return null;
  return replyTo.replyToTopId ?? replyTo.replyToMsgId ?? null;
}

/**
 * Syncs one group's topics and videos into Supabase. Safe to re-run.
 * messageLimit 0 (the default) means no limit at all -- iterMessages then
 * walks the group's entire history, so nothing older than an arbitrary
 * cutoff is silently left unscanned. A caller can still pass a smaller
 * number for a quick, recent-only pass.
 */
// A full-history scan can run for minutes; a second click on Scan (or the
// auto-rescan tick) starting another pass of the same group meanwhile is
// what inserted the same message many times over. One scan per group at a
// time -- a repeat request just waits for and shares the running one.
const scansInFlight = new Map();

export function scanGroup(groupId, messageLimit = 0) {
  const running = scansInFlight.get(groupId);
  if (running) return running;
  const scan = runScan(groupId, messageLimit).finally(() => scansInFlight.delete(groupId));
  scansInFlight.set(groupId, scan);
  return scan;
}

async function runScan(groupId, messageLimit) {
  const groups = rows(await db().from("groups").select("*").eq("id", groupId).limit(1));
  if (groups.length === 0) throw new Error(`No group with id ${groupId}.`);
  const group = groups[0];

  const client = await getClient({ accountId: group.account_id });
  const entity = await client.getEntity(normalizeChatId(group.chat_id));
  const isForum = Boolean(entity.forum);

  // 1. Topics — keyed by their Telegram id so re-scans update instead of duplicate.
  const existingTopics = await fetchAll(() =>
    db().from("topics").select("*").eq("group_id", groupId).order("id")
  );
  const topicRows = new Map(
    existingTopics.filter((t) => t.topic_id).map((t) => [String(t.topic_id), t])
  );

  if (isForum) {
    for (const topic of await listTopics(client, entity)) {
      const known = topicRows.get(topic.topic_id);
      if (known) {
        if (known.title !== topic.title) {
          await db().from("topics").update({ title: topic.title }).eq("id", known.id);
          known.title = topic.title;
        }
      } else {
        const inserted = rows(
          await db()
            .from("topics")
            .insert({ group_id: groupId, topic_id: topic.topic_id, title: topic.title })
            .select()
        );
        if (inserted[0]) topicRows.set(topic.topic_id, inserted[0]);
      }
    }
  }

  // 2. Videos — one pass over the history, bucketed into topics as we go.
  const existingEpisodes = await fetchAll(() =>
    db().from("episodes").select("id, message_id").eq("group_id", groupId).order("id")
  );
  const knownMessageIds = new Set(
    existingEpisodes.filter((e) => e.message_id).map((e) => String(e.message_id))
  );

  const newEpisodes = [];
  let seen = 0;

  for await (const message of client.iterMessages(entity, { limit: messageLimit || undefined })) {
    seen += 1;
    const info = mediaInfo(message);
    if (!info) continue;
    if (knownMessageIds.has(String(message.id))) continue;

    const topicKey = topicIdOf(message);
    const topicRow = topicKey ? topicRows.get(String(topicKey)) : null;
    const caption = message.message || "";

    newEpisodes.push({
      group_id: groupId,
      topic_id: topicRow ? topicRow.id : null,
      message_id: String(message.id),
      ep_number: parseEpNumber(caption, info.fileName),
      title: caption.split("\n")[0].slice(0, 200) || null,
      file_name: info.fileName,
      file_size: info.fileSize,
      duration: info.duration,
      media_type: info.mediaType,
      mime_type: info.mimeType,
      status: "pending",
    });
    knownMessageIds.add(String(message.id));
  }

  for (let i = 0; i < newEpisodes.length; i += 200) {
    const chunk = newEpisodes.slice(i, i + 200);
    // Backstop for the lock above (e.g. two backend instances): the
    // (group_id, message_id) unique index rejects a repeat, and
    // ignoreDuplicates turns that into a skip instead of a failed scan.
    const result = await db()
      .from("episodes")
      .upsert(chunk, { onConflict: "group_id,message_id", ignoreDuplicates: true });
    if (result.error) throw new Error(result.error.message);
  }

  // 3. Counters the UI reads off the group and topic rows.
  const allEpisodes = await fetchAll(() =>
    db().from("episodes").select("id, topic_id, status").eq("group_id", groupId).order("id")
  );
  await db()
    .from("groups")
    .update({
      is_forum: isForum,
      title: entity.title || group.title,
      username: entity.username ?? null,
      total_episodes: allEpisodes.length,
      downloaded_episodes: allEpisodes.filter((e) => e.status === "completed").length,
      last_scanned_at: nowIso(),
    })
    .eq("id", groupId);

  for (const topic of topicRows.values()) {
    const inTopic = allEpisodes.filter((e) => e.topic_id === topic.id);
    await db()
      .from("topics")
      .update({
        total_episodes: inTopic.length,
        downloaded_episodes: inTopic.filter((e) => e.status === "completed").length,
      })
      .eq("id", topic.id);
  }

  return {
    success: true,
    messages_scanned: seen,
    topics: topicRows.size,
    new_episodes: newEpisodes.length,
    total_episodes: allEpisodes.length,
  };
}
