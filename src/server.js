/**
 * HTTP API the TG Downloader frontend talks to.
 *
 * Every route is a POST guarded by the x-api-key header, matching how the
 * frontend's callBackend() helper sends requests.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";

import QRCode from "qrcode";

import { config } from "./config.js";
import { db, nowIso, rows, upsertSingle } from "./db.js";
import { parseKhqr } from "./khqr.js";
import { applyAutoRules, retryFailed, runDownload } from "./downloader.js";
import * as forwarder from "./forwarder.js";
import * as khInvoice from "./khInvoice.js";
import * as watch from "./watch.js";
import * as aiCredits from "./aiCredits.js";
import { BOT_COMMANDS } from "./botText.js";
import { handleCallback as handleBotCallback, handleMessage as handleLinkBotMessage } from "./linkBot.js";
import * as translate from "./translate.js";
import { recordManualUpload } from "./library.js";
import * as mirror from "./mirror.js";
import * as pageResolve from "./pageResolve.js";
import * as takeout from "./takeout.js";
import * as r2 from "./r2.js";
import * as s3migrate from "./s3migrate.js";
import * as s3source from "./s3source.js";
import * as urlfetch from "./urlfetch.js";
import { scanGroup } from "./scanner.js";
import { getEpisodeThumbnail } from "./thumbnail.js";
import * as subscription from "./subscription.js";
import * as telegram from "./telegram.js";
import * as telegramStorage from "./telegramStorage.js";
import { signInWithTelegram, signInWithTelegramMiniApp } from "./telegramLogin.js";
import { answerCallbackQuery, call as botApi, stampDecision } from "./notifyBot.js";
import { loop } from "./worker.js";

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  })
);

/**
 * The KH Invoice web app (webapps/kh-invoice, built with base /invoice/),
 * served here so the bot's Mini App buttons have an https page on the same
 * deployment. Hashed assets are cached for good; index.html never is, so a
 * new build shows up on the next open.
 */
const KH_INVOICE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "webapps", "kh-invoice");
app.use(
  "/invoice",
  express.static(KH_INVOICE_DIR, {
    index: false,
    setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      else res.setHeader("Cache-Control", "no-cache");
    },
  })
);
app.get(/^\/invoice\/(?!assets\/).*/, (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(KH_INVOICE_DIR, "index.html"));
});

/** Express 4 does not forward async rejections, so every handler is wrapped. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

/**
 * Rejects anything that does not carry the shared secret. Accepts the key as
 * a query param too -- not just the x-api-key header -- because the one
 * route that needs a plain browser navigation (/api/r2/download, so the
 * browser's own save dialog triggers) can't attach headers to an <a> click.
 * The key is already shipped to the browser today (VITE_TELEGRAM_BACKEND_KEY
 * ships in the frontend bundle for every other call's x-api-key), so this
 * doesn't expose anything that wasn't already public.
 */
function requireApiKey(req, res, next) {
  if (!config.apiKey) {
    return res
      .status(500)
      .json({ success: false, error: "BACKEND_API_KEY is not configured on the server." });
  }
  const provided = req.get("x-api-key") || req.query.api_key;
  if (provided !== config.apiKey) {
    return res.status(401).json({ success: false, error: "Invalid API key." });
  }
  return next();
}

/** Fire-and-forget a background job, logging instead of swallowing crashes. */
function spawn(promise, label) {
  promise.catch((err) => console.error(`${label} failed:`, err?.message ?? err));
}

/**
 * Identifies the caller from their own Supabase session (the subscription
 * routes need to know *which* subscriber is asking, unlike every other
 * route here which is gated by the one shared BACKEND_API_KEY). Validating
 * the JWT this way -- rather than trusting a user id the client sends --
 * is why a viewer can't submit a payment claim as someone else.
 */
async function requireUser(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ success: false, error: "Not signed in." });
  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ success: false, error: "Invalid or expired session." });
  req.userId = data.user.id;
  req.userEmail = data.user.email ?? null;
  return next();
}

/** requireUser, plus the caller must be flagged as the operator in profiles.is_admin. */
async function requireAdmin(req, res, next) {
  return requireUser(req, res, async () => {
    const { data } = await db().from("profiles").select("is_admin").eq("id", req.userId).maybeSingle();
    if (!data?.is_admin) return res.status(403).json({ success: false, error: "Admin access required." });
    return next();
  });
}

// ---------------------------------------------------------------- health

app.get(
  "/health",
  route(async (_req, res) => {
    // The one route without an API key, safe to poll from the UI.
    res.json({
      success: true,
      // Never isAuthorized() here: that opens a Telegram connection, and
      // Railway polls this on the NEW container during a deploy while the old
      // one is still connected -- two connections on one session is what got
      // the userbot signed out on deploy after deploy. This reports what the
      // worker last saw instead, and does not touch Telegram at all.
      telegram: telegram.knownAuthorized() ?? false,
      r2: await r2.ping(),
      takeout: takeout.isTakeoutActive(),
    });
  })
);

