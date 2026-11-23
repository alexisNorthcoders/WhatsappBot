import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { BookCatalog, Candidate, Dossier, Exclusions, Title, VocabularyTag } from './bookCatalog.ts';
import { ASK_ANSWERS_SQL, ASK_RETRIEVAL_SQL, ASK_SETTINGS, askParams, poolAnswers, type AskAnswer, type AskSettings, type RankedAsk } from './askRetrieval.ts';

/**
 * Reads reddit-bot's recommendation read model read-only, and nothing else of its schema.
 * reddit-bot pins the views' columns in test/recReadModel.test.ts.
 *
 * Required: `rec_titles`, `rec_mentions`, `rec_names` and `rec_similar` (its nightly book
 * similarity). Optional, because reddit-bot deploys them later: `rec_tags`, `rec_vocabulary`
 * and `rec_dossiers` (Haiku Title tags and Dossiers), `rec_series_books` (Series Membership), and
 * `rec_asks`, `rec_ask_seeds`, `rec_ask_tags`, `ask_fts` and `rec_ask_answers` (the ask index), and
 * `rec_merges` (catalog Merges, one hop deep). Without one, its feature is off: no tag filtering, excerpts instead of Dossiers, no Series
 * collapse or "start with", no answers from past asks, no remapping of Merged-away ids.
 * `optional()` caches a view missing at open as off, so `rec_merges` is picked up on the first restart after reddit-bot creates it.
 */

const STATS_MAX_AGE_MS = 60 * 60 * 1000;
/** reddit-bot measured its tags 94% precise at this confidence and 75% below it. */
export const MIN_TAG_CONFIDENCE = 0.6;

const LEADING_ARTICLE = /^(the|a|an) /;
const SERIES_WORD = / (series|saga|trilogy|duology|quartet|cycle|chronicles?|archives?|books|novels)$/;
const BOOK_RANGE = / (books? )?\d+ \d+$/;

/**
 * reddit-bot's Title key (`titleKey` in its src/db/recReadModel.ts), the key `rec_names` is
 * stored under: lowercase letters and digits, without a leading article, a trailing series
 * word or a trailing book range. Both repos test it against the same vectors.
 */
export function titleKey(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’‘]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  let key = folded;
  for (let prev = ''; prev !== key; ) {
    prev = key;
    key = key.replace(LEADING_ARTICLE, '').replace(SERIES_WORD, '').replace(BOOK_RANGE, '');
  }
  return key || folded;
}

