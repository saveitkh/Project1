/**
 * Saves the URLs of a URL list into R2.
 *
 * Each item is fetched over HTTP and streamed straight into the bucket -- the
 * body never lands on disk and is never held in memory, so a list of feature
 * length videos costs the service nothing but bandwidth.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { Readable } from "node:stream";

import fs from "node:fs/promises";

import { config } from "./config.js";
import { db, nowIso, rows } from "./db.js";
import { recordManualUpload } from "./library.js";
import { resolvePageUrl } from "./pageResolve.js";
import * as r2 from "./r2.js";
import { downloadWithYtdlp, isDirectFileUrl } from "./ytdlp.js";

const running = new Set();
// A signed CDN link (the kind pageResolve.js hands back for an HLS/DASH
// source) answers with one of these once its token expires. A stale link
// that sat in the queue is retried once by re-resolving the page fresh --
// the same resolution a never-pre-resolved link already gets at download
// time -- rather than being marked failed over a token that was valid when
// the item was added.
const EXPIRED_LINK_STATUSES = new Set([401, 403, 404, 410]);
const MAX_REDIRECTS = 5;

/** Marks every item of a list that is not already in R2 as queued. */
export async function queueList(listId) {
  const items = rows(
    await db()
      .from("url_list_items")
      .select("id,status,r2_key")
      .eq("url_list_id", listId)
  );
  const ids = items.filter((it) => !it.r2_key && it.status !== "downloading").map((it) => it.id);
  return queueItems(ids);
}

/** Marks specific items as queued, skipping the ones already in flight. */
export async function queueItems(ids) {
  const wanted = (ids ?? []).filter(Boolean).filter((id) => !running.has(id));
  if (wanted.length === 0) return 0;
  rows(
    await db()
      .from("url_list_items")
      .update({ status: "queued", error: null, updated_at: nowIso() })
      .in("id", wanted)
      .select("id")
  );
  return wanted.length;
}

/**
 * Starts as many queued fetches as the concurrency limit allows. Safe to call
 * on every worker tick: items already running are never picked up twice.
 */
export async function processQueue() {
  const limit = config.maxConcurrentUrlFetches;
  const freeSlots = Math.max(limit - running.size, 0);
  if (freeSlots === 0) return 0;

  const queued = rows(
    await db()
      .from("url_list_items")
      .select("*")
      .eq("status", "queued")
      .order("episode_number", { ascending: true, nullsFirst: false })
      .limit(freeSlots + running.size)
  ).filter((item) => !running.has(item.id));

  let started = 0;
  for (const item of queued.slice(0, freeSlots)) {
    void saveItem(item.id);
    started += 1;
  }
  return started;
}