// -------------------------------------------------------- sign-in widget

// No requireApiKey here on purpose: this is how a visitor gets their first
// session, before they have anything to authenticate with. It's safe left
// open because signInWithTelegram() rejects anything not cryptographically
// signed by our own Telegram Login Widget bot.
app.post(
  "/api/auth/telegram-login",
  route(async (req, res) => {
    res.json({ success: true, ...(await signInWithTelegram(req.body ?? {})) });
  })
);

// Same reasoning as above: open on purpose, since signInWithTelegramMiniApp()
// rejects anything not signed by Telegram itself for our bot. This is what
// the app calls when it's opened as a Telegram Mini App (inside a WebView),
// instead of the Login Widget button on the plain web page.
app.post(
  "/api/auth/telegram-miniapp",
  route(async (req, res) => {
    const initData = String(req.body?.init_data ?? "");
    res.json({ success: true, ...(await signInWithTelegramMiniApp(initData)) });
  })
);

// ---------------------------------------------------------------- telegram login

app.post(
  "/api/telegram/send-code",
  requireApiKey,
  route(async (_req, res) => res.json(await telegram.sendCode()))
);

app.post(
  "/api/telegram/verify-code",
  requireApiKey,
  route(async (req, res) => {
    const { code = "", password = null } = req.body ?? {};
    if (!code && !password) {
      return res.status(400).json({ success: false, error: "A code or password is required." });
    }
    return res.json(await telegram.verifyCode(String(code), password || null));
  })
);

app.post(
  "/api/telegram/logout",
  requireApiKey,
  route(async (_req, res) => res.json(await telegram.logout()))
);

// -------------------------------------------------------- extra accounts

/** Extra Telegram accounts beyond the default one (Settings › Telegram). */
app.post(
  "/api/telegram/accounts/list",
  requireApiKey,
  route(async (_req, res) => {
    res.json({ success: true, accounts: await telegram.listAccounts() });
  })
);

app.post(
  "/api/telegram/accounts",
  requireApiKey,
  route(async (req, res) => {
    const { label, api_id: apiId, api_hash: apiHash, phone } = req.body ?? {};
    const account = await telegram.addAccount({ label, apiId, apiHash, phone });
    res.json({ success: true, account });
  })
);

app.post(
  "/api/telegram/accounts/:id/delete",
  requireApiKey,
  route(async (req, res) => {
    res.json(await telegram.deleteAccount(req.params.id));
  })
);

app.post(
  "/api/telegram/accounts/:id/send-code",
  requireApiKey,
  route(async (req, res) => res.json(await telegram.sendCode(req.params.id)))
);

app.post(
  "/api/telegram/accounts/:id/verify-code",
  requireApiKey,
  route(async (req, res) => {
    const { code = "", password = null } = req.body ?? {};
    if (!code && !password) {
      return res.status(400).json({ success: false, error: "A code or password is required." });
    }
    return res.json(await telegram.verifyCode(String(code), password || null, req.params.id));
  })
);

/** Signs an extra account out, clearing its session -- the account row itself stays, unlike delete. */
app.post(
  "/api/telegram/accounts/:id/logout",
  requireApiKey,
  route(async (req, res) => res.json(await telegram.logout(req.params.id)))
);

// ---------------------------------------------------------------- groups

app.post(
  "/api/telegram/groups/resolve",
  requireApiKey,
  route(async (req, res) => {
    const chatId = String(req.body?.chat_id ?? "").trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: "chat_id is required." });
    }
    const accountId = req.body?.account_id || null;
    return res.json(await telegram.describeGroup(chatId, accountId));
  })
);

app.post(
  "/api/telegram/dialogs",
  requireApiKey,
  route(async (req, res) => {
    const limit = Number(req.body?.limit) || 200;
    const accountId = req.body?.account_id || null;
    res.json({ success: true, dialogs: await telegram.listDialogs(limit, accountId) });
  })
);

app.post(
  "/api/telegram/join",
  requireApiKey,
  route(async (req, res) => {
    const invite = String(req.body?.invite ?? "").trim();
    if (!invite) {
      return res.status(400).json({ success: false, error: "invite is required." });
    }
    const accountId = req.body?.account_id || null;
    return res.json(await telegram.joinChat(invite, accountId));
  })
);

/** Finds public groups/channels by keyword the account has never joined. */
app.post(
  "/api/telegram/groups/search",
  requireApiKey,
  route(async (req, res) => {
    const query = String(req.body?.query ?? "").trim();
    if (!query) {
      return res.status(400).json({ success: false, error: "query is required." });
    }
    const limit = Math.min(Number(req.body?.limit) || 20, 50);
    const accountId = req.body?.account_id || null;
    res.json({ success: true, results: await telegram.searchPublicChats(query, limit, accountId) });
  })
);

