/**
 * Borrows a show's title + poster from Nintplex's own catalog (a sibling
 * product, its own Supabase project, public anon-key read on one table --
 * see config.nintplexSupabase*) and attaches them to the matching Telegram
 * topic already in this bot's own "Donghua in Khmer" library. Episodes still
 * come from Telegram, same as always -- this only replaces a topic's plain
 * forum-thread name and missing poster with the real ones.
 *
 * /importshows shows what would change (name matches, nothing written);
 * /importshows apply commits the clean single-topic matches only. A Nintplex
 * title that matches more than one Telegram topic (the same show split
 * across two topics) is reported, not auto-merged -- see watch.mergeTopic
 * and /mergetopic for that, a deliberate admin action on purpose.
 */
import { config } from "./config.js";
import { db, rows } from "./db.js";
import * as watch from "./watch.js";

const PAUSE_MS = 1200; // a polite gap between sticker-pack additions

function normalize(title) {
  return String(title ?? "")
    .normalize("NFC")
    .replace(/[\s​‌្«»()[\]{}·/\\\-–—:：、,，.。!！?？'"''"]/gu, "")
    .toLowerCase()
    .trim();
}

async function fetchNintplexShows() {
  const url = `${config.nintplexSupabaseUrl}/rest/v1/shows?select=id,title,poster_url&order=title`;
  const res = await fetch(url, {
    headers: {
      apikey: config.nintplexSupabaseAnonKey,
      authorization: `Bearer ${config.nintplexSupabaseAnonKey}`,
    },
  });
  if (!res.ok) throw new Error(`Nintplex returned ${res.status}`);
  const list = await res.json();
  return list.filter((s) => s.title && s.poster_url);
}

async function allTopics() {
  return rows(await db().from("topics").select("id, title, total_episodes").order("title"));
}

/** Writes one Nintplex show's poster + title onto one Telegram topic. */
async function applyOne(show, topicId) {
  const res = await fetch(show.poster_url);
  if (!res.ok) throw new Error(`poster fetch ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await watch.setPoster(topicId, buffer, null);
  await db().from("topics").update({ title: show.title }).eq("id", topicId);
}

/**
 * For the shows /importshows couldn't auto-match (different wording between
 * Nintplex and this bot's own Telegram library): a free-text search over
 * Nintplex's catalog, so an admin who recognizes the show by eye can pick it
 * by hand -- see /matchshow.
 */
export async function searchNintplexShows(query) {
  const nintplex = await fetchNintplexShows();
  const n = normalize(query);
  if (!n) return [];
  return nintplex.filter((show) => normalize(show.title).includes(n));
}

/**
 * Every Nintplex show, each with the Telegram topic(s) whose title matches
 * it (normalized equality first, then a containment fallback for slightly
 * different wording -- "ដំណើរផ្សងព្រេង... រដូវកាលទី ២" vs not, say).
 */
export async function matchShows() {
  const [nintplex, topics] = await Promise.all([fetchNintplexShows(), allTopics()]);
  const byNorm = new Map();
  for (const topic of topics) {
    const n = normalize(topic.title);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(topic);
  }
  return nintplex.map((show) => {
    const n = normalize(show.title);
    let matches = byNorm.get(n) ?? [];
    if (!matches.length) {
      matches = topics.filter((topic) => {
        const tn = normalize(topic.title);
        return tn.length > 3 && n.length > 3 && (tn.includes(n) || n.includes(tn));
      });
    }
    return { show, matches };
  });
}

/** A report of what /importshows apply would (and wouldn't) do. */
export function summarize(matched) {
  const clean = matched.filter((m) => m.matches.length === 1);
  const dupes = matched.filter((m) => m.matches.length > 1);
  const none = matched.filter((m) => m.matches.length === 0);
  const lines = [`{:ai_badge:} Nintplex import -- ${matched.length} រឿងសរុប`, ""];

  lines.push(`{:ok:} ផ្គូផ្គងច្បាស់ (apply នឹងដាក់ poster+ឈ្មោះ): ${clean.length}`);
  for (const m of clean) lines.push(`   • ${m.show.title} → ${m.matches[0].title} (${m.matches[0].total_episodes ?? 0} ep)`);

  if (dupes.length) {
    // Full ids on purpose, not shortened -- /mergetopic <keep> <drop> needs
    // the real id, and a truncated one shown here is one the admin can't
    // actually paste back in.
    lines.push("", `{:warn:} ឈ្មោះផ្គូផ្គងច្រើន topic (apply រំលង -- ប្រើ /mergetopic ដោយដៃសិន): ${dupes.length}`);
    for (const m of dupes) {
      lines.push(`   • ${m.show.title}:`);
      for (const x of m.matches) lines.push(`      - ${x.title} (${x.total_episodes ?? 0} ep) — ${x.id}`);
    }
  }

  if (none.length) {
    lines.push("", `{:fail:} រកមិនឃើញក្នុង Telegram ទេ (apply រំលង): ${none.length}`);
    for (const m of none) lines.push(`   • ${m.show.title}`);
  }

  return lines.join("\n");
}

/** Commits the clean (exactly-one-match) pairs: poster + title from Nintplex. */
export async function applyMatches(matched) {
  const clean = matched.filter((m) => m.matches.length === 1);
  let ok = 0;
  let failed = 0;
  const errors = [];
  for (const { show, matches } of clean) {
    try {
      await applyOne(show, matches[0].id);
      ok += 1;
    } catch (err) {
      failed += 1;
      errors.push(`${show.title}: ${err?.message ?? err}`);
      console.error(`Nintplex import failed for "${show.title}":`, err?.message ?? err);
    }
    // Telegram's addStickerToSet is one call per poster, all into the same
    // pack -- a small gap keeps a 30-40 show import from reading as a flood.
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }
  return { ok, failed, total: clean.length, errors };
}

/** /matchshow's single pick: write one chosen Nintplex show onto one topic. */
export async function applyManualMatch(show, topicId) {
  await applyOne(show, topicId);
}
