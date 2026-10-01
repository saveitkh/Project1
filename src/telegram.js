/** Telegram userbot (teleproto, the maintained GramJS fork): one shared
 * client, plus the interactive login flow. */
import os from "node:os";

import { Api, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";

import { config } from "./config.js";
import { db, nowIso, rows, telegramAccountById, telegramSettings, upsertSingle } from "./db.js";

// The default account (telegram_settings) keeps its own single `client`
// variable, exactly as before this file supported more than one account --
// this is what makes adding telegram_accounts a zero-risk change for
// anyone who never adds a second account. Extra accounts each get their own
// entry in `extraClients`, keyed by their telegram_accounts row id.
let client = null;
const extraClients = new Map();
// Held between /send-code and /verify-code, one slot per account (the
// default account's slot is keyed by "" so it doesn't collide with a real id).
const pending = {};

function newClientFor(conf) {
  if (!conf.apiId || !conf.apiHash) {
    throw new Error("Telegram api_id/api_hash are not set.");
  }
  return new TelegramClient(
    new StringSession(conf.sessionString || ""),
    Number(conf.apiId),
    conf.apiHash,
    {
      connectionRetries: 5,
      // teleproto sleeps out any FLOOD_WAIT at or under this threshold
      // automatically, for every API call -- not just the ones
      // floodRetry.js wraps. Its own default is 60s; config.js raises it.
      floodSleepThreshold: config.floodSleepThresholdSeconds,
      downloadPool: {
        // teleproto retries one chunk only 5 times by default, and every
        // FLOOD_WAIT counts as one of them. A big group download trips
        // Telegram's 1-2 second GetFile throttle every minute or so, so 5
        // ran out, the error escaped, and the whole file restarted from
        // byte 0 -- a 700MB episode never got past its first minute. The
        // scheduler already sleeps out each wait for the whole DC before
        // retrying, so a larger budget just means "keep waiting it out".
        requestRetries: config.downloadChunkRetries,
        // 0 (the default) leaves teleproto's own auto-scaling in place, which
        // already opens up to 8 parallel connections per DC and grows the
        // transfer window on its own -- see config.js for why this is opt-in
        // rather than always maxed out.
        ...(config.maxDownloadSessions > 0 ? { maxSessions: config.maxDownloadSessions } : {}),
      },
    }
  );
}

/**
 * `accountId` selects which Telegram session to use: omitted/null/undefined
 * is the original default account (telegram_settings, env vars included),
 * exactly as this function always worked; a telegram_accounts row id
 * connects through that account's own session instead. A group's
 * account_id is what callers thread through here -- null on a group means
 * "the default account", the same thing it's always implicitly meant.
 */
/**
 * Connects, and then shuts the update loop down.
 *
 * Nothing in this service consumes Telegram updates -- scanning and
 * downloading are plain API calls, and the bot is driven by a webhook -- but
 * the client still polls updates.GetDifference forever in the background.
 * That is the call that reported AuthKeyDuplicatedError ("concurrent usage
 * ... the current session was invalidated") every time a deploy briefly ran
 * two containers on the same session string, which killed the userbot until
 * somebody signed it in again. No update loop, no such call.
 */
// ------------------------------------------------------------ session lease
//
// Telegram invalidates a session the instant the same auth key is connected
// from two places. A Railway deploy starts the new container before stopping
// the old one, and the new one used to connect straight away -- the health
// check itself did it -- so for a few seconds both held the session, and
// Telegram signed the userbot out. Every deploy was a coin toss.
//
// So no process opens a Telegram connection without first holding the
// "telegram-userbot" lease (see the service_leases migration). The old
// container keeps renewing it until it is told to stop, then lets go; the
// new one waits for that instead of colliding with it. A holder that
// crashes simply lets its lease run out.
const LEASE_NAME = "telegram-userbot";
const LEASE_TTL_SECONDS = 30;
const LEASE_RENEW_MS = 10_000;
const LEASE_HOLDER = `${process.env.RAILWAY_DEPLOYMENT_ID || os.hostname()}:${process.pid}:${Math.random()
  .toString(36)
  .slice(2, 8)}`;

let leaseHeld = false;
let leaseWaiter = null;
let leaseTimer = null;

export class TelegramBusyError extends Error {
  constructor() {
    super("Telegram is still held by the previous server instance -- try again in a moment.");
    this.name = "TelegramBusyError";
  }
}

async function tryAcquireLease() {
  const { data, error } = await db().rpc("acquire_lease", {
    p_name: LEASE_NAME,
    p_holder: LEASE_HOLDER,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (error) throw new Error(`Lease check failed: ${error.message}`);
  return data === true;
}

/** Keeps the lease alive; if it is ever lost, drops every connection at once. */
function startLeaseRenewal() {
  if (leaseTimer) return;
  leaseTimer = setInterval(async () => {
    try {
      if (await tryAcquireLease()) return;
      // Someone else holds it now -- carrying on would be the exact collision
      // this exists to prevent, so disconnect rather than risk the session.
      console.error("Telegram lease was lost to another instance -- disconnecting.");
      leaseHeld = false;
      await disconnectClients();
    } catch (err) {
      // A blip reaching the database: the 30s TTL covers a missed renewal or
      // two, so this is not a reason to tear anything down.
      console.error("Telegram lease renewal failed:", err?.message ?? err);
    }
  }, LEASE_RENEW_MS);
  leaseTimer.unref?.();
}

/**
 * Resolves once this process holds the lease, waiting up to `maxWaitMs` for
 * the previous holder to let go. Concurrent callers share one wait.
 */
export async function ensureLease(maxWaitMs = 60_000) {
  if (leaseHeld) return;
  if (!leaseWaiter) {
    leaseWaiter = (async () => {
      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        if (await tryAcquireLease()) {
          leaseHeld = true;
          startLeaseRenewal();
          return;
        }
        if (Date.now() >= deadline) throw new TelegramBusyError();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    })().finally(() => {
      leaseWaiter = null;
    });
  }
  return leaseWaiter;
}

export function holdsLease() {
  return leaseHeld;
}

async function releaseLease() {
  if (leaseTimer) clearInterval(leaseTimer);
  leaseTimer = null;
  if (!leaseHeld) return;
  leaseHeld = false;
  await db()
    .rpc("release_lease", { p_name: LEASE_NAME, p_holder: LEASE_HOLDER })
    .then(null, () => {});
}

async function disconnectClients() {
  const all = [client, ...extraClients.values()].filter(Boolean);
  await Promise.all(all.map((c) => c.disconnect().catch(() => {})));
}

async function connectQuietly(c) {
  await ensureLease();
  if (!c.connected) await c.connect();
  try {
    c.updateManager?.stop?.();
  } catch {
    // Never let a library internal we only use as an optimization break a connect.
  }
  return c;
}

/** Closes every Telegram connection this process holds. */
export async function disconnectAll() {
  await disconnectClients();
  // Only after the connections are closed: handing the lease over first would
  // let the next instance connect while ours is still open.
  await releaseLease();
}

export async function getClient({ requireAuth = true, accountId = null } = {}) {
  if (!accountId) {
    if (!client) {
      const conf = await telegramSettings();
      client = newClientFor(conf);
    }
    await connectQuietly(client);
    if (requireAuth && !(await client.isUserAuthorized())) {
      throw new Error("The userbot is not signed in yet.");
    }
    return client;
  }

  let extra = extraClients.get(accountId);
  if (!extra) {
    const conf = await telegramAccountById(accountId);
    if (!conf) throw new Error(`No Telegram account with id ${accountId}.`);
    extra = newClientFor({ apiId: conf.api_id, apiHash: conf.api_hash, sessionString: conf.session_string });
    extraClients.set(accountId, extra);
  }
  await connectQuietly(extra);
  if (requireAuth && !(await extra.isUserAuthorized())) {
    throw new Error("That Telegram account is not signed in yet.");
  }
  return extra;
}

// The last answer isAuthorized() got, per account, so the health check can
// report it without opening a connection of its own (see /health).
const lastAuthorized = new Map();

export async function isAuthorized(accountId = null) {
  try {
    const c = await getClient({ requireAuth: false, accountId });
    const ok = await c.isUserAuthorized();
    lastAuthorized.set(accountId ?? "", ok);
    return ok;
  } catch (err) {
    // Waiting on the lease is not being signed out; don't record it as one.
    if (!(err instanceof TelegramBusyError)) lastAuthorized.set(accountId ?? "", false);
    return false;
  }
}

/** The last known sign-in state, or null before the first check. Never connects. */
export function knownAuthorized(accountId = null) {
  return lastAuthorized.has(accountId ?? "") ? lastAuthorized.get(accountId ?? "") : null;
}

/** Starts the login by asking Telegram to send the confirmation code, for the default account or a specific extra one. */
export async function sendCode(accountId = null) {
  const conf = accountId ? await telegramAccountById(accountId) : await telegramSettings();
  const apiId = accountId ? conf?.api_id : conf.apiId;
  const apiHash = accountId ? conf?.api_hash : conf.apiHash;
  const phone = accountId ? conf?.phone : conf.phone;
  if (!conf || !phone) throw new Error("No phone number is configured.");

  const c = await loginClient({ accountId, apiId, apiHash });
  const { phoneCodeHash } = await c.sendCode({ apiId: Number(apiId), apiHash }, phone);
  // The code is bound to the connection that asked for it, so verifyCode must
  // use this exact client, not whatever getClient() happens to return later.
  pending[accountId || ""] = { phone, phoneCodeHash, client: c };
  return { success: true, phone };
}

/**
 * The client to sign in with. A session Telegram has invalidated cannot sign
 * in again -- its auth key is revoked, so asking it for a login code fails --
 * and that is exactly the state someone is in when they come here to
 * reconnect. So unless the current client is still signed in, this starts
 * over on a brand-new, empty session: a fresh auth key nothing else has ever
 * used. It also replaces the dead client, which otherwise kept reconnecting
 * on every worker pass.
 */
async function loginClient({ accountId, apiId, apiHash }) {
  const current = accountId ? extraClients.get(accountId) : client;
  if (current) {
    try {
      await connectQuietly(current);
      if (await current.isUserAuthorized()) return current;
    } catch {
      // Dead key -- falls through to a fresh session below.
    }
    await current.disconnect().catch(() => {});
  }

  const fresh = newClientFor({ apiId, apiHash, sessionString: "" });
  if (accountId) extraClients.set(accountId, fresh);
  else client = fresh;
  await connectQuietly(fresh);
  return fresh;
}

/** Completes the login, asking for the 2FA password when Telegram wants one. */
export async function verifyCode(code, password, accountId = null) {
  const conf = accountId ? await telegramAccountById(accountId) : await telegramSettings();
  const apiId = accountId ? conf?.api_id : conf.apiId;
  const apiHash = accountId ? conf?.api_hash : conf.apiHash;
  const slot = pending[accountId || ""] || {};
  // The client that requested the code; a different one cannot redeem it.
  const c = slot.client || (await getClient({ requireAuth: false, accountId }));
  const phone = slot.phone || (accountId ? conf?.phone : conf.phone);

  try {
    if (password) {
      await c.signInWithPassword(
        { apiId: Number(apiId), apiHash },
        {
          password: async () => password,
          onError: (err) => {
            throw err;
          },
        }
      );
    } else {
      await c.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: slot.phoneCodeHash,
          phoneCode: code,
        })
      );
    }
  } catch (err) {
    if (String(err?.errorMessage || err?.message).includes("SESSION_PASSWORD_NEEDED")) {
      return { success: true, needsPassword: true };
    }
    throw err;
  }

  const me = await c.getMe();
  const sessionString = c.session.save();
  const table = accountId ? "telegram_accounts" : "telegram_settings";
  const values = {
    session_string: sessionString,
    connected: true,
    last_connected_at: nowIso(),
    account_first_name: me.firstName ?? null,
    account_last_name: me.lastName ?? null,
    account_username: me.username ?? null,
    account_user_id: String(me.id),
  };
  if (accountId) await db().from(table).update(values).eq("id", accountId);
  else await upsertSingle(table, values);
  delete pending[accountId || ""];

  return {
    success: true,
    needsPassword: false,
    session_string: sessionString,
    account: { id: String(me.id), username: me.username, first_name: me.firstName },
  };
}