/** Lists a group's members -- read-only, for the "who's in this group" view. */
app.post(
  "/api/telegram/groups/members",
  requireApiKey,
  route(async (req, res) => {
    const chatId = String(req.body?.chat_id ?? "").trim();
    if (!chatId) {
      return res.status(400).json({ success: false, error: "chat_id is required." });
    }
    const accountId = req.body?.account_id || null;
    const limit = req.body?.limit;
    res.json({ success: true, members: await telegram.listMembers(chatId, accountId, limit) });
  })
);

app.post(
  "/api/telegram/notify",
  requireApiKey,
  route(async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (!text) {
      return res.status(400).json({ success: false, error: "text is required." });
    }
    return res.json(await telegram.notifySelf(text));
  })
);

app.post(
  "/api/telegram/groups/:groupId/scan",
  requireApiKey,
  route(async (req, res) => {
    // 0/omitted -- scanGroup's own default -- means the full history, so a
    // scan never silently misses episodes older than some arbitrary cutoff.
    const limit = Number(req.body?.limit) || 0;
    res.json(await scanGroup(req.params.groupId, limit));
  })
);

// ---------------------------------------------------------------- downloads

app.post(
  "/api/downloads/:downloadId/start",
  requireApiKey,
  route(async (req, res) => {
    spawn(runDownload(req.params.downloadId), `download ${req.params.downloadId}`);
    res.json({ success: true, status: "started" });
  })
);

app.post(
  "/api/downloads/:downloadId/cancel",
  requireApiKey,
  route(async (req, res) => {
    await db().from("downloads").update({ status: "cancelled" }).eq("id", req.params.downloadId);
    res.json({ success: true });
  })
);

app.post(
  "/api/downloads/retry-failed",
  requireApiKey,
  route(async (_req, res) => res.json({ success: true, requeued: await retryFailed() }))
);

app.post(
  "/api/rules/run",
  requireApiKey,
  route(async (_req, res) => res.json({ success: true, ...(await applyAutoRules()) }))
);

// ---------------------------------------------------------------- forwarding

app.post(
  "/api/telegram/forward/:jobId/start",
  requireApiKey,
  route(async (req, res) => {
    // Answer immediately: a long job would otherwise time the browser out.
    spawn(forwarder.runJob(req.params.jobId), `forward job ${req.params.jobId}`);
    res.json({ success: true, status: "started" });
  })
);

app.post(
  "/api/telegram/forward/:jobId/cancel",
  requireApiKey,
  route(async (req, res) => {
    await db()
      .from("forward_jobs")
      .update({ status: "cancelled", auto_follow: false })
      .eq("id", req.params.jobId);
    res.json({ success: true });
  })
);

app.post(
  "/api/telegram/mirror/:mirrorId/prepare",
  requireApiKey,
  route(async (req, res) => {
    // Creating topics and queueing thousands of videos takes a while, so this
    // answers immediately and reports through group_mirrors.status.
    spawn(mirror.prepare(req.params.mirrorId), `mirror ${req.params.mirrorId}`);
    res.json({ success: true, status: "preparing" });
  })
);

app.post(
  "/api/telegram/mirror/:mirrorId/cancel",
  requireApiKey,
  route(async (req, res) => {
    await db()
      .from("forward_jobs")
      .update({ status: "cancelled", auto_follow: false })
      .eq("mirror_id", req.params.mirrorId)
      .in("status", ["queued", "running"]);
    await db()
      .from("group_mirrors")
      .update({ status: "cancelled", auto_follow: false })
      .eq("id", req.params.mirrorId);
    res.json({ success: true });
  })
);

app.post(
  "/api/telegram/takeout/start",
  requireApiKey,
  route(async (_req, res) => res.json(await takeout.startTakeoutSession()))
);

app.post(
  "/api/telegram/takeout/stop",
  requireApiKey,
  route(async (req, res) => res.json(await takeout.stopTakeoutSession(req.body?.success ?? true)))
);

// ---------------------------------------------------------------- r2

app.post(
  "/api/r2/test",
  requireApiKey,
  route(async (_req, res) => {
    const result = await r2.testConnection();
    await upsertSingle("r2_settings", { connected: true, last_connected_at: nowIso() });
    res.json({ success: true, ...result });
  })
);

/**
 * Uploads a video picked in the control panel straight into R2 and answers
 * with its public URL, ready to paste anywhere.
 *
 * The body is the raw file, not a form: express.json() only touches
 * application/json, so the request stream arrives here untouched and goes to
 * R2 chunk by chunk. Nothing is buffered in memory or staged on disk, which
 * is what makes a multi-gigabyte video possible on a small container.
 *
 * The panel normally sends `key` itself -- a readable path it built from the
 * show/episode fields (e.g. "naruto/season-1/EP007.mp4") -- so re-uploading
 * the same episode overwrites it instead of piling up random-suffixed
 * duplicates. `folder` + `name` is kept as the fallback for older callers.
 *
 * When the panel also sends `show`, this upload is filed as an episode too
 * (see library.js), so it shows up in Groups/Downloads next to videos
 * pulled from Telegram -- grouped by show, sorted by episode -- instead of
 * only existing as a bucket key. A failure there never fails the upload
 * itself: the file is already safely in R2 by that point.
 */
