/**
 * Classroom tools for a teacher's Telegram group: a student roster, tagging
 * every student (or one team), a "✅ seen" check that can re-tag only the
 * students who have not tapped it, repeating auto messages (how many times,
 * every how many minutes), and a DM to every student who has started the bot.
 *
 * Everything is sent through the same bot as the rest of linkBot. Telegram
 * lets a bot post roughly 20 messages a minute into one group, so a run never
 * goes faster than MIN_GROUP_GAP_MS; when Telegram still answers 429 it is
 * waited out (withFloodRetry) and the run carries on, so a class of any size
 * is tagged in full instead of half-sent. The teacher picks how many names
 * go in each message and the gap between messages -- the only floor is the
 * pace Telegram itself enforces.
 *
 * Only group admins (the teacher) can send; any member can /join.
 */
import { config } from "./config.js";
import { db, fetchAll, nowIso, rows } from "./db.js";
import { withFloodRetry } from "./floodRetry.js";

// Telegram's per-group pace for bots (~20 messages/minute). Going faster only
// earns 429s, so a shorter gap the teacher asks for is raised to this.
const MIN_GROUP_GAP_MS = 3000;
// Private chats: Telegram allows ~30 bot messages a second across all chats.
const DM_GAP_MS = 50;
const MAX_PER_MESSAGE = 50;
const DEFAULT_PER_MESSAGE = 5;
const DEFAULT_GAP_SECONDS = 4;
const ADMIN_CACHE_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- Bot API

/**
 * One Bot API call. A 429 is thrown as a flood-wait error (err.seconds) so
 * withFloodRetry waits exactly what Telegram asked and tries again.
 */
