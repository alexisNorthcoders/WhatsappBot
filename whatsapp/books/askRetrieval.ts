import type { AskQuery } from './bookCatalog.ts';

/**
 * Retrieval over reddit-bot's ask index: the past request Threads closest to the reader's, and
 * what r/Fantasy answered them with. The SQL and `ftsQuery` are copied from reddit-bot's
 * src/db/askRetrieval.ts (README "Ask retrieval"), with the weights bound as parameters.
 * Pooling reads `rec_ask_answers` one ask at a time instead of reddit-bot's inlined
 * `ASK_ANSWERS_SQL`, so WhatsappBot reads only the read model's views; by thread id the view
 * answers in about 20 ms.
 */

const STOPWORDS = new Set(
  'a an and any are as at be but by can for from get has have i im ive in into is it its less like looking me more most my unlike need no not of on or please rec recs recommend recommendation recommendations recommended similar so some something suggest suggestions than that the their them there these they this to want was what where which who with without would you your book books read reading novel novels series fantasy'.split(
    ' ',
  ),
);

/**
 * An FTS5 MATCH string for free text: its distinct content words (3+ letters, not stopwords),
 * each quoted, OR-joined; "" when none are left. Quoting keeps punctuation and FTS5 operators
 * in the text from breaking the query.
 */
export function ftsQuery(text: string, maxTerms = 12): string {
  const words = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)]
    .slice(0, maxTerms)
    .map((w) => `"${w}"`)
    .join(' OR ');
}

export type AskWeights = { seed: number; tag: number; text: number };

export type AskSettings = {
  weights: AskWeights;
  /** How many of the closest asks to pool. */
  asks: number;
  /** Asks scoring below this are too far from the request to pool. */
  minScore: number;
};

/** reddit-bot's hand-set first guess; `bench/books/tuneAsks.ts` measures alternatives. */
export const ASK_SETTINGS: AskSettings = { weights: { seed: 2, tag: 1, text: 1.5 }, asks: 3, minScore: 0 };

/**
 * Past asks ranked for a request. Per ask:
 * - seed overlap: request likes it also likes, plus request unlikes it also unlikes, minus
 *   Titles one side likes and the other unlikes, over the square root of the ask's seed count;
 * - tag overlap: the same with wanted and avoided tags;
 * - text match: its bm25 over title, summary and wanted text, scaled so the best match is 1.
 * score = @w_seed × seed + @w_tag × tag + @w_text × text; ties go to the newer ask.
 */
export const ASK_RETRIEVAL_SQL = `
  WITH
    req_like(id) AS (SELECT value FROM json_each(@likes)),
    req_unlike(id) AS (SELECT value FROM json_each(@unlikes)),
    req_want(t) AS (SELECT value FROM json_each(@wants)),
    req_avoid(t) AS (SELECT value FROM json_each(@avoids)),
    seed AS (
      SELECT thread_id, SUM(CASE
          WHEN relation = 'like' AND title_id IN req_like THEN 1
          WHEN relation = 'unlike' AND title_id IN req_unlike THEN 1
          ELSE -1 END) / sqrt((SELECT COUNT(*) FROM rec_ask_seeds a WHERE a.thread_id = s.thread_id)) AS n
      FROM rec_ask_seeds s
      WHERE title_id IN req_like OR title_id IN req_unlike
      GROUP BY thread_id),
    tag AS (
      SELECT thread_id, SUM(CASE
          WHEN polarity = 'want' AND facet || ':' || tag IN req_want THEN 1
          WHEN polarity = 'avoid' AND facet || ':' || tag IN req_avoid THEN 1
          ELSE -1 END) AS n
      FROM rec_ask_tags
      WHERE facet || ':' || tag IN req_want OR facet || ':' || tag IN req_avoid
      GROUP BY thread_id),
    fts AS MATERIALIZED (
      SELECT thread_id, bm25(ask_fts, 0.0, 1.0, 2.0, 1.0) AS b
      FROM ask_fts WHERE @fts != '' AND ask_fts MATCH @fts),
    text AS (SELECT thread_id, b / MIN(b) OVER () AS f FROM fts),
    cand AS (SELECT thread_id FROM seed UNION SELECT thread_id FROM tag UNION SELECT thread_id FROM text)
  SELECT a.thread_id AS threadId, a.title, a.permalink,
    @w_seed * COALESCE(seed.n, 0) + @w_tag * COALESCE(tag.n, 0) + @w_text * COALESCE(text.f, 0) AS score
  FROM cand
  JOIN rec_asks a ON a.thread_id = cand.thread_id
  LEFT JOIN seed ON seed.thread_id = cand.thread_id
  LEFT JOIN tag ON tag.thread_id = cand.thread_id
  LEFT JOIN text ON text.thread_id = cand.thread_id
  WHERE score > 0 AND score >= @min_score
  ORDER BY score DESC, a.asked_at DESC
  LIMIT @limit`;

export const ASK_ANSWERS_SQL = `SELECT title_id AS titleId, support, redditors, against FROM rec_ask_answers WHERE thread_id = ?`;

export type RankedAsk = { threadId: string; title: string | null; permalink: string | null; score: number };
export type AskAnswer = { titleId: number; support: number; redditors: number; against: number };

export function askParams(q: AskQuery, { weights, asks, minScore }: AskSettings) {
  return {
    likes: JSON.stringify(q.likes),
    unlikes: JSON.stringify(q.unlikes),
    wants: JSON.stringify(q.wants),
    avoids: JSON.stringify(q.avoids),
    fts: ftsQuery(q.text),
    w_seed: weights.seed,
    w_tag: weights.tag,
    w_text: weights.text,
    min_score: minScore,
    limit: asks,
  };
}

export type PooledAnswer = {
  titleId: number;
  /** Ask-score-weighted support, scaled down by the share of Redditors who argued against it. */
  rank: number;
  redditors: number;
  against: number;
  asks: number;
  best: RankedAsk;
};

/**
 * Each ask's answers weighted by the ask's score and pooled per Title. A rebuttal demotes:
 * the pooled support is multiplied by redditors / (redditors + against), so Sun Eater on Red
 * Rising asks (13 for, 19 against) keeps 40% of its support.
 */
export function poolAnswers(asks: RankedAsk[], answersOf: (threadId: string) => AskAnswer[]): PooledAnswer[] {
  const pool = new Map<number, { support: number; redditors: number; against: number; asks: number; best: RankedAsk; bestSupport: number }>();
  for (const ask of asks) {
    for (const a of answersOf(ask.threadId)) {
      const support = ask.score * a.support;
      const p = pool.get(a.titleId) ?? { support: 0, redditors: 0, against: 0, asks: 0, best: ask, bestSupport: -1 };
      p.support += support;
      p.redditors += a.redditors;
      p.against += a.against;
      p.asks += 1;
      if (support > p.bestSupport) Object.assign(p, { best: ask, bestSupport: support });
      pool.set(a.titleId, p);
    }
  }
  return [...pool]
    .map(([titleId, p]) => ({
      titleId,
      rank: (p.support * p.redditors) / (p.redditors + p.against || 1),
      redditors: p.redditors,
      against: p.against,
      asks: p.asks,
      best: p.best,
    }))
    .sort((a, b) => b.rank - a.rank || b.redditors - a.redditors || a.titleId - b.titleId);
}