/** Wilson score lower bound (95%) of a share `p` over `n` trials. */
function wilsonLowerBound(p: number, n: number, z = 1.96) {
  if (!n) return 0;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/**
 * How strongly to offer a Title to someone with no anchors: well liked and widely read. The
 * liked share counts a neutral Mention as half a positive one, its Wilson lower bound keeps
 * a small sample from leading, and log10(mentions) lets volume lift a title without swamping
 * sentiment. On the 2026-11-19 copy this put Discworld, Curse of Chalion, First Law and Earthsea
 * on top, where a positive-vs-negative Wilson score put Penric (310 Mentions, 251/1) first.
 */
export function popularity(t: Pick<Title, 'mentions' | 'positive' | 'negative'>) {
  if (!t.mentions) return 0;
  const neutral = t.mentions - t.positive - t.negative;
  return wilsonLowerBound((t.positive + neutral / 2) / t.mentions, t.mentions) * Math.log10(t.mentions + 1);
}

const nameTokens = (name: string) => name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** True when every word of an excluded name appears in the Title's author. */
function byExcludedAuthor(author: string | null, excluded: string[][]) {
  if (!author) return false;
  const have = new Set(nameTokens(author));
  return excluded.some((tokens) => tokens.every((t) => have.has(t)));
}

const jsonStrings = (raw: unknown) => {
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

type Ranked = Title & { popularity: number };
type Membership = { seriesOf: Map<number, number[]>; books: Map<number, { id: number; position: number | null }[]> };

export function openSqliteBookCatalog(
  path: string,
  { now = Date.now, askSettings = ASK_SETTINGS }: { now?: () => number; askSettings?: AskSettings } = {},
): BookCatalog {
  const db = new DatabaseSync(path, { readOnly: true });

  /** A statement over a view reddit-bot may not have deployed yet, or null. */
  function optional(sql: string): StatementSync | null {
    try {
      return db.prepare(sql);
    } catch (err) {
      if (/no such table/.test((err as Error).message)) return null;
      throw err;
    }
  }

  const statsStmt = db.prepare(`SELECT id, title, author, kind, genre, mentions, positive, negative FROM rec_titles`);
  const namesStmt = db.prepare(`SELECT title_id AS id FROM rec_names WHERE name_key = ?`);
  // similarTo prepares per anchor count; this fails at open, like the views above, on a DB without it.
  db.prepare(`SELECT anchor_id, title_id, score, shared_threads FROM rec_similar LIMIT 0`);
  const excerptStmt = db.prepare(`
    SELECT excerpt, permalink FROM rec_mentions
    WHERE title_id = ? AND sentiment = 'positive' AND excerpt IS NOT NULL
    ORDER BY processed_at DESC LIMIT 2`);
  const tagsStmt = optional(`SELECT title_id AS id, facet, tag FROM rec_tags WHERE confidence >= ${MIN_TAG_CONFIDENCE}`);
  const vocabularyStmt = optional(`SELECT facet, tag, description FROM rec_vocabulary ORDER BY facet, tag`);
  const dossierStmt = optional(`SELECT praise, complaints, advice, comparisons FROM rec_dossiers WHERE title_id = ?`);
  const membershipStmt = optional(`SELECT series_id, book_id, position FROM rec_series_books`);
  const askStmt = optional(ASK_RETRIEVAL_SQL);
  const answersStmt = optional(ASK_ANSWERS_SQL);
  const mergeStmt = optional(`SELECT survivor_id FROM rec_merges WHERE absorbed_id = ?`);

  type Stats = { at: number; byId: Map<number, Ranked>; ranked: Ranked[]; tags: Map<number, string[]>; membership: Membership };
  let cache: Stats | null = null;

  /** About a second over the whole read model, so rebuilt at most hourly as reddit-bot writes. */
  function stats(): Stats {
    if (cache && now() - cache.at < STATS_MAX_AGE_MS) return cache;
    const ranked = (statsStmt.all() as Title[])
      .map((t) => ({ ...t, popularity: popularity(t) }))
      .sort((a, b) => b.popularity - a.popularity || b.mentions - a.mentions);
    const tags = new Map<number, string[]>();
    for (const r of (tagsStmt?.all() ?? []) as { id: number; facet: string; tag: string }[]) {
      tags.set(r.id, [...(tags.get(r.id) ?? []), `${r.facet}:${r.tag}`]);
    }
    const membership: Membership = { seriesOf: new Map(), books: new Map() };
    for (const r of (membershipStmt?.all() ?? []) as { series_id: number; book_id: number; position: number | null }[]) {
      membership.seriesOf.set(r.book_id, [...(membership.seriesOf.get(r.book_id) ?? []), r.series_id]);
      membership.books.set(r.series_id, [...(membership.books.get(r.series_id) ?? []), { id: r.book_id, position: r.position }]);
    }
    cache = { at: now(), byId: new Map(ranked.map((t) => [t.id, t])), ranked, tags, membership };
    return cache;
  }

  /** A Title with its Series and their Books: two Titles sharing one are the same reading. */
  function family(id: number, { seriesOf, books }: Membership) {
    const series = [...(books.has(id) ? [id] : []), ...(seriesOf.get(id) ?? [])];
    return new Set([id, ...series, ...series.flatMap((s) => (books.get(s) ?? []).map((b) => b.id))]);
  }

  function toTitle({ popularity: _p, ...title }: Ranked): Title {
    return title;
  }

  function startWith(id: number, s: Stats) {
    const first = (s.membership.books.get(id) ?? [])
      .filter((b) => b.position !== null && b.position >= 1)
      .sort((a, b) => a.position! - b.position!)[0];
    return first ? s.byId.get(first.id)?.title ?? null : null;
  }

  function candidate(t: Ranked, s: Stats, sharedThreads?: number): Candidate {
    const row = dossierStmt?.get(t.id) as Record<string, unknown> | undefined;
    const dossier: Dossier | null = row
      ? { praise: jsonStrings(row.praise), complaints: jsonStrings(row.complaints), advice: jsonStrings(row.advice), comparisons: jsonStrings(row.comparisons) }
      : null;
    const mentions = excerptStmt.all(t.id) as { excerpt: string; permalink: string | null }[];
    return {
      ...toTitle(t),
      ...(sharedThreads === undefined ? {} : { sharedThreads }),
      tags: s.tags.get(t.id) ?? [],
      dossier,
      excerpts: dossier ? [] : mentions.map((m) => m.excerpt),
      link: mentions.find((m) => m.permalink)?.permalink ?? null,
      startWith: t.kind === 'series' ? startWith(t.id, s) : null,
    };
  }

  /**
   * Allowed, de-duplicated Titles in the given order, cut to `limit`. An excluded Title
   * excludes its family, and only the first of a family is kept. Wanted tags re-rank only the
   * first 2×limit allowed rows, so a tagged but distant Title can't jump the close ones.
   */
  function shortlist<T extends { t: Ranked }>(rows: T[], s: Stats, { exclude, limit, tags = [] }: { exclude: Exclusions; limit: number; tags?: string[] }) {
    const authors = exclude.authors.map(nameTokens).filter((t) => t.length);
    const taken = new Set(exclude.ids.flatMap((id) => [...family(id, s.membership)]));
    const window: T[] = [];
    for (const row of rows) {
      if (taken.has(row.t.id) || byExcludedAuthor(row.t.author, authors)) continue;
      for (const id of family(row.t.id, s.membership)) taken.add(id);
      window.push(row);
      if (window.length === 2 * limit) break;
    }
    const matched = (id: number) => (s.tags.get(id) ?? []).filter((tag) => tags.includes(tag)).length;
    return window.sort((a, b) => matched(b.t.id) - matched(a.t.id)).slice(0, limit);
  }

  return {
    find(name) {
      const { byId } = stats();
      // A name can key several catalog rows (a Series and its fragments); the most-mentioned is meant.
      const best = (namesStmt.all(titleKey(name)) as { id: number }[])
        .map((r) => byId.get(r.id))
        .filter((t) => t !== undefined)
        .reduce<Ranked | null>((top, t) => (!top || t.mentions > top.mentions ? t : top), null);
      return best ? toTitle(best) : null;
    },

    similarTo(anchorIds, opts) {
      if (!anchorIds.length) return [];
      const s = stats();
      const marks = anchorIds.map(() => '?').join(',');
      // A Title close to several anchors outranks one close to a single anchor.
      const similar = db.prepare(`
        SELECT title_id AS id, SUM(score) AS score, SUM(shared_threads) AS sharedThreads FROM rec_similar
        WHERE anchor_id IN (${marks}) AND title_id NOT IN (${marks})
        GROUP BY title_id ORDER BY score DESC, title_id`).all(...anchorIds, ...anchorIds) as { id: number; sharedThreads: number }[];
      const rows = similar.flatMap(({ id, sharedThreads }) => {
        const t = s.byId.get(id);
        return t ? [{ t, sharedThreads }] : [];
      });
      return shortlist(rows, s, { ...opts, exclude: { ...opts.exclude, ids: [...opts.exclude.ids, ...anchorIds] } })
        .map(({ t, sharedThreads }) => candidate(t, s, sharedThreads));
    },

    answeredFor(query, opts) {
      if (!askStmt || !answersStmt) return [];
      const s = stats();
      const asks = askStmt.all(askParams(query, askSettings)) as RankedAsk[];
      const rows = poolAnswers(asks, (id) => answersStmt.all(id) as AskAnswer[]).flatMap((p) => {
        const t = s.byId.get(p.titleId);
        return t ? [{ t, p }] : [];
      });
      return shortlist(rows, s, opts).map(({ t, p }) => {
        const c = candidate(t, s);
        const example = { title: p.best.title ?? 'an r/Fantasy request', link: p.best.permalink };
        return { ...c, link: example.link ?? c.link, answered: { redditors: p.redditors, against: p.against, asks: p.asks, example } };
      });
    },

    popular({ genre, tags = [], ...opts }) {
      const s = stats();
      const rows = s.ranked
        .filter((t) => (!genre || t.genre === genre) && (!tags.length || (s.tags.get(t.id) ?? []).some((x) => tags.includes(x))))
        .map((t) => ({ t }));
      return shortlist(rows, s, { ...opts, tags }).map(({ t }) => candidate(t, s));
    },

    genres() {
      const all = new Set(stats().ranked.map((t) => t.genre));
      return [...all].filter((g): g is string => !!g && g !== 'other').sort();
    },

    title(id) {
      const t = stats().byId.get(id);
      if (!t) return null;
      const { popularity: _, ...title } = t;
      return title;
    },

    survivorOf(id) {
      const row = mergeStmt?.get(id) as { survivor_id: number } | undefined;
      return row?.survivor_id ?? null;
    },

    tagsOf(id) {
      return stats().tags.get(id) ?? [];
    },

    vocabulary() {
      return ((vocabularyStmt?.all() ?? []) as { facet: string; tag: string; description: string }[])
        .map((r): VocabularyTag => ({ tag: `${r.facet}:${r.tag}`, description: r.description }));
    },
  };
}