async function rawApi(method, body) {
  if (!config.telegramLoginBotToken) return null;
  const res = await fetch(`https://api.telegram.org/bot${config.telegramLoginBotToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error_code === 429) {
    const err = new Error(`FLOOD_WAIT_${data.parameters?.retry_after ?? 5}`);
    err.seconds = Number(data.parameters?.retry_after ?? 5);
    throw err;
  }
  return data;
}

async function api(method, body) {
  const data = await withFloodRetry(() => rawApi(method, body), { label: `classroom ${method}` });
  if (data && !data.ok) console.error(`Telegram ${method} failed:`, JSON.stringify(data));
  return data;
}

const send = (chatId, text, extra = {}) =>
  api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

const escapeHtml = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A mention that notifies the student even without a @username. */
function mention(member) {
  const name = (member.first_name || member.username || String(member.user_id)).slice(0, 32);
  return `<a href="tg://user?id=${member.user_id}">${escapeHtml(name)}</a>`;
}

// ------------------------------------------------------------ teachers

const adminCache = new Map();

/** True when this user is an admin/owner of the group (the teacher). */
async function isTeacher(chatId, userId) {
  const key = `${chatId}:${userId}`;
  const hit = adminCache.get(key);
  if (hit && Date.now() - hit.at < ADMIN_CACHE_MS) return hit.ok;
  const data = await api("getChatMember", { chat_id: chatId, user_id: userId });
  const ok = ["creator", "administrator"].includes(data?.result?.status);
  adminCache.set(key, { ok, at: Date.now() });
  return ok;
}

// -------------------------------------------------------------- roster

async function addMember(chatId, from, team = null) {
  const values = {
    chat_id: chatId,
    user_id: from.id,
    first_name: from.first_name ?? null,
    username: from.username ?? null,
    updated_at: nowIso(),
  };
  if (team) values.team = team.slice(0, 32);
  rows(await db().from("class_members").upsert(values, { onConflict: "chat_id,user_id" }).select());
}

async function members(chatId, team = null) {
  return fetchAll(() => {
    let q = db().from("class_members").select("*").eq("chat_id", chatId).order("user_id");
    if (team) q = q.ilike("team", team);
    return q;
  });
}

async function settingsFor(chatId) {
  const row = rows(await db().from("class_settings").select("*").eq("chat_id", chatId).limit(1))[0];
  return {
    perMessage: row?.per_message ?? DEFAULT_PER_MESSAGE,
    gapSeconds: row?.gap_seconds ?? DEFAULT_GAP_SECONDS,
  };
}

// ---------------------------------------------------------- send queue

// One run at a time per group (tags, auto messages), in order; /stop bumps
// the generation so whatever is queued or running ends at its next message.
const queues = new Map();
const generations = new Map();

function enqueue(chatId, job) {
  const gen = generations.get(chatId) ?? 0;
  const next = (queues.get(chatId) ?? Promise.resolve())
    .then(() => job(() => (generations.get(chatId) ?? 0) !== gen))
    .catch((err) => console.error(`classroom run in ${chatId} failed:`, err?.message ?? err));
  queues.set(chatId, next);
  return next;
}

function stopRuns(chatId) {
  generations.set(chatId, (generations.get(chatId) ?? 0) + 1);
}

/**
 * Posts `text` and then mentions every listed student, `perMessage` names to
 * a message, `gapSeconds` apart (never under Telegram's group pace).
 */
async function tagRun(chatId, list, text, { perMessage, gapSeconds }, stopped) {
  const gap = Math.max(gapSeconds * 1000, MIN_GROUP_GAP_MS);
  if (text) await send(chatId, escapeHtml(text));
  let sent = 0;
  for (let i = 0; i < list.length; i += perMessage) {
    if (stopped()) return sent;
    if (text || i > 0) await sleep(gap);
    await send(chatId, list.slice(i, i + perMessage).map(mention).join(" "));
    sent += Math.min(perMessage, list.length - i);
  }
  return sent;
}

// ------------------------------------------------------------- checks

function checkKeyboard(checkId, seen) {
  return {
    inline_keyboard: [
      [{ text: `✅ បានឃើញ (${seen})`, callback_data: `cls:seen:${checkId}` }],
      [
        { text: "📊 លទ្ធផល", callback_data: `cls:result:${checkId}` },
        { text: "🔔 Tag អ្នកមិនទាន់ឃើញ", callback_data: `cls:unseen:${checkId}` },
      ],
    ],
  };
}

async function seenIds(checkId) {
  const marks = await fetchAll(() =>
    db().from("class_check_marks").select("user_id").eq("check_id", checkId).order("user_id")
  );
  return new Set(marks.map((m) => Number(m.user_id)));
}

// -------------------------------------------------------- auto messages

/**
 * Sends every auto message that is due. Called from the worker loop; the
 * conditional update on next_at claims a row, so two instances never send
 * the same message twice.
 */
export async function runDueAutoMessages() {
  if (!config.telegramLoginBotToken) return 0;
  const due = rows(
    await db().from("class_autos").select("*").eq("active", true).lte("next_at", nowIso()).limit(50)
  );
  let fired = 0;
  for (const auto of due) {
    const sentCount = auto.sent_count + 1;
    const done = auto.times > 0 && sentCount >= auto.times;
    const claimed = rows(
      await db()
        .from("class_autos")
        .update({
          sent_count: sentCount,
          active: !done,
          next_at: new Date(Date.now() + auto.every_minutes * 60 * 1000).toISOString(),
          updated_at: nowIso(),
        })
        .eq("id", auto.id)
        .eq("next_at", auto.next_at)
        .select("id")
    );
    if (!claimed.length) continue;
    fired += 1;
    const chatId = Number(auto.chat_id);
    const label = auto.times > 0 ? ` (${sentCount}/${auto.times})` : "";
    if (auto.tag) {
      const list = await members(chatId, auto.team);
      const settings = await settingsFor(chatId);
      enqueue(chatId, (stopped) => tagRun(chatId, list, `${auto.text}${label}`, settings, stopped));
    } else {
      enqueue(chatId, () => send(chatId, escapeHtml(`${auto.text}${label}`)));
    }
  }
  return fired;
}

// ------------------------------------------------------------- commands

const HELP = [
  "🎓 <b>ឧបករណ៍ថ្នាក់រៀន</b>",
  "",
  "<b>សិស្ស</b>",
  "/join [ក្រុម] — ចុះឈ្មោះក្នុងថ្នាក់ (ឧ. /join A)",
  "/leave — ដកឈ្មោះចេញ",
  "",
  "<b>គ្រូ (Admin ក្រុម)</b>",
  "/joinbutton — ផ្ញើប៊ូតុង ✋ ឲ្យសិស្សចុចចុះឈ្មោះ",
  "/students — បញ្ជីសិស្ស",
  "/settag &lt;ឈ្មោះក្នុង១សារ&gt; &lt;វិនាទី&gt; — ឧ. /settag 5 4",
  "/tagall [សារ] — Tag សិស្សទាំងអស់",
  "/tagteam &lt;ក្រុម&gt; [សារ] — Tag តែក្រុមមួយ",
  "/check &lt;សារ&gt; — សារមានប៊ូតុង ✅ បានឃើញ",
  "/auto &lt;ចំនួនដង&gt; &lt;នាទី&gt; [tag] &lt;សារ&gt; — ផ្ញើស្វ័យប្រវត្តិ (0 ដង = រហូត)",
  "   ឧ. /auto 5 30 tag កុំភ្លេចធ្វើកិច្ចការផ្ទះ",
  "/autolist — បញ្ជីសារស្វ័យប្រវត្តិ",
  "/autostop &lt;លេខ|all&gt; — បញ្ឈប់សារស្វ័យប្រវត្តិ",
  "/dm &lt;សារ&gt; — ផ្ញើសារផ្ទាល់ទៅសិស្សដែលបាន Start bot",
  "/stop — បញ្ឈប់ការ Tag ដែលកំពុងដំណើរការ",
].join("\n");

/**
 * Handles a message in a group/supergroup. Returns true when it was a
 * classroom command; anything else in a group is ignored by the bot.
 */
export async function handleGroupMessage(message) {
  const chatId = message.chat.id;
  const from = message.from;
  const text = String(message.text ?? "").trim();
  const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match || !from?.id || from.is_bot) return false;
  const command = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  if (command === "join") {
    await addMember(chatId, from, args.split(/\s+/)[0] || null);
    await send(chatId, `✅ ${mention({ user_id: from.id, first_name: from.first_name })} បានចុះឈ្មោះ${args ? ` (ក្រុម ${escapeHtml(args.split(/\s+/)[0])})` : ""}`);
    return true;
  }
  if (command === "leave") {
    await db().from("class_members").delete().eq("chat_id", chatId).eq("user_id", from.id);
    await send(chatId, "👋 បានដកឈ្មោះចេញ");
    return true;
  }

  const known = ["class", "help", "joinbutton", "students", "settag", "tagall", "tagteam", "check", "auto", "autolist", "autostop", "dm", "stop"];
  if (!known.includes(command)) return false;
  if (command === "class" || command === "help") {
    await send(chatId, HELP);
    return true;
  }
  if (!(await isTeacher(chatId, from.id))) {
    await send(chatId, "⚠️ មានតែគ្រូ (Admin ក្រុម) ទេដែលអាចប្រើពាក្យបញ្ជានេះ");
    return true;
  }
  // Whoever teaches is also on the roster, so a fresh group is never empty.
  await addMember(chatId, from).catch(() => null);

  switch (command) {
    case "joinbutton":
      await send(chatId, "✋ សិស្សទាំងអស់ សូមចុចប៊ូតុងខាងក្រោម ដើម្បីចុះឈ្មោះក្នុងថ្នាក់", {
        reply_markup: { inline_keyboard: [[{ text: "✋ ចុះឈ្មោះ", callback_data: "cls:join" }]] },
      });
      return true;

    case "students": {
      const list = await members(chatId);
      const teams = new Map();
      for (const m of list) teams.set(m.team || "—", (teams.get(m.team || "—") ?? 0) + 1);
      const s = await settingsFor(chatId);
      const byTeam = [...teams].map(([team, n]) => `• ក្រុម ${escapeHtml(team)}: ${n}`).join("\n");
      await send(
        chatId,
        `👥 សិស្សសរុប: <b>${list.length}</b>\n${byTeam}\n\n🏷 Tag ${s.perMessage} ឈ្មោះ/សារ · រៀងរាល់ ${Math.max(s.gapSeconds, MIN_GROUP_GAP_MS / 1000)} វិនាទី`
      );
      return true;
    }

    case "settag": {
      const [perRaw, gapRaw] = args.split(/\s+/);
      const per = Number(perRaw);
      const gap = Number(gapRaw ?? DEFAULT_GAP_SECONDS);
      if (!Number.isInteger(per) || per < 1 || per > MAX_PER_MESSAGE || !Number.isFinite(gap) || gap < 0) {
        await send(chatId, `ប្រើ៖ /settag &lt;1-${MAX_PER_MESSAGE}&gt; &lt;វិនាទី&gt;\nឧ. /settag 5 4`);
        return true;
      }
      rows(
        await db()
          .from("class_settings")
          .upsert({ chat_id: chatId, per_message: per, gap_seconds: Math.round(gap), updated_at: nowIso() }, { onConflict: "chat_id" })
          .select()
      );
      const note = gap * 1000 < MIN_GROUP_GAP_MS ? `\nℹ️ Telegram អនុញ្ញាតប្រហែល 20 សារ/នាទី ក្នុងមួយក្រុម ដូច្នេះ bot នឹងផ្ញើរៀងរាល់ ${MIN_GROUP_GAP_MS / 1000} វិនាទី` : "";
      await send(chatId, `✅ កំណត់រួច៖ ${per} ឈ្មោះ/សារ · រៀងរាល់ ${Math.round(gap)} វិនាទី${note}`);
      return true;
    }

    case "tagall":
    case "tagteam": {
      let team = null;
      let body = args;
      if (command === "tagteam") {
        [team, ...body] = args.split(/\s+/);
        body = body.join(" ");
        if (!team) {
          await send(chatId, "ប្រើ៖ /tagteam &lt;ក្រុម&gt; [សារ]");
          return true;
        }
      }
      if (!body && message.reply_to_message?.text) body = message.reply_to_message.text;
      const list = (await members(chatId, team)).filter((m) => Number(m.user_id) !== from.id);
      if (!list.length) {
        await send(chatId, "⚠️ មិនទាន់មានសិស្សចុះឈ្មោះទេ — ប្រើ /joinbutton ឲ្យសិស្សចុច ✋");
        return true;
      }
      const s = await settingsFor(chatId);
      const messagesNeeded = Math.ceil(list.length / s.perMessage);
      const seconds = Math.round((messagesNeeded * Math.max(s.gapSeconds * 1000, MIN_GROUP_GAP_MS)) / 1000);
      await send(chatId, `🏷 កំពុង Tag ${list.length} នាក់ (${messagesNeeded} សារ · ប្រហែល ${seconds} វិនាទី) — /stop ដើម្បីបញ្ឈប់`);
      enqueue(chatId, (stopped) => tagRun(chatId, list, body, s, stopped));
      return true;
    }

    case "check": {
      if (!args) {
        await send(chatId, "ប្រើ៖ /check &lt;សារ&gt;\nឧ. /check សូមអានមេរៀនទី 3 ហើយចុច ✅");
        return true;
      }
      const check = rows(
        await db().from("class_checks").insert({ chat_id: chatId, text: args, created_by: from.id }).select("id")
      )[0];
      await send(chatId, `📢 ${escapeHtml(args)}`, { reply_markup: checkKeyboard(check.id, 0) });
      return true;
    }

    case "auto": {
      const parts = /^(\d+)\s+(\d+(?:\.\d+)?)\s+(?:(tag)(?::(\S+))?\s+)?([\s\S]+)$/i.exec(args);
      if (!parts || Number(parts[2]) <= 0) {
        await send(
          chatId,
          "ប្រើ៖ /auto &lt;ចំនួនដង&gt; &lt;នាទី&gt; [tag] &lt;សារ&gt;\n" +
            "ឧ. /auto 3 60 tag កុំភ្លេចធ្វើកិច្ចការផ្ទះ\n" +
            "ឧ. /auto 0 1440 ថ្ងៃនេះរៀនម៉ោង 7 យប់ (0 = រហូតដល់ /autostop)\n" +
            "ឧ. /auto 2 30 tag:A ក្រុម A ត្រៀមបង្ហាញ"
        );
        return true;
      }
      const auto = rows(
        await db()
          .from("class_autos")
          .insert({
            chat_id: chatId,
            times: Number(parts[1]),
            every_minutes: Number(parts[2]),
            tag: Boolean(parts[3]),
            team: parts[4] ?? null,
            text: parts[5],
            next_at: nowIso(),
            created_by: from.id,
          })
          .select("short_id")
      )[0];
      await send(
        chatId,
        `⏰ សារស្វ័យប្រវត្តិ #${auto.short_id}: ${Number(parts[1]) || "♾"} ដង · រៀងរាល់ ${parts[2]} នាទី${parts[3] ? " · Tag សិស្ស" : ""}\nចាប់ផ្តើមឥឡូវ · /autostop ${auto.short_id} ដើម្បីបញ្ឈប់`
      );
      return true;
    }

    case "autolist": {
      const list = rows(
        await db().from("class_autos").select("*").eq("chat_id", chatId).eq("active", true).order("short_id")
      );
      await send(
        chatId,
        list.length
          ? list
              .map((a) => `#${a.short_id} · ${a.sent_count}/${a.times || "♾"} · ${a.every_minutes} នាទី${a.tag ? " · tag" : ""}\n   ${escapeHtml(a.text.slice(0, 60))}`)
              .join("\n")
          : "មិនមានសារស្វ័យប្រវត្តិទេ"
      );
      return true;
    }

    case "autostop": {
      let q = db().from("class_autos").update({ active: false, updated_at: nowIso() }).eq("chat_id", chatId).eq("active", true);
      if (args !== "all") {
        if (!/^\d+$/.test(args)) {
          await send(chatId, "ប្រើ៖ /autostop &lt;លេខ&gt; ឬ /autostop all");
          return true;
        }
        q = q.eq("short_id", Number(args));
      }
      const stoppedRows = rows(await q.select("id"));
      await send(chatId, `⏹ បានបញ្ឈប់ ${stoppedRows.length} សារស្វ័យប្រវត្តិ`);
      return true;
    }

    case "dm": {
      if (!args) {
        await send(chatId, "ប្រើ៖ /dm &lt;សារ&gt;");
        return true;
      }
      const list = await members(chatId);
      const title = escapeHtml(message.chat.title ?? "");
      await send(chatId, `✉️ កំពុងផ្ញើសារផ្ទាល់ទៅសិស្ស ${list.length} នាក់...`);
      enqueue(chatId, async (stopped) => {
        let ok = 0;
        const missing = [];
        for (const m of list) {
          if (stopped()) break;
          const res = await rawApiSafe("sendMessage", {
            chat_id: m.user_id,
            text: `🎓 ${title}\n\n${escapeHtml(args)}`,
            parse_mode: "HTML",
          });
          if (res?.ok) ok += 1;
          else missing.push(m);
          await sleep(DM_GAP_MS);
        }
        const tail = missing.length
          ? `\n⚠️ ${missing.length} នាក់មិនទាន់ Start bot៖ ${missing.slice(0, 30).map(mention).join(" ")}`
          : "";
        await send(chatId, `✅ បានផ្ញើសារផ្ទាល់ ${ok}/${list.length}${tail}`);
      });
      return true;
    }

    case "stop":
      stopRuns(chatId);
      await send(chatId, "⏹ បានបញ្ឈប់ការ Tag");
      return true;

    default:
      return false;
  }
}