app.post(
  "/api/r2/upload",
  requireApiKey,
  route(async (req, res) => {
    const fileName = String(req.query.name ?? "").trim();
    if (!fileName) {
      return res.status(400).json({ success: false, error: "A file name is required." });
    }
    const contentType = req.get("content-type") || "application/octet-stream";
    if (contentType.startsWith("application/json")) {
      return res
        .status(400)
        .json({ success: false, error: "Send the file itself as the request body." });
    }

    const explicitKey = r2.slugPath(String(req.query.key ?? ""));
    const key = explicitKey || r2.buildUploadKey(String(req.query.folder ?? "uploads"), fileName);
    const url = await r2.uploadBody(req, key, contentType);
    const size = Number.parseInt(req.get("content-length") ?? "", 10);
    const publicUrl = url === key ? null : url;

    const show = String(req.query.show ?? "").trim();
    if (show) {
      const episodeNumber = Number.parseInt(String(req.query.episode ?? ""), 10);
      await recordManualUpload({
        show,
        season: String(req.query.season ?? ""),
        episodeNumber: Number.isFinite(episodeNumber) ? episodeNumber : null,
        label: String(req.query.label ?? ""),
        key,
        url: publicUrl,
        size: Number.isFinite(size) ? size : 0,
        fileName,
      }).catch((err) => console.error("Filing manual upload as an episode failed:", err?.message ?? err));
    }

    res.json({
      success: true,
      key,
      // Falls back to null when no public URL is configured, so the UI can
      // tell the operator the file is in R2 but not reachable yet.
      url: publicUrl,
      size: Number.isFinite(size) ? size : null,
    });
  })
);

/** Lists what is actually in the bucket, so the panel can show real URLs. */
app.post(
  "/api/r2/objects",
  requireApiKey,
  route(async (req, res) => {
    const { prefix = "", limit = 100 } = req.body ?? {};
    const result = await r2.listObjects(String(prefix), Math.min(Number(limit) || 100, 1000));
    res.json({ success: true, ...result });
  })
);

/**
 * Streams an object straight through with Content-Disposition: attachment,
 * so a plain <a href> to this URL makes the browser save it to the device --
 * the file's own name, not a viewer tab -- regardless of whether the bucket
 * has a public URL configured at all. GET, not POST: this is meant to be
 * navigated to directly, which is also why requireApiKey accepts the key as
 * a query param here (see its own comment).
 */