/** Fetches one item's URL and streams it into R2, recording the result. */
export async function saveItem(itemId) {
  if (running.has(itemId)) return;
  running.add(itemId);

  try {
    const found = rows(await db().from("url_list_items").select("*").eq("id", itemId).limit(1));
    if (found.length === 0) return;
    const item = found[0];

    const [list] = rows(
      await db().from("url_lists").select("title").eq("id", item.url_list_id).limit(1)
    );
    // The list's own title doubles as the show name, so every URL saved from
    // it lands next to the others under one readable folder instead of all
    // piling into a single flat "urls/" bucket with no way to tell them apart.
    const showTitle = (list?.title || "").trim() || config.urlFetchFolder;

    await patch(itemId, { status: "downloading", error: null, progress: null });

    let fileName;
    let key;
    let publicUrl;
    let size;

    const mode = item.download_mode || "auto";
    const quality = item.quality_pref || "best";
    const useYtdlp = mode === "ytdlp" || (mode === "auto" && !isDirectFileUrl(item.url));

    if (useYtdlp) {
      // Anything that isn't a link to a plain media file already -- an HLS
      // playlist, a DASH manifest, or a webpage with a player embedded in it
      // -- goes through yt-dlp instead of a plain fetch, which would only
      // ever save the HTML/manifest text, not a video. yt-dlp stitches
      // fragments locally first, so there is no single response stream to
      // pipe straight into R2 the way a direct file has.
      const isAudioOnly = quality === "audio_only";
      const hint = item.label ? (isAudioOnly ? `${item.label}.m4a` : `${item.label}.mp4`) : (isAudioOnly ? "audio.m4a" : "video.mp4");
      // Throttled so a fast-moving download doesn't turn into a write per
      // percentage point -- the frontend already polls every few seconds
      // while anything is downloading, so anything faster than that is
      // wasted writes.
      let lastReportedProgress = -1;
      let lastProgressWriteAt = 0;
      const onProgress = (pct) => {
        const now = Date.now();
        if (pct === lastReportedProgress || now - lastProgressWriteAt < 2000) return;
        lastReportedProgress = pct;
        lastProgressWriteAt = now;
        patch(itemId, { progress: pct }).catch(() => {});
      };
      const downloaded = await downloadWithYtdlp(item.url, item.referer || "", hint, onProgress, quality);
      try {
        // An item with its own label (an episode from a show, say) keeps it
        // -- that label is why the item was added. Otherwise, a bot link or
        // a Quick Add with nothing typed in, use the source's own title
        // (the song or video's real name) when yt-dlp read one, rather than
        // the generic "audio"/"video" everything used to share.
        const ext = isAudioOnly ? "m4a" : "mp4";
        const titledName = downloaded.title ? sanitizeTitleForFileName(downloaded.title) : "";
        fileName = item.label ? hint : titledName ? `${titledName}.${ext}` : hint;
        key = buildListItemKey(showTitle, item, fileName);
        const stat = await fs.stat(downloaded.path);
        const contentType = isAudioOnly ? "audio/mp4" : "video/mp4";
        const uploadedUrl = await r2.upload(downloaded.path, key, contentType);
        publicUrl = uploadedUrl === key ? null : uploadedUrl;
        size = stat.size;
      } finally {
        await fs.rm(downloaded.path, { force: true }).catch(() => {});
      }
    } else {
      // mode === "direct" or mode === "auto" with a direct file URL.
      // A .ts URL that is a single segment (not an HLS playlist) still works
      // here as a plain fetch, but the content-type is video/mp2t, not mp4.
      let response = await fetchFollowingRedirects(item.url);

      if (!response.ok && EXPIRED_LINK_STATUSES.has(response.status) && item.referer) {
        // pageResolve.js sets `referer` to the source page's own URL when
        // resolving one (see resolvePageUrl's fallback), so a link added via
        // Quick Add or Auto Import's "Auto-detect video link" can be
        // re-resolved from the same page it originally came from -- one
        // retry, since a page that has moved on for real should fail the
        // same way twice.
        void response.body?.cancel();
        try {
          const fresh = await resolvePageUrl(item.referer, item.referer);
          if (fresh.url && fresh.url !== item.url) {
            await patch(itemId, { url: fresh.url, referer: fresh.referer });
            item.url = fresh.url;
            item.referer = fresh.referer;
            response = await fetchFollowingRedirects(item.url);
          }
        } catch (err) {
          console.error(`Re-resolving expired link for item ${itemId} failed:`, err?.message ?? err);
          // Falls through to the original response below -- still reported as the real error.
        }
      }

      if (!response.ok || !response.body) {
        throw new Error(`The server answered ${response.status} ${response.statusText}.`);
      }

      fileName = fileNameFor(item, response);
      key = buildListItemKey(showTitle, item, fileName);
      const contentType = response.headers.get("content-type") || guessContentTypeFromExt(fileName);
      const uploadedUrl = await r2.uploadBody(
        Readable.fromWeb(response.body),
        key,
        contentType
      );
      const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      publicUrl = uploadedUrl === key ? null : uploadedUrl;
      size = Number.isFinite(contentLength) ? contentLength : null;
    }

    await patch(itemId, {
      status: "completed",
      r2_key: key,
      r2_url: publicUrl,
      file_size: Number.isFinite(size) ? size : null,
      error: null,
      progress: null,
    });

    await recordManualUpload({
      show: showTitle,
      season: "",
      episodeNumber: item.episode_number ?? null,
      label: item.label || "",
      key,
      url: publicUrl,
      size: Number.isFinite(size) ? size : 0,
      fileName,
    }).catch((err) => console.error("Filing URL-list item as an episode failed:", err?.message ?? err));
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 500);
    console.error(`Saving URL item ${itemId} to R2 failed:`, message);
    await patch(itemId, { status: "failed", error: message, progress: null }).catch(() => {});
  } finally {
    running.delete(itemId);
  }
}

async function patch(id, values) {
  rows(
    await db()
      .from("url_list_items")
      .update({ ...values, updated_at: nowIso() })
      .eq("id", id)
      .select("id")
  );
}

/**
 * fetch() follows redirects on its own, but then only the first hop is ever
 * checked against the rules below -- a redirect to 169.254.169.254 would sail
 * straight through. Following them by hand keeps every hop checked.
 */