/** Signs the userbot out and clears the stored session, for the default account or a specific extra one. */
export async function logout(accountId = null) {
  const c = await getClient({ requireAuth: false, accountId });
  try {
    await c.invoke(new Api.auth.LogOut());
  } finally {
    await c.disconnect().catch(() => {});
    const values = {
      session_string: null,
      connected: false,
      account_first_name: null,
      account_last_name: null,
      account_username: null,
      account_user_id: null,
    };
    if (accountId) {
      extraClients.delete(accountId);
      await db().from("telegram_accounts").update(values).eq("id", accountId);
    } else {
      client = null;
      await upsertSingle("telegram_settings", values);
    }
  }
  return { success: true };
}

/** The extra accounts beyond the default one, for the account picker in Add Group. */
export async function listAccounts() {
  return rows(
    await db()
      .from("telegram_accounts")
      .select("id, label, phone, connected, account_first_name, account_last_name, account_username, account_user_id")
      .order("created_at", { ascending: true })
  );
}

/** Registers a new extra account's api_id/api_hash/phone -- not yet signed in. */
/**
 * api_id/api_hash identify the *application*, not the phone number signing
 * in with it -- Telegram is fine with the same pair logging in any number
 * of separate accounts. So a second account normally needs nothing but a
 * phone number: it reuses the default account's own api_id/api_hash unless
 * one is explicitly given (still supported for an operator who wants a
 * distinct app credential per account).
 */
