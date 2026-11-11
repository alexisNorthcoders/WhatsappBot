import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type FixtureTitle = {
  id: number;
  title: string;
  author?: string;
  kind?: 'book' | 'series';
  genre?: string;
  verification?: 'verified' | 'unchecked' | 'unverified';
};

/** One mention of `bookId` in each of `threads` threads, numbered from `t<from>`. */
export type FixtureMentions = {
  bookId: number;
  threads: number;
  from?: number;
  sentiment?: 'positive' | 'neutral' | 'negative';
};

/** The columns of reddit-bot's `books` and `book_mentions` that the catalog reads. */
const SCHEMA = `
  CREATE TABLE books (
    id INTEGER PRIMARY KEY, canonical_key TEXT NOT NULL UNIQUE, display_title TEXT NOT NULL,
    author TEXT, created_at TEXT NOT NULL, genre TEXT,
    verification_status TEXT NOT NULL DEFAULT 'unchecked', kind TEXT NOT NULL DEFAULT 'book');
  CREATE TABLE book_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER NOT NULL REFERENCES books(id),
    sentiment TEXT NOT NULL, reddit_kind TEXT NOT NULL, reddit_id TEXT NOT NULL,
    post_id TEXT NOT NULL, permalink TEXT, subreddit TEXT, source_excerpt TEXT,
    processed_at TEXT NOT NULL, author_name TEXT);`;

export function createBookDb(titles: FixtureTitle[], mentions: FixtureMentions[]) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'books-')), 'reddit_bot.sqlite3');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const addTitle = db.prepare(`INSERT INTO books
    (id, canonical_key, display_title, author, created_at, genre, verification_status, kind)
    VALUES (?, ?, ?, ?, '2026-01-01', ?, ?, ?)`);
  for (const t of titles) {
    addTitle.run(t.id, `key-${t.id}`, t.title, t.author ?? null, t.genre ?? null, t.verification ?? 'verified', t.kind ?? 'book');
  }
  const addMention = db.prepare(`INSERT INTO book_mentions
    (book_id, sentiment, reddit_kind, reddit_id, post_id, permalink, subreddit, source_excerpt, processed_at)
    VALUES (?, ?, 'comment', ?, ?, ?, 'Fantasy', ?, '2026-11-01T00:00:00+00:00')`);
  const add = (m: FixtureMentions) => {
    for (let i = 0; i < m.threads; i++) {
      const post = `t${(m.from ?? 0) + i}`;
      addMention.run(m.bookId, m.sentiment ?? 'positive', `c${m.bookId}-${post}`, post,
        `https://www.reddit.com/r/Fantasy/comments/${post}/x/c${m.bookId}/`, `Loved book ${m.bookId}.`);
    }
  };
  mentions.forEach(add);
  return { file, add, close: () => db.close() };
}
