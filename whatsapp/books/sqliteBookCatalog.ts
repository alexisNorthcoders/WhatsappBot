import { DatabaseSync } from 'node:sqlite';
import type { BookCatalog, Candidate, Exclusions, Title } from './bookCatalog.ts';

/**
 * Reads reddit-bot's recommendation read model (`rec_titles`, `rec_mentions`, `rec_names`,
 * `rec_similar`) read-only, and nothing else of its schema. reddit-bot pins those views' columns
 * in test/recReadModel.test.ts; they already leave out Unverified rows and carry the Sentiment
 * score. `rec_similar` is reddit-bot's nightly book similarity: each Title's nearest neighbours,
 * scored from co-mentions in the same comment and thread (its docs/adr/0002-book-similarity.md).
 */

const STATS_MAX_AGE_MS = 60 * 60 * 1000;

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

const nameTokens = (name: string) => name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** True when every word of an excluded name appears in the Title's author. */
function byExcludedAuthor(author: string | null, excluded: string[][]) {
  if (!author) return false;
  const have = new Set(nameTokens(author));
  return excluded.some((tokens) => tokens.every((t) => have.has(t)));
}

type Scored = Title & { score: number };

export function openSqliteBookCatalog(
  path: string,
  { now = Date.now }: { now?: () => number } = {},
): BookCatalog {
  const db = new DatabaseSync(path, { readOnly: true });

  const statsStmt = db.prepare(`
    SELECT id, title, author, kind, genre, mentions, positive, negative, score FROM rec_titles
    ORDER BY score DESC, mentions DESC`);

  const namesStmt = db.prepare(`SELECT title_id AS id FROM rec_names WHERE name_key = ?`);

  // similarTo prepares per anchor count; this fails at open, like the views above, on a DB without it.
  db.prepare(`SELECT anchor_id, title_id, score, shared_threads FROM rec_similar LIMIT 0`);

  const excerptStmt = db.prepare(`
    SELECT excerpt, permalink FROM rec_mentions
    WHERE title_id = ? AND sentiment = 'positive' AND excerpt IS NOT NULL
    ORDER BY processed_at DESC LIMIT 2`);

  let cache: { at: number; byId: Map<number, Scored>; ranked: Scored[] } | null = null;

  /** About a second over the whole view, so rebuilt at most hourly as reddit-bot writes. */
  function stats() {
    if (cache && now() - cache.at < STATS_MAX_AGE_MS) return cache;
    const ranked = statsStmt.all() as Scored[];
    cache = { at: now(), byId: new Map(ranked.map((t) => [t.id, t])), ranked };
    return cache;
  }

  function toTitle({ score: _score, ...title }: Scored): Title {
    return title;
  }

  function withEvidence(title: Title, sharedThreads?: number): Candidate {
    const mentions = excerptStmt.all(title.id) as { excerpt: string; permalink: string | null }[];
    return {
      ...title,
      ...(sharedThreads === undefined ? {} : { sharedThreads }),
      excerpts: mentions.map((m) => m.excerpt),
      link: mentions.find((m) => m.permalink)?.permalink ?? null,
    };
  }

  function allowed(exclude: Exclusions) {
    const authors = exclude.authors.map(nameTokens).filter((t) => t.length);
    return (t: Title) => !exclude.ids.includes(t.id) && !byExcludedAuthor(t.author, authors);
  }

  return {
    find(name) {
      const { byId } = stats();
      // A name can key several catalog rows (a Series and its fragments); the most-mentioned is meant.
      const best = (namesStmt.all(titleKey(name)) as { id: number }[])
        .map((r) => byId.get(r.id))
        .filter((t) => t !== undefined)
        .reduce<Scored | null>((top, t) => (!top || t.mentions > top.mentions ? t : top), null);
      return best ? toTitle(best) : null;
    },

    similarTo(anchorIds, { exclude, limit }) {
      if (!anchorIds.length) return [];
      const { byId } = stats();
      const marks = anchorIds.map(() => '?').join(',');
      // A Title close to several anchors outranks one close to a single anchor.
      const similar = db.prepare(`
        SELECT title_id AS id, SUM(score) AS score, SUM(shared_threads) AS sharedThreads FROM rec_similar
        WHERE anchor_id IN (${marks}) AND title_id NOT IN (${marks})
        GROUP BY title_id ORDER BY score DESC, title_id`).all(...anchorIds, ...anchorIds) as {
        id: number;
        sharedThreads: number;
      }[];
      const keep = allowed(exclude);
      return similar
        .flatMap(({ id, sharedThreads }) => {
          const t = byId.get(id);
          return t && keep(t) ? [{ t, sharedThreads }] : [];
        })
        .slice(0, limit)
        .map(({ t, sharedThreads }) => withEvidence(toTitle(t), sharedThreads));
    },

    popular({ genre, exclude, limit }) {
      const keep = allowed(exclude);
      return stats()
        .ranked.filter((t) => (!genre || t.genre === genre) && keep(t))
        .slice(0, limit)
        .map((t) => withEvidence(toTitle(t)));
    },

    genres() {
      const all = new Set(stats().ranked.map((t) => t.genre));
      return [...all].filter((g): g is string => !!g && g !== 'other').sort();
    },
  };
}