async function fetchFollowingRedirects(startUrl) {
  let target = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(target);
    const response = await fetch(target, { redirect: "manual" });
    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    void response.body?.cancel();
    target = new URL(location, target).toString();
  }
  throw new Error("Too many redirects.");
}

/**
 * Refuses anything that is not a public HTTP address. The service holds the
 * Supabase service-role key and the R2 secret, and its own network is where a
 * cloud metadata endpoint lives -- a URL pasted into a list must not be able to
 * make it fetch either.
 */
export async function assertPublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs can be saved.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0) throw new Error(`Could not resolve ${url.hostname}.`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`${url.hostname} resolves to a private address (${address}).`);
    }
  }
}

/** True for loopback, link-local, private and other non-routable addresses. */
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // ::ffff:10.0.0.1 and friends are IPv4 wearing an IPv6 hat.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateAddress(mapped[1]) : false;
}

/**
 * A readable, deterministic key for a saved URL-list item: the show
 * (the list's own title) plus an episode number or a slugged label -- so the
 * key and the public URL say on their own which show and which episode it
 * is, and re-saving the same item overwrites it instead of piling up copies.
 *
 * An item with neither (every link sent to the bot, say) gets its own id
 * appended: without it they all shared one key -- "bot-downloads/video.mp4"
 * -- so each download overwrote the last, and Telegram, which caches a
 * sendVideo URL, kept handing everyone the first video it ever fetched.
 */
function buildListItemKey(showTitle, item, fileName) {
  const dir = r2.slugPath(showTitle) || "urls";
  const dot = fileName.lastIndexOf(".");
  const ext = (dot > 0 ? fileName.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4";
  const hasEp = item.episode_number !== null && item.episode_number !== undefined;
  let namePart;
  if (hasEp) {
    namePart = `EP${String(item.episode_number).padStart(3, "0")}`;
  } else if (item.label && r2.slugPath(item.label)) {
    namePart = r2.slugPath(item.label);
  } else {
    const base = r2.slugPath(dot > 0 ? fileName.slice(0, dot) : fileName) || "video";
    namePart = `${base}-${String(item.id).replace(/-/g, "").slice(0, 12)}`;
  }
  return `${dir}/${namePart}.${ext}`;
}

/** A readable file name for an item: its label, its episode number, or the URL. */
/**
 * A song or video's own title, safe to use as a file name: strips characters
 * illegal in a Windows/macOS/Linux file name and collapses whitespace, but
 * keeps everything else -- Khmer script, punctuation, mixed case -- so the
 * file that lands on someone's phone is still recognizably the title yt-dlp
 * read off the source, not a slug.
 */
function sanitizeTitleForFileName(title) {
  return title
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function fileNameFor(item, response) {
  const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(
    response.headers.get("content-disposition") || ""
  );
  const candidates = [
    item.label,
    item.episode_number !== null && item.episode_number !== undefined
      ? `EP${String(item.episode_number).padStart(3, "0")}`
      : "",
    fromHeader ? decodeURIComponent(fromHeader[1]) : "",
    decodeURIComponent(new URL(item.url).pathname.split("/").filter(Boolean).pop() || ""),
  ].filter(Boolean);

  const name = candidates[0] || "video";
  const extension =
    extensionOf(fromHeader ? decodeURIComponent(fromHeader[1]) : "") ||
    extensionOf(new URL(item.url).pathname) ||
    extensionFromType(response.headers.get("content-type")) ||
    "mp4";
  return extensionOf(name) ? name : `${name}.${extension}`;
}

const extensionOf = (name) => {
  const match = /\.([a-z0-9]{2,5})$/i.exec(name || "");
  return match ? match[1].toLowerCase() : "";
};

const extensionFromType = (contentType) => {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  return {
    "video/mp4": "mp4",
    "video/x-matroska": "mkv",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/mp2t": "ts",
    "video/mpeg": "ts",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/aac": "aac",
  }[type] || "";
};

/** Guesses a content-type from a filename extension for the direct-fetch path. */
function guessContentTypeFromExt(fileName) {
  const ext = extensionOf(fileName);
  const map = {
    mp4: "video/mp4",
    mkv: "video/x-matroska",
    webm: "video/webm",
    mov: "video/quicktime",
    ts: "video/mp2t",
    m4v: "video/mp4",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    aac: "audio/aac",
  };
  return map[ext] || "video/mp4";
}
