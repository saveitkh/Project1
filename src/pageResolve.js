/**
 * Resolves a normal webpage URL (a drama-site "watch" page, say) to the raw
 * media URL actually playing on it -- the same link a person would otherwise
 * have to find by hand in the browser's DevTools Network tab, filtering for
 * ".m3u8" while the page plays. yt-dlp already has to do this extraction
 * step internally before it can download anything; this just runs that step
 * alone, with --skip-download, and hands the resolved URL back instead of
 * fetching it.
 */
import { spawn } from "node:child_process";

import { config } from "./config.js";

/** Runs `yt-dlp --dump-json` and returns the parsed info dict, without downloading anything. */
function dumpInfo(pageUrl, referer) {
  return new Promise((resolve, reject) => {
    // --impersonate: see ytdlp.js's runOnce for why -- the same
    // Cloudflare-style bot check that 403s a real download's segments can
    // just as well 403 the page fetch this resolve step depends on.
    const args = ["--dump-json", "--no-warnings", "--no-playlist", "--no-check-certificate", "--impersonate", "chrome"];
    if (referer) {
      args.push("--referer", referer);
      args.push("--add-header", `User-Agent: ${config.m3u8UserAgent}`);
    }
    args.push(pageUrl);

    const child = spawn("yt-dlp", args);
    let out = "";
    let lastErrLine = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => {
      const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
      if (lines.length) lastErrLine = lines[lines.length - 1].slice(0, 400);
    });
    child.on("error", (err) => reject(new Error(`Could not start yt-dlp: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(lastErrLine || `yt-dlp exited with code ${code}.`));
        return;
      }
      try {
        // One JSON object per line for a playlist; --no-playlist means exactly one.
        resolve(JSON.parse(out.trim().split(/\r?\n/).pop()));
      } catch {
        reject(new Error("yt-dlp answered, but its output could not be read."));
      }
    });
  });
}

/**
 * Picks the best HLS/DASH variant when yt-dlp reports several qualities
 * instead of one top-level URL -- the highest resolution (or last-listed,
 * absent height info) is what a person filtering DevTools by hand would
 * normally settle on too.
 */
function pickBestFormat(formats) {
  const withUrl = (formats || []).filter((f) => f.url);
  if (withUrl.length === 0) return null;
  return withUrl.reduce((best, f) => ((f.height || 0) >= (best.height || 0) ? f : best), withUrl[0]);
}

/**
 * Resolves a webpage URL to its underlying media URL, title, and the
 * Referer it needs -- everything urlfetch.js's saveItem() needs to store a
 * .m3u8 (or direct file) URL without ever fetching the video itself here.
 */
export async function resolvePageUrl(pageUrl, referer) {
  const info = await dumpInfo(pageUrl, referer || pageUrl);
  const best = pickBestFormat(info.formats);
  const resolvedUrl = info.url || best?.url || null;
  if (!resolvedUrl) {
    throw new Error("yt-dlp could not find a downloadable video on that page.");
  }
  return {
    title: info.title || null,
    url: resolvedUrl,
    referer: referer || pageUrl,
  };
}