export async function addAccount({ label, apiId, apiHash, phone }) {
  if (!phone) throw new Error("A phone number is required.");
  let finalApiId = apiId;
  let finalApiHash = apiHash;
  if (!finalApiId || !finalApiHash) {
    const conf = await telegramSettings();
    finalApiId = finalApiId || conf.apiId;
    finalApiHash = finalApiHash || conf.apiHash;
  }
  if (!finalApiId || !finalApiHash) {
    throw new Error("No api_id/api_hash is available yet -- connect the default account first (Settings › Telegram).");
  }
  const [row] = rows(
    await db()
      .from("telegram_accounts")
      .insert({ label: label || "Account", api_id: String(finalApiId), api_hash: finalApiHash, phone })
      .select()
  );
  return row;
}

/** Removes an extra account. Groups pointed at it fall back to the default account (ON DELETE SET NULL). */
export async function deleteAccount(accountId) {
  const extra = extraClients.get(accountId);
  if (extra) {
    await extra.disconnect().catch(() => {});
    extraClients.delete(accountId);
  }
  await db().from("telegram_accounts").delete().eq("id", accountId);
  return { success: true };
}

// Matches t.me and telegram.me links with or without a scheme/www.
const TME_HOST = /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i;

/**
 * Extracts a chat identifier -- and a message id, when the link points at one
 * specific message -- from any form Telegram hands out: a bare "-100...", a
 * "@name", "t.me/name", "t.me/name/42", "t.me/c/<internal id>[/42]" (a
 * private chat with no username), or a "tg://resolve" / "tg://privatepost"
 * deep link. The message id is not used everywhere yet, but callers that only
 * need the chat can keep calling {@link normalizeChatId}.
 */
