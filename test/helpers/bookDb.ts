import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { titleKey } from '../../whatsapp/books/sqliteBookCatalog.ts';

export type FixtureTitle = {
  id: number;
  title: string;
  author?: string;
  kind?: 'book' | 'series';
  genre?: string;
  /** Other names reddit-bot resolves to this Title (its Aliases). */
  aliases?: string[];
};

/** One mention of `bookId` in each of `threads` threads, numbered from `t<from>`. */
export type FixtureMentions = {
  bookId: number;
  threads: number;
  from?: number;
  sentiment?: 'positive' | 'neutral' | 'negative';
};

/**
 * reddit-bot's recommendation read model, with the columns its test/recReadModel.test.ts pins.
 * reddit-bot computes these as views over its catalog, leaving out Unverified rows; here the
 * fixture writes the rows directly. `score` stands in for the Sentiment score (a Wilson lower
 * bound in reddit-bot): any score that rises with positives and sample size ranks the same.
 */
const SCHEMA = `
  CREATE TABLE fixture_titles (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT, kind TEXT NOT NULL, genre TEXT);
  CREATE TABLE rec_mentions (
    title_id INTEGER NOT NULL, thread_id TEXT NOT NULL, sentiment TEXT NOT NULL,
    excerpt TEXT, permalink TEXT, processed_at TEXT NOT NULL);
  CREATE TABLE rec_names (name_key TEXT NOT NULL, title_id INTEGER NOT NULL);
  CREATE TABLE rec_similar (
    anchor_id INTEGER NOT NULL, title_id INTEGER NOT NULL, score REAL NOT NULL,
    shared_comments INTEGER NOT NULL, shared_threads INTEGER NOT NULL);
  CREATE VIEW rec_titles AS
    SELECT id, title, author, kind, genre, mentions, positive, negative,
      1.0 * positive / (positive + negative + 1) AS score
    FROM (
      SELECT t.id, t.title, t.author, t.kind, t.genre, COUNT(*) AS mentions,
        SUM(m.sentiment = 'positive') AS positive, SUM(m.sentiment = 'negative') AS negative
      FROM fixture_titles t JOIN rec_mentions m ON m.title_id = t.id GROUP BY t.id);`;

/** A `rec_similar` row: reddit-bot computes these nightly; the fixture states them. */
export type FixtureSimilar = { anchor: number; title: number; score: number; sharedThreads?: number };

/**
 * reddit-bot's optional views (Title tags, Dossiers, Series Membership). A key left out means
 * the DB has no such view, as before reddit-bot deploys it.
 */
export type FixtureExtras = {
  tags?: { title: number; tag: string; confidence?: number }[];
  vocabulary?: { tag: string; description?: string }[];
  dossiers?: { title: number; praise?: string[]; complaints?: string[]; advice?: string[]; comparisons?: string[] }[];
  seriesBooks?: { series: number; book: number; position: number | null }[];
};

export function createBookDb(titles: FixtureTitle[], mentions: FixtureMentions[], similar: FixtureSimilar[] = [], extras: FixtureExtras = {}) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'books-')), 'reddit_bot.sqlite3');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.exec('BEGIN');
  const addTitle = db.prepare(`INSERT INTO fixture_titles VALUES (?, ?, ?, ?, ?)`);
  const addName = db.prepare(`INSERT INTO rec_names VALUES (?, ?)`);
  for (const t of titles) {
    addTitle.run(t.id, t.title, t.author ?? null, t.kind ?? 'book', t.genre ?? null);
    for (const name of new Set([t.title, ...(t.aliases ?? [])].map(titleKey))) addName.run(name, t.id);
  }
  const addMention = db.prepare(`INSERT INTO rec_mentions VALUES (?, ?, ?, ?, ?, '2026-11-01T00:00:00+00:00')`);
  const add = (m: FixtureMentions) => {
    for (let i = 0; i < m.threads; i++) {
      const thread = `t${(m.from ?? 0) + i}`;
      addMention.run(m.bookId, thread, m.sentiment ?? 'positive', `Loved book ${m.bookId}.`,
        `https://www.reddit.com/r/Fantasy/comments/${thread}/x/c${m.bookId}/`);
    }
  };
  mentions.forEach(add);
  const addSimilar = db.prepare(`INSERT INTO rec_similar VALUES (?, ?, ?, 0, ?)`);
  for (const s of similar) addSimilar.run(s.anchor, s.title, s.score, s.sharedThreads ?? 1);
  if (extras.tags) {
    db.exec(`CREATE TABLE rec_tags (title_id INTEGER, facet TEXT, tag TEXT, confidence REAL)`);
    const add = db.prepare(`INSERT INTO rec_tags VALUES (?, ?, ?, ?)`);
    for (const t of extras.tags) add.run(t.title, ...t.tag.split(':'), t.confidence ?? 0.8);
  }
  if (extras.vocabulary) {
    db.exec(`CREATE TABLE rec_vocabulary (facet TEXT, tag TEXT, description TEXT, max_per_title INTEGER, version INTEGER)`);
    const add = db.prepare(`INSERT INTO rec_vocabulary VALUES (?, ?, ?, 1, 1)`);
    for (const v of extras.vocabulary) add.run(...v.tag.split(':'), v.description ?? v.tag);
  }
  if (extras.dossiers) {
    db.exec(`CREATE TABLE rec_dossiers (title_id INTEGER, praise TEXT, complaints TEXT, advice TEXT, comparisons TEXT,
      tagged_at TEXT, model TEXT, vocabulary_version INTEGER)`);
    const add = db.prepare(`INSERT INTO rec_dossiers VALUES (?, ?, ?, ?, ?, '2026-11-19', 'haiku', 1)`);
    const j = (xs?: string[]) => JSON.stringify(xs ?? []);
    for (const d of extras.dossiers) add.run(d.title, j(d.praise), j(d.complaints), j(d.advice), j(d.comparisons));
  }
  if (extras.seriesBooks) {
    db.exec(`CREATE TABLE rec_series_books (series_id INTEGER, book_id INTEGER, position REAL)`);
    const add = db.prepare(`INSERT INTO rec_series_books VALUES (?, ?, ?)`);
    for (const m of extras.seriesBooks) add.run(m.series, m.book, m.position);
  }
  db.exec('COMMIT');
  return { file, add, close: () => db.close() };
}