app.get(
  "/api/r2/download",
  requireApiKey,
  route(async (req, res) => {
    const key = String(req.query.key ?? "").trim();
    if (!key) return res.status(400).json({ success: false, error: "A key is required." });
    const filename = String(req.query.filename ?? key.split("/").pop() ?? "download").replace(/"/g, "");
    const { stream, contentType, contentLength } = await r2.getObjectStream(key);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", String(contentLength));
    stream.pipe(res);
  })
);

/**
 * A still preview of an episode's video, fetched straight from Telegram
 * (its own message thumbnail) and cached to R2 -- lets the frontend show
 * something before the video is actually downloaded.
 */
app.get(
  "/api/episodes/:id/thumbnail",
  requireApiKey,
  route(async (req, res) => {
    const url = await getEpisodeThumbnail(req.params.id);
    res.redirect(url);
  })
);

/**
 * Streams a file back for an episode archived to a Telegram storage channel
 * instead of R2 -- the userbot fetches it fresh from Telegram on every call
 * (there is no static URL for a Telegram-stored file), through a temp file
 * that is deleted the moment the response finishes.
 */
app.get(
  "/api/telegram-storage/download",
  requireApiKey,
  route(async (req, res) => {
    const chatId = String(req.query.chat_id ?? "").trim();
    const messageId = Number(req.query.message_id);
    if (!chatId || !Number.isFinite(messageId)) {
      return res.status(400).json({ success: false, error: "chat_id and message_id are required." });
    }
    const { stream, contentType, contentLength, fileName } = await telegramStorage.downloadStoredMessage(
      chatId,
      messageId
    );
    const filename = String(req.query.filename ?? fileName).replace(/"/g, "");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", String(contentLength));
    stream.pipe(res);
  })
);

/** Deletes one object, for undoing a mistaken upload. */
app.post(
  "/api/r2/delete",
  requireApiKey,
  route(async (req, res) => {
    const key = String(req.body?.key ?? "").trim();
    if (!key) return res.status(400).json({ success: false, error: "A key is required." });
    await r2.remove(key);
    res.json({ success: true });
  })
);

// ---------------------------------------------------------------- s3 import (one-time)

/**
 * Kicks off a one-time migration: every object in the source S3-compatible
 * bucket (S3_* env vars) is streamed straight into R2 and, once confirmed
 * there, deleted from the source. The body never touches disk on the way
 * through. Pass dry_run: true to just count what would move, without
 * changing anything.
 *
 * Answers immediately -- the run itself can take a long time for a big
 * bucket -- and the frontend follows progress with /api/s3import/status.
 */
app.post(
  "/api/s3import/run",
  requireApiKey,
  route(async (req, res) => {
    const prefix = String(req.body?.prefix ?? "");
    const dryRun = req.body?.dry_run === true;
    const deleteSource = req.body?.delete_source !== false;
    const concurrency = Math.min(Math.max(Number(req.body?.concurrency) || 2, 1), 8);
    spawn(s3migrate.run({ prefix, dryRun, deleteSource, concurrency }), "S3 import");
    res.json({ success: true, status: "started" });
  })
);

/** The current or most recent run's counters, for a progress bar. */
app.post(
  "/api/s3import/status",
  requireApiKey,
  route(async (_req, res) => res.json({ success: true, ...s3migrate.status() }))
);

// ---------------------------------------------------------------- s3 source (browse only)

/** Verifies the stored source-S3 credentials really can reach the bucket. */
app.post(
  "/api/s3source/test",
  requireApiKey,
  route(async (_req, res) => {
    const result = await s3source.testConnection();
    await upsertSingle("s3_source_settings", { connected: true, last_connected_at: nowIso() });
    res.json({ success: true, ...result });
  })
);

/** Lists what is actually in the source bucket, so it can be browsed before migrating. */
app.post(
  "/api/s3source/objects",
  requireApiKey,
  route(async (req, res) => {
    const { prefix = "", limit = 100 } = req.body ?? {};
    const result = await s3source.listObjects(String(prefix), Math.min(Number(limit) || 100, 1000));
    res.json({ success: true, ...result });
  })
);

// ---------------------------------------------------------------- url lists

/**
 * Saves the URLs of a list into R2: each one is fetched and streamed into the
 * bucket, and the `url_list_items` row gets the key and the public URL back.
 * The reply comes as soon as the work is queued -- the page follows the rows.
 */
app.post(
  "/api/urls/lists/:listId/save",
  requireApiKey,
  route(async (req, res) => {
    const queued = await urlfetch.queueList(req.params.listId);
    spawn(urlfetch.processQueue(), "URL queue");
    res.json({ success: true, queued });
  })
);

/** The same, for the items the operator ticked rather than a whole list. */
app.post(
  "/api/urls/items/save",
  requireApiKey,
  route(async (req, res) => {
    const ids = Array.isArray(req.body?.item_ids) ? req.body.item_ids : [];
    if (ids.length === 0) {
      return res.status(400).json({ success: false, error: "No items were given." });
    }
    const queued = await urlfetch.queueItems(ids);
    spawn(urlfetch.processQueue(), "URL queue");
    res.json({ success: true, queued });
  })
);

/** Checks one URL is fetchable before the operator commits a whole list to it. */
app.post(
  "/api/urls/check",
  requireApiKey,
  route(async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) return res.status(400).json({ success: false, error: "A URL is required." });
    await urlfetch.assertPublicUrl(url);
    res.json({ success: true });
  })
);

/**
 * Resolves an ordinary webpage URL (a "watch" page, not a direct file) to
 * the raw .m3u8/media URL actually playing on it, via yt-dlp -- the same
 * link a person would otherwise dig out of the browser's DevTools Network
 * tab by hand. Nothing is downloaded; this only extracts.
 */
app.post(
  "/api/urls/resolve",
  requireApiKey,
  route(async (req, res) => {
    const url = String(req.body?.url ?? "").trim();
    if (!url) return res.status(400).json({ success: false, error: "A URL is required." });
    await urlfetch.assertPublicUrl(url);
    const referer = String(req.body?.referer ?? "").trim();
    const result = await pageResolve.resolvePageUrl(url, referer);
    res.json({ success: true, ...result });
  })
);

// ---------------------------------------------------------------- subscriptions

/** Creates a pending payment claim for the signed-in subscriber and DMs the operator. */
app.post(
  "/api/subscription/submit",
  requireUser,
  route(async (req, res) => {
    const tierKey = String(req.body?.tier ?? "").trim();
    if (!tierKey) return res.status(400).json({ success: false, error: "A plan is required." });
    const submission = await subscription.createSubmission({ userId: req.userId, email: req.userEmail, tierKey });
    res.json({ success: true, submission });
  })
);

/** Attaches a payment screenshot to the caller's own pending claim. */
app.post(
  "/api/subscription/attach-screenshot",
  requireUser,
  route(async (req, res) => {
    const submissionId = String(req.body?.submission_id ?? "").trim();
    const screenshotUrl = String(req.body?.screenshot_url ?? "").trim();
    if (!submissionId || !screenshotUrl) {
      return res.status(400).json({ success: false, error: "submission_id and screenshot_url are required." });
    }
    const submission = await subscription.attachScreenshot({ userId: req.userId, submissionId, screenshotUrl });
    res.json({ success: true, submission });
  })
);

