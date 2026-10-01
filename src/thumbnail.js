/**
 * Fetches a still preview image for an episode straight from Telegram's own
 * message thumbnail -- without downloading the video itself -- so a video
 * can be previewed before deciding to download it. Telegram already sends a
 * small poster-frame image (document.thumbs) alongside every video message;
 * this asks for the smallest one on purpose, since it's only ever shown at
 * thumbnail size in the grid and a bigger one would just cost more bandwidth
 * for no visible gain.
 *
 * Result is cached: once fetched, the image is uploaded to R2 and the
 * episode row is updated with its URL, so a re-open of the same group never
 * re-fetches from Telegram.
 */
import { db, rows } from "./db.js";
import * as r2 from "./r2.js";
import { withFloodRetry } from "./floodRetry.js";
import { getClient, normalizeChatId } from "./telegram.js";

/**
 * Returns the episode's thumbnail URL, fetching and caching it from Telegram
 * on first use. Throws if the episode, its message, or a thumbnail isn't
 * available (e.g. the source message was deleted, or it's an audio file
 * with no poster frame).
 */
export async function getEpisodeThumbnail(episodeId) {
  const [episode] = rows(
    await db().from("episodes").select("*").eq("id", episodeId).limit(1)
  );
  if (!episode) throw new Error("No episode with that id.");
  if (episode.thumbnail_url) return episode.thumbnail_url;
  if (!episode.message_id) throw new Error("This episode has no source message to preview.");

  const [group] = rows(
    await db().from("groups").select("chat_id, account_id").eq("id", episode.group_id).limit(1)
  );
  if (!group) throw new Error("This episode's group no longer exists.");

  const client = await getClient({ accountId: group.account_id });
  const entity = await client.getEntity(normalizeChatId(group.chat_id));
  const message = await withFloodRetry(
    () => client.getMessages(entity, { ids: Number(episode.message_id) }),
    { label: `getMessages for thumbnail of episode ${episodeId}` }
  );
  const found = Array.isArray(message) ? message[0] : message;
  const thumbs = found?.media?.document?.thumbs;
  if (!thumbs || thumbs.length === 0) {
    throw new Error("The source message has no preview image.");
  }

  // thumb: 0 -- the smallest available size, never the full document
  // (downloadMedia only fetches the whole file when `thumb` is left
  // undefined, so this must be a real index, not omitted).
  const buffer = await withFloodRetry(
    () => client.downloadMedia(found, { thumb: 0 }),
    { label: `downloadMedia thumbnail for episode ${episodeId}` }
  );
  if (!buffer || buffer.length === 0) {
    throw new Error("Telegram returned an empty thumbnail.");
  }

  const key = `thumbs/${episodeId}.jpg`;
  const url = await r2.uploadBody(buffer, key, "image/jpeg");
  await db().from("episodes").update({ thumbnail_url: url }).eq("id", episodeId);
  return url;
}
