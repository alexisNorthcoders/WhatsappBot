import { DatabaseSync } from 'node:sqlite';
import type { BookCatalog, Candidate, Exclusions, Title } from './bookCatalog.ts';

/** Unverified rows are mostly extraction mistakes; unchecked ones (most Series) are kept. */
const RANKABLE = `b.verification_status != 'unverified'`;

/** Below this many mentions a Title's share of co-mentions is noise. */
const MIN_SIMILAR_MENTIONS = 30;

const STATS_MAX_AGE_MS = 60 * 60 * 1000;

const nameTokens = (name: string) => name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** True when every word of an excluded name appears in the Title's author. */
function byExcludedAuthor(author: string | null, excluded: string[][]) {
  if (!author) return false;
  const have = new Set(nameTokens(author));
  return excluded.some((tokens) => tokens.every((t) => have.has(t)));
}

/**
 * Wilson lower bound on the positive share of positive + negative mentions, as reddit-bot's
 * book_stats scores Books: 180 of 210 positive outranks 2 of 2.
 */
export function wilsonLowerBound(positive: number, n: number, z = 1.96) {
  if (!n) return 0;
  const p = positive / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

type Scored = Title & { score: number };

/**
 * Reads reddit-bot's database read-only. Mention counts are computed here, not read from
 * book_stats, because book_stats leaves out Series, which hold most of the discussion.
 */
export function openSqliteBookCatalog(
  path: string,
  { now = Date.now }: { now?: () => number } = {},
): BookCatalog {
  const db = new DatabaseSync(path, { readOnly: true });

  const statsStmt = db.prepare(`
    SELECT b.id, b.display_title AS title, b.author, b.kind, b.genre,
      COUNT(*) AS mentions,
      SUM(m.sentiment = 'positive') AS positive,
      SUM(m.sentiment = 'negative') AS negative
    FROM books b JOIN book_mentions m ON m.book_id = b.id
    WHERE ${RANKABLE}
    GROUP BY b.id`);

  const findStmt = db.prepare(`
    SELECT b.id FROM books b WHERE LOWER(b.display_title) = LOWER(?) AND ${RANKABLE}`);

  const excerptStmt = db.prepare(`
    SELECT source_excerpt AS excerpt, permalink FROM book_mentions
    WHERE book_id = ? AND sentiment = 'positive'
      AND source_excerpt IS NOT NULL AND TRIM(source_excerpt) != ''
    ORDER BY processed_at DESC LIMIT 2`);

  let cache: { at: number; byId: Map<number, Scored>; ranked: Scored[] } | null = null;

  /** About a second over the whole table, so rebuilt at most hourly as reddit-bot writes. */
  function stats() {
    if (cache && now() - cache.at < STATS_MAX_AGE_MS) return cache;
    const ranked = (statsStmt.all() as Title[])
      .map((t) => ({ ...t, score: wilsonLowerBound(t.positive, t.positive + t.negative) }))
      .sort((a, b) => b.score - a.score || b.mentions - a.mentions);
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
      const matches = (findStmt.all(name.trim()) as { id: number }[])
        .map((r) => byId.get(r.id))
        .filter((t) => t !== undefined)
        .sort((a, b) => b.mentions - a.mentions);
      return matches[0] ? toTitle(matches[0]) : null;
    },

    similarTo(anchorIds, { exclude, limit }) {
      if (!anchorIds.length) return [];
      const { byId } = stats();
      const marks = anchorIds.map(() => '?').join(',');
      const shared = db.prepare(`
        SELECT book_id AS id, COUNT(DISTINCT post_id) AS sharedThreads FROM book_mentions
        WHERE post_id IN (SELECT post_id FROM book_mentions WHERE book_id IN (${marks}))
          AND book_id NOT IN (${marks})
        GROUP BY book_id`).all(...anchorIds, ...anchorIds) as { id: number; sharedThreads: number }[];
      const keep = allowed(exclude);
      // shared² / mentions ranks by how concentrated a Title's discussion is in the anchors'
      // threads; raw shared counts just return the subreddit's most popular Series.
      return shared
        .flatMap(({ id, sharedThreads }) => {
          const t = byId.get(id);
          return t && t.mentions >= MIN_SIMILAR_MENTIONS && keep(t)
            ? [{ t, sharedThreads, rank: (sharedThreads * sharedThreads) / t.mentions }]
            : [];
        })
        .sort((a, b) => b.rank - a.rank)
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