/**
 * A client that can actually read `chatId`, and the chat itself.
 *
 * Different groups are joined by different accounts -- the VIP group is on
 * the second one -- so the default account alone cannot see every chat. A
 * chat we already track as a group uses that group's own account; anything
 * else tries the default account, then each connected extra account, and
 * the first one that can resolve the chat wins.
 */
/**
 * getEntity, retried once after refreshing the dialog list: a channel an
 * account joined recently (or one it hasn't touched since the process
 * restarted) isn't in its entity cache yet, and a bare -100… id then fails
 * with CHANNEL_INVALID even though the account is a genuine member.
 */
export async function resolveEntity(client, chatId) {
  try {
    return await client.getEntity(chatId);
  } catch {
    await client.getDialogs({ limit: 200 }).catch(() => null);
    return client.getEntity(chatId);
  }
}

export async function getClientForChat(chatId) {
  const tried = [];
  const [known] = rows(
    await db().from("groups").select("account_id").eq("chat_id", String(chatId)).limit(1)
  );
  if (known) tried.push(known.account_id ?? null);
  tried.push(null);
  for (const account of await listAccounts()) {
    if (account.connected) tried.push(account.id);
  }

  let lastErr = null;
  for (const accountId of [...new Set(tried)]) {
    try {
      const client = await getClient({ accountId });
      const entity = await resolveEntity(client, chatId);
      return { client, entity, accountId };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("No connected Telegram account can see that chat.");
}

export function parseTelegramLink(input) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("A chat ID is required.");

  if (/^tg:\/\/resolve/i.test(value)) {
    const params = new URL(value.replace(/^tg:\/\//i, "https://tg/")).searchParams;
    const domain = params.get("domain");
    if (!domain) throw new Error("This tg:// link has no domain.");
    const post = params.get("post");
    return { chatId: `@${domain}`, messageId: post ? Number(post) : null };
  }

  if (/^tg:\/\/privatepost/i.test(value)) {
    const params = new URL(value.replace(/^tg:\/\//i, "https://tg/")).searchParams;
    const channel = params.get("channel");
    if (!channel) throw new Error("This tg:// link has no channel id.");
    const post = params.get("post");
    return { chatId: Number(`-100${channel}`), messageId: post ? Number(post) : null };
  }

  if (TME_HOST.test(value)) {
    const path = value.replace(TME_HOST, "").replace(/^\/+/, "");

    if (/^\+|^joinchat\//.test(path)) {
      throw new Error('This is an invite link — use "Invite link" to join it first, not a chat ID.');
    }

    // t.me/c/<internal id>[/<topic id>]/<message id> -- a private chat with
    // no username. A post inside a forum topic carries the topic id as an
    // extra segment, and the message is always the LAST number: reading the
    // first one instead fetched the topic's opening post, which has no video.
    const privateMatch = path.match(/^c\/(\d+)((?:\/\d+)*)/);
    if (privateMatch) {
      const numbers = privateMatch[2].split("/").filter(Boolean);
      return {
        chatId: Number(`-100${privateMatch[1]}`),
        messageId: numbers.length ? Number(numbers[numbers.length - 1]) : null,
      };
    }

    // t.me/<username>[/<topic id>]/<message id>
    const publicMatch = path.match(/^([A-Za-z0-9_]+)((?:\/\d+)*)/);
    if (publicMatch) {
      const numbers = publicMatch[2].split("/").filter(Boolean);
      return {
        chatId: `@${publicMatch[1]}`,
        messageId: numbers.length ? Number(numbers[numbers.length - 1]) : null,
      };
    }

    throw new Error("Could not read a chat from this t.me link.");
  }

  if (value.startsWith("@")) return { chatId: value, messageId: null };
  if (/^-?\d+$/.test(value)) return { chatId: Number(value), messageId: null };

  // A bare username with neither an "@" nor a link wrapper.
  return { chatId: `@${value}`, messageId: null };
}

/** Accepts -100..., a bare id, @name, a t.me link or a tg:// deep link. */
export function normalizeChatId(chatId) {
  return parseTelegramLink(chatId).chatId;
}

/**
 * Reads the forum topics of a group, paging until Telegram stops sending
 * more. Takes the client directly (not an accountId) since the caller has
 * always already resolved `entity` through it -- entities are bound to the
 * client that fetched them, so re-deriving one from an accountId here could
 * silently mismatch the two.
 */
export async function listTopics(client, entity) {
  const c = client;
  const found = [];
  let offsetTopic = 0;
  let offsetId = 0;
  let offsetDate = 0;

  for (;;) {
    const result = await c.invoke(
      // Note: forum topics live under messages.*, not channels.*, in the
      // current TL schema -- channels.GetForumTopics no longer exists.
      new Api.messages.GetForumTopics({
        peer: entity,
        offsetDate,
        offsetId,
        offsetTopic,
        limit: 100,
      })
    );
    const batch = (result.topics ?? []).filter((t) => t.title);
    if (batch.length === 0) break;

    for (const topic of batch) {
      found.push({ topic_id: String(topic.id), title: topic.title });
    }
    if (batch.length < 100) break;

    offsetTopic = batch[batch.length - 1].id;
    const lastMessage = result.messages?.[result.messages.length - 1];
    offsetId = lastMessage?.id ?? 0;
    offsetDate = lastMessage?.date ?? 0;
  }

  return found;
}

/**
 * The groups and channels this account is already in, so a chat ID never has
 * to be copied by hand. Private chats and bots are left out — only places
 * videos can be scanned from.
 */
export async function listDialogs(limit = 200, accountId = null) {
  const c = await getClient({ accountId });
  const dialogs = await c.getDialogs({ limit });

  return dialogs
    .filter((d) => d.isGroup || d.isChannel)
    .map((d) => ({
      chat_id: String(d.id),
      title: d.title || d.name || String(d.id),
      username: d.entity?.username ?? null,
      is_forum: Boolean(d.entity?.forum),
      participants_count: d.entity?.participantsCount ?? null,
    }));
}

/**
 * Searches Telegram's global directory of public groups/channels by keyword
 * -- the same lookup the official app's search box does -- so a group the
 * account has never joined can be found before joinChat() is used on it.
 * People (PeerUser results) are dropped: this is only for finding places to
 * join and scan, not for contact lookup.
 */
export async function searchPublicChats(query, limit = 20, accountId = null) {
  const q = String(query ?? "").trim();
  if (!q) return [];

  const c = await getClient({ accountId });
  const result = await c.invoke(new Api.contacts.Search({ q, limit }));
  const chatById = new Map((result.chats ?? []).map((chat) => [String(chat.id), chat]));

  const found = [];
  const seen = new Set();
  for (const peer of result.results ?? []) {
    let chat;
    if (peer instanceof Api.PeerChannel) chat = chatById.get(String(peer.channelId));
    else if (peer instanceof Api.PeerChat) chat = chatById.get(String(peer.chatId));
    else continue; // a PeerUser -- not something that can be scanned

    if (!chat || seen.has(String(chat.id))) continue;
    seen.add(String(chat.id));

    found.push({
      chat_id: String(chat.id),
      title: chat.title || String(chat.id),
      username: chat.username ?? null,
      is_channel: Boolean(chat.broadcast),
      is_megagroup: Boolean(chat.megagroup),
      participants_count: chat.participantsCount ?? null,
      // `left` is only meaningful on channels/megagroups; absent elsewhere.
      already_joined: chat.left === false,
    });
  }
  return found;
}

/**
 * Joins a public @name or a t.me/+hash invite link, then describes what was
 * joined so the UI can add it straight away.
 */
export async function joinChat(invite, accountId = null) {
  const c = await getClient({ accountId });
  const value = String(invite ?? "").trim();
  if (!value) throw new Error("An invite link or @username is required.");

  const hashMatch = value.match(/(?:joinchat\/|\+)([\w-]+)/);
  if (hashMatch) {
    try {
      await c.invoke(new Api.messages.ImportChatInvite({ hash: hashMatch[1] }));
    } catch (err) {
      // Already a member is a success for our purposes.
      if (!String(err?.errorMessage ?? "").includes("USER_ALREADY_PARTICIPANT")) throw err;
    }
    const check = await c.invoke(new Api.messages.CheckChatInvite({ hash: hashMatch[1] }));
    const chat = check.chat ?? check;
    const chatId = chat?.id ? String(chat.id) : "";
    return { ...(await describeGroup(chatId || value, accountId)), chat_id: chatId };
  }

  const username = value.startsWith("@") ? value : `@${value.split("/").pop()}`;
  const entity = await c.getEntity(username);
  await c.invoke(new Api.channels.JoinChannel({ channel: entity })).catch((err) => {
    if (!String(err?.errorMessage ?? "").includes("USER_ALREADY_PARTICIPANT")) throw err;
  });
  return { ...(await describeGroup(username, accountId)), chat_id: String(entity.id) };
}

/**
 * Sends a note to the account's own Saved Messages — used to report that a
 * batch finished without needing push notifications or email.
 */
export async function notifySelf(text) {
  const c = await getClient();
  await c.sendMessage("me", { message: String(text ?? "").slice(0, 4000) });
  return { success: true };
}

/** Everything the Add/Forward dialogs show before anything is written. */
export async function describeGroup(chatId, accountId = null) {
  const c = await getClient({ accountId });
  const entity = await c.getEntity(normalizeChatId(chatId));
  const isForum = Boolean(entity.forum);

  let participants = null;
  try {
    const full = await c.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    participants = full.fullChat?.participantsCount ?? null;
  } catch {
    participants = null;
  }

  return {
    success: true,
    title: entity.title || entity.username || String(chatId),
    username: entity.username ?? null,
    is_forum: isForum,
    participants_count: participants,
    topics: isForum ? await listTopics(c, entity) : [],
  };
}

/** Turns a raw Api.UserStatus* into something a UI can show without knowing the TL schema. */
function describeUserStatus(status) {
  if (!status) return { kind: "unknown" };
  if (status instanceof Api.UserStatusOnline) return { kind: "online" };
  if (status instanceof Api.UserStatusOffline) return { kind: "offline", last_seen: status.wasOnline ?? null };
  if (status instanceof Api.UserStatusRecently) return { kind: "recently" };
  if (status instanceof Api.UserStatusLastWeek) return { kind: "last_week" };
  if (status instanceof Api.UserStatusLastMonth) return { kind: "last_month" };
  return { kind: "hidden" }; // UserStatusEmpty -- privacy setting hides it
}

/** The role a member's own ChannelParticipant/ChatParticipant variant implies. */
function describeRole(participant) {
  if (!participant) return "member";
  const name = participant.className || "";
  if (name.includes("Creator")) return "owner";
  if (name.includes("Admin")) return "admin";
  if (name.includes("Banned")) return "banned";
  return "member";
}

/**
 * Lists a group's members -- requires the account behind `accountId` to
 * actually be a member (an admin isn't required to just list; Telegram only
 * refuses this for very large public channels with hidden member lists).
 * Used for the read-only "who's in this VIP group" view, not for anything
 * that acts on members (kick/ban aren't exposed here).
 */
export async function listMembers(chatId, accountId = null, limit = 200) {
  const c = await getClient({ accountId });
  const entity = await c.getEntity(normalizeChatId(chatId));
  const participants = await c.getParticipants(entity, { limit: Math.min(Number(limit) || 200, 1000) });

  return participants.map((p) => ({
    id: String(p.id),
    first_name: p.firstName ?? null,
    last_name: p.lastName ?? null,
    username: p.username ?? null,
    phone: p.phone ?? null,
    is_bot: Boolean(p.bot),
    is_premium: Boolean(p.premium),
    role: describeRole(p.participant),
    status: describeUserStatus(p.status),
  }));
}
