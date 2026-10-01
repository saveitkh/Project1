/** Background loop: auto rules, the download queue, and auto-following forwards. */
import { db, rows } from "./db.js";
import { config } from "./config.js";
import * as botJobs from "./botJobs.js";
import * as botPay from "./botPay.js";
import { applyAutoRules, processQueue, requeueOrphanedDownloads } from "./downloader.js";
import * as forwarder from "./forwarder.js";
import * as mirror from "./mirror.js";
import { scanGroup } from "./scanner.js";
import { holdsLease, isAuthorized, listAccounts } from "./telegram.js";
import * as urlfetch from "./urlfetch.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether ANY Telegram account can work right now.
 *
 * This used to ask only the default account, so when its session died every
 * group stopped -- including the ones scanned and downloaded by the second
 * account, which was perfectly fine. Worse, it failed silently: seven
 * downloads sat queued for half an hour with nothing in the log to say why.
 * Now one dead account only costs its own groups, and the reason is logged
 * (once every few minutes, not every pass).
 */
let lastSignedOutWarningAt = 0;
const SIGNED_OUT_WARNING_MS = 5 * 60 * 1000;

async function anyAccountAuthorized() {
  if (await isAuthorized()) return true;
  for (const account of await listAccounts()) {
    if (account.connected && (await isAuthorized(account.id))) return true;
  }
  const now = Date.now();
  if (now - lastSignedOutWarningAt > SIGNED_OUT_WARNING_MS) {
    lastSignedOutWarningAt = now;
    // Not holding the lease means the previous instance has not let go yet --
    // a deploy in progress, not a signed-out account. Saying "sign in again"
    // then would send someone to fix a session that is fine.
    console.warn(
      holdsLease()
        ? "No Telegram account is signed in -- scanning and downloading are paused. " +
            "Sign in again under Settings -> Telegram."
        : "Waiting for the previous server instance to release Telegram."
    );
  }
  return false;
}

/** Runs one pass every WORKER_INTERVAL seconds until the process stops. */
export async function loop() {
  // A restart interrupts whatever was downloading; put those back in the
  // queue before the first pass, or they stay 'downloading' forever.
  try {
    const recovered = await requeueOrphanedDownloads();
    if (recovered) console.log(`Re-queued ${recovered} download(s) interrupted by a restart`);
  } catch (err) {
    console.error("Could not re-queue interrupted downloads:", err?.message ?? err);
  }

  for (;;) {
    try {
      // Saving list URLs into R2 is plain HTTP: it must keep working while the
      // userbot is signed out, so it runs outside the Telegram-only pass.
      const savingUrls = await urlfetch.processQueue();
      if (savingUrls) console.log(`Started saving ${savingUrls} URL(s) to R2`);

      // Bot downloads ride that same queue, so this is where a finished one
      // gets sent back to whoever asked for it in Telegram.
      const botReplies = await botJobs.notifyFinishedJobs();
      if (botReplies) console.log(`Sent ${botReplies} finished download(s) back to the bot`);

      // Bot purchases: ask Bakong about open orders, lapse stale ones.
      const paid = await botPay.checkPendingOrders();
      if (paid) console.log(`Bakong confirmed ${paid} bot order(s)`);

      if (await anyAccountAuthorized()) await onePass();
    } catch (err) {
      // A bad pass must never kill the loop.
      console.error("Worker pass failed:", err?.message ?? err);
    }
    await sleep(config.workerInterval * 1000);
  }
}

// scanGroup's own default is a full, unbounded history walk -- right for a
// manual "Scan" click, since the user is waiting for a complete result. This
// job instead runs unattended every few minutes, so it caps each pass to
// recent messages: new episodes land near the top of the history anyway, and
// re-walking the entire history on every tick would only add load and flood
// risk for a large group without finding anything a previous full scan (or
// the next manual one) hasn't already.
const AUTO_RESCAN_MESSAGE_LIMIT = 3000;

/**
 * Re-scans any group with auto_rescan on whose last scan is older than
 * config.autoRescanMinutes -- a lighter, recent-only pass (see
 * AUTO_RESCAN_MESSAGE_LIMIT above), not the full history walk a manual
 * "Scan" click does. A manual/URL-list group (chat_id "manual:...") is never
 * a real Telegram chat, so it's excluded rather than left to fail.
 */
async function autoRescanGroups() {
  const cutoff = new Date(Date.now() - config.autoRescanMinutes * 60 * 1000).toISOString();
  const groups = rows(
    await db()
      .from("groups")
      .select("id, chat_id, last_scanned_at")
      .eq("auto_rescan", true)
      .not("chat_id", "like", "manual:%")
  );
  const due = groups.filter((g) => !g.last_scanned_at || g.last_scanned_at < cutoff);

  let rescanned = 0;
  for (const group of due) {
    try {
      await scanGroup(group.id, AUTO_RESCAN_MESSAGE_LIMIT);
      rescanned += 1;
    } catch (err) {
      console.error(`Auto-rescan of group ${group.id} failed:`, err?.message ?? err);
    }
  }
  return rescanned;
}

async function onePass() {
  const rescanned = await autoRescanGroups();
  if (rescanned) console.log(`Auto-rescan refreshed ${rescanned} group(s)`);

  const { queued } = await applyAutoRules();
  if (queued) console.log(`Auto rules queued ${queued} episode(s)`);

  const started = await processQueue();
  if (started) console.log(`Started ${started} download(s)`);

  const added = await forwarder.syncAutoFollowJobs();
  if (added) console.log(`Auto-follow added ${added} video(s) to forward jobs`);

  const pending = rows(
    await db().from("forward_jobs").select("id, mirror_id").eq("status", "queued").limit(3)
  );
  for (const job of pending) {
    try {
      await forwarder.runJob(job.id);
    } catch (err) {
      console.error(`Forward job ${job.id} failed:`, err?.message ?? err);
    }
    if (job.mirror_id) await mirror.refreshStatus(job.mirror_id).catch(() => {});
  }
}