/** A DM that may fail (student never started the bot) without logging noise. */
async function rawApiSafe(method, body) {
  try {
    return await withFloodRetry(() => rawApi(method, body), { label: `classroom ${method}` });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ callbacks

/** Handles a "cls:..." button tap. */
export async function handleCallback(cq) {
  const [, kind, checkId] = String(cq.data ?? "").split(":");
  const chatId = cq.message?.chat?.id;
  const from = cq.from;
  if (!chatId || !from?.id) return true;
  const answer = (text) => api("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert: false });

  if (kind === "join") {
    await addMember(chatId, from);
    await answer("✅ បានចុះឈ្មោះ");
    return true;
  }

  if (kind === "seen") {
    await addMember(chatId, from);
    await db().from("class_check_marks").upsert({ check_id: checkId, user_id: from.id }, { onConflict: "check_id,user_id" });
    const seen = await seenIds(checkId);
    await answer("✅ អរគុណ!");
    await api("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cq.message.message_id,
      reply_markup: checkKeyboard(checkId, seen.size),
    });
    return true;
  }

  if (kind === "result" || kind === "unseen") {
    if (!(await isTeacher(chatId, from.id))) {
      await answer("មានតែគ្រូទេដែលអាចប្រើប៊ូតុងនេះ");
      return true;
    }
    const seen = await seenIds(checkId);
    const teacherIds = new Set([from.id]);
    const notSeen = (await members(chatId)).filter((m) => !seen.has(Number(m.user_id)) && !teacherIds.has(Number(m.user_id)));
    await answer(kind === "result" ? "📊" : "🔔");
    if (kind === "result") {
      await send(chatId, `📊 បានឃើញ: <b>${seen.size}</b> · មិនទាន់ឃើញ: <b>${notSeen.length}</b>`);
    } else if (!notSeen.length) {
      await send(chatId, "🎉 សិស្សទាំងអស់បានឃើញហើយ");
    } else {
      const s = await settingsFor(chatId);
      enqueue(chatId, (stopped) => tagRun(chatId, notSeen, "🔔 សូមចុច ✅ នៅលើសារខាងលើ", s, stopped));
    }
    return true;
  }

  await answer("");
  return true;
}