/** Abandons the caller's own pending claim (e.g. switching plans mid-flow). */
app.post(
  "/api/subscription/cancel",
  requireUser,
  route(async (req, res) => {
    const submissionId = String(req.body?.submission_id ?? "").trim();
    if (!submissionId) return res.status(400).json({ success: false, error: "submission_id is required." });
    await subscription.cancelSubmission({ userId: req.userId, submissionId });
    res.json({ success: true });
  })
);

/** The signed-in subscriber's own current plan/expiry. */
app.post(
  "/api/subscription/status",
  requireUser,
  route(async (req, res) => {
    res.json({ success: true, ...(await subscription.subscriptionStatus(req.userId)) });
  })
);

/**
 * A phone automation app (Tasker/MacroDroid/...) POSTs the raw text of an
 * ABA payment notification here. Guarded by a shared secret instead of a
 * user session -- there is no signed-in subscriber on the other end of
 * this call, just a phone -- and fails closed if the secret was never
 * configured, same as every other "no auth = refuse everything" default
 * in this file.
 */
app.post(
  "/api/subscription/aba-ingest",
  // Only kicks in when the body isn't JSON -- express.json() above already
  // consumed (and skipped) the stream for a JSON request, so this would
  // otherwise re-read an already-drained stream and blank out a good body.
  express.text({ type: (req) => !req.is("json") }),
  route(async (req, res) => {
    const provided = req.get("x-aba-ingest-secret") || req.query.secret;
    if (!config.abaIngestSecret || provided !== config.abaIngestSecret) {
      return res.status(401).json({ success: false, error: "Invalid or missing ingest secret." });
    }
    const text = typeof req.body === "string" ? req.body : String(req.body?.text ?? "");
    const result = await subscription.matchAbaNotification(text, config.abaMerchantName);
    res.json({ success: true, ...result });
  })
);

/**
 * The payment page a bot button opens.
 *
 * Telegram only accepts http/https in an inline button, so `abamobilebank://`
 * can never be a button URL -- this page is the bridge: it loads over https
 * and then hands the phone the deeplink. The link shape is ABA's own
 * (abamobilebank://ababank.com?type=payway&qrcode=<KHQR>), the same thing
 * PayWay's API returns as `abapay_deeplink`, so it needs no merchant account
 * of ours: the payload is this order's own KHQR.
 *
 * Public on purpose, and no requireApiKey: a payer opens it in whatever
 * browser Telegram hands them. All it reveals is a request to pay the
 * operator an exact amount -- which is what was just sent to that payer
 * anyway -- and nothing about who ordered it.
 */
app.get(
  "/pay/:orderId",
  route(async (req, res) => {
    const [order] = rows(
      await db()
        .from("bot_orders")
        .select("ticket, amount_usd, khqr, status, package:bot_packages(title_km, title_en)")
        .eq("id", req.params.orderId)
        .limit(1)
    );
    if (!order) return res.status(404).type("html").send(payShell("រកមិនឃើញ", "<p>This payment link is not valid.</p>"));

    if (order.status !== "pending") {
      const done = order.status === "paid";
      return res.type("html").send(
        payShell(
          done ? "បានទូទាត់រួច" : "ផុតកំណត់",
          `<p class="big">${done ? "✅ បានទូទាត់រួចរាល់" : "⏱ តំណនេះផុតកំណត់ហើយ"}</p>
           <p class="sub">${done ? "Payment already confirmed." : "This payment link has expired — start a new order in the bot."}</p>`
        )
      );
    }

    const deeplink = `abamobilebank://ababank.com?type=payway&qrcode=${encodeURIComponent(order.khqr)}`;
    const qr = await QRCode.toDataURL(order.khqr, { width: 620, margin: 2, errorCorrectionLevel: "M" });
    const amount = Number(order.amount_usd).toFixed(2);
    // Tag 59 is the payee name the bank itself will show -- printing the same
    // one here means the page and the banking app agree, which is the thing a
    // payer actually checks before paying.
    const merchantName = parseKhqr(order.khqr)?.find((f) => f.tag === "59")?.value ?? "";
    const name = order.package?.title_km || order.package?.title_en || "";
    // ?view=qr is the second button: show the QR to save or scan from another
    // phone, with no jump into ABA.
    const autoOpen = req.query.view !== "qr";

    res.type("html").send(
      payShell(
        `$${amount}`,
        `<p class="amount">$${amount} <span>USD</span></p>
         <p class="sub">${escapeHtml(name)} · 🎫 ${escapeHtml(order.ticket)}</p>
         <a class="btn aba" href="${escapeHtml(deeplink)}">📲 បើកកម្មវិធី ABA Mobile</a>
         <p class="hint">ចំនួនទឹកប្រាក់កំណត់ស្រាប់ក្នុង QR — មិនបាច់វាយលេខទេ</p>
         ${khqrTicket(merchantName, amount, qr)}
         <p class="hint">💾 រក្សាទុករូបនេះ រួចស្កេនដោយកម្មវិធីធនាគារណាមួយដែលមាន KHQR<br/>
            <span class="en">Save this QR and scan it with any KHQR bank app</span></p>
         <p class="hint">បន្ទាប់ពីបង់រួច ផ្ញើ screenshot ទៅ bot វិញ</p>`,
        autoOpen ? deeplink : null
      )
    );
  })
);

