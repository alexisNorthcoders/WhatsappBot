import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteBookCatalog, wilsonLowerBound } from '../whatsapp/books/sqliteBookCatalog.ts';
import { createBookDb } from './helpers/bookDb.ts';

const none = { ids: [], authors: [] };

function fantasyDb() {
  return createBookDb(
    [
      { id: 1, title: 'Mistborn', author: 'Brandon Sanderson', kind: 'series', verification: 'unchecked' },
      { id: 2, title: 'The Wheel of Time', author: 'Robert Jordan', kind: 'series' },
      { id: 3, title: 'The Lies of Locke Lamora', author: 'Scott Lynch' },
      { id: 4, title: 'The Stormlight Archive', author: 'Brandon Sanderson', kind: 'series' },
      { id: 5, title: 'Rarely Mentioned', author: 'Someone' },
      { id: 6, title: 'Misread Title', verification: 'unverified' },
      { id: 7, title: 'Legends & Lattes', author: 'Travis Baldree', genre: 'cozy_fantasy' },
      { id: 8, title: 'Divisive Cozy', author: 'Other', genre: 'cozy_fantasy' },
      { id: 9, title: 'mistborn', author: 'Brandon Sanderson' },
    ],
    [
      { bookId: 1, threads: 40 },
      { bookId: 2, threads: 20 },
      { bookId: 2, threads: 400, from: 100 },
      { bookId: 3, threads: 15 },
      { bookId: 3, threads: 30, from: 500 },
      { bookId: 4, threads: 35 },
      { bookId: 5, threads: 10 },
      { bookId: 6, threads: 40 },
      { bookId: 7, threads: 50, from: 600 },
      { bookId: 8, threads: 25, from: 700 },
      { bookId: 8, threads: 25, from: 800, sentiment: 'negative' },
      { bookId: 9, threads: 3, from: 900 },
    ],
  );
}

describe('sqliteBookCatalog', () => {
  it('finds a title case-insensitively, preferring the most-mentioned row, Series included', () => {
    const catalog = openSqliteBookCatalog(fantasyDb().file);
    assert.deepEqual(catalog.find('MISTBORN'), {
      id: 1, title: 'Mistborn', author: 'Brandon Sanderson', kind: 'series', genre: null,
      mentions: 40, positive: 40, negative: 0,
    });
    assert.equal(catalog.find('Misread Title'), null);
    assert.equal(catalog.find('Never Mentioned'), null);
  });

  it("ranks titles concentrated in the anchor's threads above merely popular ones", () => {
    const catalog = openSqliteBookCatalog(fantasyDb().file);
    const similar = catalog.similarTo([1], { exclude: { ids: [], authors: ['Brandon Sanderson'] }, limit: 10 });
    assert.deepEqual(similar.map((c) => [c.title, c.sharedThreads]), [
      ['The Lies of Locke Lamora', 15],
      ['The Wheel of Time', 20],
    ]);
    assert.deepEqual(similar[0].excerpts, ['Loved book 3.', 'Loved book 3.']);
    assert.match(similar[0].link ?? '', /^https:\/\/www\.reddit\.com\/r\/Fantasy\//);
  });

  it('leaves out excluded titles, and keeps same-author titles unless excluded', () => {
    const catalog = openSqliteBookCatalog(fantasyDb().file);
    const similar = catalog.similarTo([1], { exclude: { ids: [3], authors: [] }, limit: 10 });
    assert.deepEqual(similar.map((c) => c.title), ['The Stormlight Archive', 'The Wheel of Time']);
  });

  it('ranks popular titles by how reliably positive they are, within a genre when asked', () => {
    const catalog = openSqliteBookCatalog(fantasyDb().file);
    assert.deepEqual(
      catalog.popular({ genre: 'cozy_fantasy', exclude: none, limit: 5 }).map((c) => c.title),
      ['Legends & Lattes', 'Divisive Cozy'],
    );
    assert.equal(catalog.popular({ genre: null, exclude: none, limit: 1 })[0].title, 'The Wheel of Time');
    assert.deepEqual(catalog.genres(), ['cozy_fantasy']);
  });

  it('sees new mentions once its hourly stats refresh', () => {
    const db = fantasyDb();
    let now = 0;
    const catalog = openSqliteBookCatalog(db.file, { now: () => now });
    assert.equal(catalog.find('Rarely Mentioned')?.mentions, 10);
    db.add({ bookId: 5, threads: 5, from: 1000 });
    assert.equal(catalog.find('Rarely Mentioned')?.mentions, 10);
    now += 60 * 60 * 1000;
    assert.equal(catalog.find('Rarely Mentioned')?.mentions, 15);
  });
});

describe('wilsonLowerBound', () => {
  it('scores a large mostly-positive sample above a tiny all-positive one', () => {
    assert.ok(wilsonLowerBound(180, 210) > wilsonLowerBound(2, 2));
    assert.equal(wilsonLowerBound(0, 0), 0);
  });
});