/**
 * The KHQR ticket, ported from the telegrambot- app's KhqrCard component:
 * red band with its clipped corner, payee name, amount, dashed rule, QR.
 * A generated payload renders as a bare square otherwise, which reads as
 * less trustworthy at the exact moment somebody is handing over money.
 */
function khqrTicket(merchantName, amount, qrDataUrl) {
  return `<div class="ticket">
  <div class="ticket-band">KHQR</div>
  <div class="ticket-body">
    <p class="ticket-name">${escapeHtml(merchantName)}</p>
    <p class="ticket-amount">${escapeHtml(amount)}<span>USD</span></p>
    <div class="ticket-rule"></div>
    <img src="${qrDataUrl}" alt="KHQR" />
  </div>
</div>`;
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** One small self-contained page -- a payer may be on a slow phone connection. */
function payShell(title, body, autoOpen = null) {
  return `<!doctype html>
<html lang="km"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: -apple-system, "Noto Sans Khmer", system-ui, sans-serif;
         background:#f4f5f7; color:#111; padding:20px; }
  @media (prefers-color-scheme: dark) { body { background:#111417; color:#f2f2f2; } .card { background:#1b1f24 !important; } }
  .card { background:#fff; border-radius:20px; padding:26px 22px; max-width:400px; width:100%;
          text-align:center; box-shadow:0 12px 36px rgba(0,0,0,.12); }
  .amount { font-size:38px; font-weight:800; margin:4px 0 2px; }
  .amount span { font-size:15px; font-weight:600; opacity:.6; }
  .big { font-size:22px; font-weight:700; }
  .sub { opacity:.7; font-size:14px; margin:0 0 18px; }
  .btn { display:block; padding:15px; border-radius:14px; font-size:16px; font-weight:700;
         text-decoration:none; margin:14px 0 6px; }
  .aba { background:#0f2f5f; color:#fff; }
  /* The KHQR ticket, same proportions as the app's KhqrCard. A bank ticket
     is set in a plain sans, not in a display face -- it should look like the
     ticket the payer's own banking app prints. */
  .ticket { width:100%; max-width:244px; margin:14px auto 6px; background:#fff; border-radius:16px;
            overflow:hidden; box-shadow:0 16px 40px rgba(0,0,0,.35);
            font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .ticket-band { background:#E11B24; color:#fff; font-weight:900; letter-spacing:.14em; font-size:13px;
                 text-align:center; padding:7px 14px;
                 clip-path:polygon(0 0, 100% 0, 100% 55%, 88% 100%, 0 100%); }
  .ticket-body { padding:10px 14px 14px; }
  .ticket-name { margin:0; text-align:left; font-weight:700; font-size:13px; color:#1A1A1A;
                 white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ticket-amount { margin:0; text-align:left; font-weight:800; font-size:20px; line-height:1.15; color:#111;
                   font-variant-numeric:tabular-nums; }
  .ticket-amount span { margin-left:4px; font-weight:600; font-size:12px; color:#8A8A8A; }
  .ticket-rule { border-top:1px dashed #DCDCDC; margin:10px 0; }
  .ticket img { display:block; width:100%; }
  .hint { font-size:12.5px; opacity:.65; line-height:1.7; margin:8px 0; }
  .en { opacity:.75; }
</style></head>
<body><div class="card">${body}</div>
${autoOpen ? `<script>setTimeout(function(){ location.href = ${JSON.stringify(autoOpen)}; }, 350);</script>` : ""}
</body></html>`;
}

/**
 * KH Invoice's edge function asks here whether Telegram Mini App initData is
 * genuine -- only this service holds the bot token that signs it. Guarded by
 * the shared bridge secret rather than requireApiKey: the caller is that
 * edge function, not the web app.
 */
app.post(
  "/api/kh-invoice/verify",
  route(async (req, res) => {
    if (!khInvoice.bridgeSecretMatches(req.get("X-Bridge-Secret"))) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const user = khInvoice.verifyInitData(req.body?.initData);
    if (!user) return res.status(401).json({ ok: false, error: "invalid" });
    res.json({ ok: true, user });
  })
);

/**
 * Telegram calls this with every update sent to the notification bot --
 * only callback_query (an Approve/Reject button tap) is handled. Not
 * behind requireApiKey (Telegram itself is the caller): authorization
 * instead checks that the tap came from the operator's own chat.
 */
app.post(
  "/api/telegram-bot/webhook",
  route(async (req, res) => {
    // A plain message is the "paste a link, get it downloaded" flow -- open to
    // anyone, unlike the callback_query branch below which is admin-only.
    // Handled in the background so Telegram's webhook gets its 200 back
    // immediately instead of waiting out a whole download.
    const message = req.body?.message;
    if (message) {
      spawn(handleLinkBotMessage(message), `bot link message from ${message.from?.id}`);
      return res.json({ ok: true });
    }

    const inline = req.body?.inline_query;
    if (inline) {
      spawn(translate.handleInlineQuery(inline), `inline query from ${inline.from?.id}`);
      return res.json({ ok: true });
    }

    const cq = req.body?.callback_query;
    if (!cq) return res.json({ ok: true });

    // The menu bot's own buttons (data "bot:...") are for whoever tapped them,
    // not the operator, so they are handled before the admin check below.
    if (await handleBotCallback(cq)) return res.json({ ok: true });

    const chatId = String(cq.message?.chat?.id ?? "");
    if (!config.telegramAdminChatId || chatId !== String(config.telegramAdminChatId)) {
      await answerCallbackQuery(cq.id, "Not authorized.");
      return res.json({ ok: true });
    }

    const [action, submissionId] = String(cq.data ?? "").split(":");
    try {
      if (action === "pay_approve" && submissionId) {
        await subscription.approveSubmission(submissionId);
        await answerCallbackQuery(cq.id, "Approved");
        await stampDecision(cq.message, "✅ APPROVED");
      } else if (action === "pay_reject" && submissionId) {
        await subscription.rejectSubmission(submissionId, "rejected via Telegram");
        await answerCallbackQuery(cq.id, "Rejected");
        await stampDecision(cq.message, "❌ REJECTED");
      } else {
        await answerCallbackQuery(cq.id, "Unrecognized action.");
      }
    } catch (err) {
      await answerCallbackQuery(cq.id, String(err?.message ?? err).slice(0, 200));
    }
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------- admin panel

/** Approves a pending payment claim -- the Admin Panel's equivalent of the Telegram button. */
app.post(
  "/api/admin/payments/:id/approve",
  requireAdmin,
  route(async (req, res) => {
    const result = await subscription.approveSubmission(req.params.id);
    res.json({ success: true, ...result });
  })
);

/** Rejects a pending payment claim. */
app.post(
  "/api/admin/payments/:id/reject",
  requireAdmin,
  route(async (req, res) => {
    const note = String(req.body?.note ?? "").trim() || null;
    await subscription.rejectSubmission(req.params.id, note);
    res.json({ success: true });
  })
);

// The frontend reads {success, error} off every response, so a crash has to
// keep that shape -- Express's default HTML error page would leave the user
// with a generic "Request to backend failed." instead of the real reason.
app.use((err, req, res, _next) => {
  console.error(`Request failed: ${req.method} ${req.path}`, err?.message ?? err);
  res.status(500).json({ success: false, error: String(err?.message ?? err).slice(0, 500) });
});

/**
 * Points the bot at this deployment's webhook on startup, so a fresh deploy
 * (or a first-time setup) needs no manual setWebhook call. Telegram treats a
 * repeat of the same URL as a no-op, and a failure here must never stop the
 * service from serving the web app.
 */
async function registerBotWebhook() {
  if (!config.telegramLoginBotToken || !config.publicUrl) return;
  const url = `${config.publicUrl.replace(/\/$/, "")}/api/telegram-bot/webhook`;
  try {
    const result = await botApi("setWebhook", { url, allowed_updates: ["message", "callback_query", "inline_query"] });
    if (result?.ok) console.log(`Telegram bot webhook set to ${url}`);
  } catch (err) {
    console.error("Could not set the Telegram bot webhook:", err?.message ?? err);
  }
  // What Telegram lists when someone types "/" -- the AI's models among them.
  for (const [language, list] of Object.entries(BOT_COMMANDS)) {
    const commands = list.map(([command, description]) => ({ command, description }));
    await botApi("setMyCommands", { commands, ...(language === "en" ? {} : { language_code: language }) }).catch(() => null);
  }
  // The button beside the message box: the native "/" command list (so
  // /start -- a quick restart -- is always one tap away), rather than a
  // web_app launcher. Opening the Mini App stays on its own big keyboard
  // button (mainKeyboard's "Open App" row) for whoever needs it.
  const commandsMenu = await botApi("setChatMenuButton", { menu_button: { type: "commands" } }).catch(() => null);
  if (commandsMenu?.ok) console.log("Chat menu button shows the / command list");
}

const server = app.listen(config.port, () => {
  console.log(`Userbot service listening on http://localhost:${config.port}`);
  void registerBotWebhook();
  void khInvoice.announce();
  void watch.announce();
  void aiCredits.announce().catch((err) => console.error("AI Credit packages:", err?.message ?? err));
  void loop();
});

// Node closes a request that takes longer than five minutes by default, which
// is nothing for a video upload on a slow line. Uploads stream in, so a slow
// client is not holding anything expensive open -- let them take as long as
// they need, and let the headers timeout keep the usual protection.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

/**
 * Railway starts the replacement container before stopping this one, so for a
 * few seconds two processes hold the same Telegram session -- which is
 * exactly what makes Telegram invalidate it. Dropping our connections as soon
 * as we are asked to stop keeps that window as short as possible.
 */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received -- closing Telegram connections`);
    server.close();
    telegram.disconnectAll()
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

export { app };
