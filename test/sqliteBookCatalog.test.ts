import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteBookCatalog, titleKey } from '../whatsapp/books/sqliteBookCatalog.ts';
import { createBookDb } from './helpers/bookDb.ts';

const none = { ids: [], authors: [] };

function fantasyDb() {
  return createBookDb(
    [
      { id: 1, title: 'Mistborn', author: 'Brandon Sanderson', kind: 'series' },
      { id: 2, title: 'The Wheel of Time', author: 'Robert Jordan', kind: 'series' },
      { id: 3, title: 'The Lies of Locke Lamora', author: 'Scott Lynch' },
      { id: 4, title: 'The Stormlight Archive', author: 'Brandon Sanderson', kind: 'series', aliases: ['SA'] },
      { id: 5, title: 'Rarely Mentioned', author: 'Someone' },
      { id: 6, title: 'Stormlight 1-5', author: 'Brandon Sanderson', kind: 'series' },
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
      { bookId: 6, threads: 2, from: 1100 },
      { bookId: 7, threads: 50, from: 600 },
      { bookId: 8, threads: 25, from: 700 },
      { bookId: 8, threads: 25, from: 800, sentiment: 'negative' },
      { bookId: 9, threads: 3, from: 900 },
    ],
    [
      { anchor: 1, title: 99, score: 0.9 },
      { anchor: 1, title: 3, score: 0.5, sharedThreads: 15 },
      { anchor: 1, title: 4, score: 0.4, sharedThreads: 35 },
      { anchor: 1, title: 2, score: 0.2, sharedThreads: 20 },
      { anchor: 1, title: 7, score: 0.1 },
      { anchor: 7, title: 1, score: 0.1 },
      { anchor: 7, title: 3, score: 0.3, sharedThreads: 5 },
      { anchor: 7, title: 2, score: 0.25, sharedThreads: 2 },
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
    assert.equal(catalog.find('Never Mentioned'), null);
  });

  it("resolves a name's trivial variants and Aliases to the most-mentioned row they key", () => {
    const catalog = openSqliteBookCatalog(fantasyDb().file);
    for (const name of ['Stormlight', 'the stormlight series', 'Stormlight Archives', 'SA']) {
      assert.equal(catalog.find(name)?.id, 4, name);
    }
  });

  it("ranks by reddit-bot's book similarity, skipping titles the read model no longer offers", () => {
    const catalog = openSqliteBookCatalog(fantasyDb().file);
    const similar = catalog.similarTo([1], { exclude: { ids: [], authors: ['Brandon Sanderson'] }, limit: 10 });
    assert.deepEqual(similar.map((c) => [c.title, c.sharedThreads]), [
      ['The Lies of Locke Lamora', 15],
      ['The Wheel of Time', 20],
      ['Legends & Lattes', 1],
    ]);
    assert.deepEqual(similar[0].excerpts, ['Loved book 3.', 'Loved book 3.']);
    assert.match(similar[0].link ?? '', /^https:\/\/www\.reddit\.com\/r\/Fantasy\//);
  });

  it('leaves out excluded titles, and keeps same-author titles unless excluded', () => {
    const catalog = openSqliteBookCatalog(fantasyDb().file);
    const similar = catalog.similarTo([1], { exclude: { ids: [3], authors: [] }, limit: 2 });
    assert.deepEqual(similar.map((c) => c.title), ['The Stormlight Archive', 'The Wheel of Time']);
  });

  it('ranks a title close to several anchors above one close to a single anchor', () => {
    const catalog = openSqliteBookCatalog(fantasyDb().file);
    const similar = catalog.similarTo([1, 7], { exclude: none, limit: 10 });
    assert.deepEqual(similar.map((c) => [c.title, c.sharedThreads]), [
      ['The Lies of Locke Lamora', 20],
      ['The Wheel of Time', 22],
      ['The Stormlight Archive', 35],
    ]);
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

/** reddit-bot's test/titleKey.test.ts holds the same vectors: keep the two lists equal. */
const TITLE_KEY_VECTORS: [string, string][] = [
  ['The Stormlight Archive', 'stormlight'],
  ['Stormlight Archives series', 'stormlight'],
  ['The Stormlight series', 'stormlight'],
  ['Stormlight 1-5', 'stormlight'],
  ['stormlight', 'stormlight'],
  ['The Kingkiller Chronicle', 'kingkiller'],
  ['The First Law trilogy', 'first law'],
  ['The Earthsea Cycle', 'earthsea'],
  ['Mistborn books 1-3', 'mistborn'],
  ['The Wheel of Time', 'wheel of time'],
  ['A Song of Ice and Fire', 'song of ice and fire'],
  ['Legends & Lattes', 'legends and lattes'],
  ['Kushiel’s Dart', 'kushiels dart'],
  ['Les Misérables', 'les miserables'],
  ['Stormlight 4', 'stormlight 4'],
  ['The Series', 'series'],
];

describe('titleKey', () => {
  it("computes reddit-bot's Title key", () => {
    for (const [name, key] of TITLE_KEY_VECTORS) assert.equal(titleKey(name), key, name);
  });
});

describe('sqliteBookCatalog popularity', () => {
  it('ranks a widely read, well-liked title above a small near-perfect one, and counts neutral Mentions', () => {
    const db = createBookDb(
      [
        { id: 1, title: 'Niche Gem' },
        { id: 2, title: 'Famous Classic' },
        { id: 3, title: 'Divisive' },
      ],
      [
        { bookId: 1, threads: 30 },
        { bookId: 2, threads: 300 },
        { bookId: 2, threads: 100, from: 300, sentiment: 'neutral' },
        { bookId: 2, threads: 30, from: 400, sentiment: 'negative' },
        { bookId: 3, threads: 100 },
        { bookId: 3, threads: 300, from: 100, sentiment: 'neutral' },
        { bookId: 3, threads: 600, from: 400, sentiment: 'negative' },
      ],
    );
    const catalog = openSqliteBookCatalog(db.file);
    assert.deepEqual(catalog.popular({ genre: null, exclude: none, limit: 3 }).map((c) => c.title),
      ['Famous Classic', 'Niche Gem', 'Divisive']);
  });
});

describe('sqliteBookCatalog optional views', () => {
  const titles = [
    { id: 1, title: 'Mistborn', author: 'Brandon Sanderson', kind: 'series' as const },
    { id: 2, title: 'The Final Empire', author: 'Brandon Sanderson' },
    { id: 3, title: 'The Well of Ascension', author: 'Brandon Sanderson' },
    { id: 4, title: 'The Kingkiller Chronicle', author: 'Patrick Rothfuss', kind: 'series' as const },
    { id: 5, title: "The Wise Man's Fear", author: 'Patrick Rothfuss' },
    { id: 6, title: 'The Name of the Wind', author: 'Patrick Rothfuss' },
    { id: 7, title: 'The Blade Itself', author: 'Joe Abercrombie' },
    { id: 8, title: 'Legends & Lattes', author: 'Travis Baldree' },
  ];
  const mentions = titles.map((t, i) => ({ bookId: t.id, threads: 80 - 5 * i, from: 1000 * t.id }));
  const similar = [
    { anchor: 7, title: 5, score: 0.9 },
    { anchor: 7, title: 4, score: 0.8 },
    { anchor: 7, title: 1, score: 0.7 },
    { anchor: 7, title: 8, score: 0.1 },
  ];
  const extras = {
    tags: [
      { title: 8, tag: 'tone:warm' },
      { title: 1, tag: 'tone:dark', confidence: 0.55 },
      { title: 7, tag: 'tone:dark' },
    ],
    vocabulary: [{ tag: 'tone:dark', description: 'grim, violent' }, { tag: 'tone:warm', description: 'kind, cozy' }],
    dossiers: [{ title: 4, praise: ['gorgeous prose'], complaints: ['unfinished'] }],
    seriesBooks: [
      { series: 1, book: 2, position: 1 },
      { series: 1, book: 3, position: 2 },
      { series: 4, book: 6, position: 1 },
      { series: 4, book: 5, position: 2 },
    ],
  };

  it('works without them: no tags, excerpts instead of a Dossier, no Series collapse', () => {
    const catalog = openSqliteBookCatalog(createBookDb(titles, mentions, similar).file);
    const out = catalog.similarTo([7], { exclude: none, limit: 10 });
    assert.deepEqual(out.map((c) => c.id), [5, 4, 1, 8]);
    assert.deepEqual([out[1]!.tags, out[1]!.dossier, out[1]!.startWith, out[1]!.excerpts.length], [[], null, null, 2]);
    assert.deepEqual(catalog.vocabulary(), []);
  });

  it('collapses a Series and its own Books, says which Book starts it, and gives the Dossier', () => {
    const catalog = openSqliteBookCatalog(createBookDb(titles, mentions, similar, extras).file);
    const out = catalog.similarTo([7], { exclude: none, limit: 10 });
    assert.deepEqual(out.map((c) => c.id), [5, 1, 8]);
    assert.equal(out[1]!.startWith, 'The Final Empire');
    const ranked = catalog.popular({ genre: null, exclude: none, limit: 10 });
    assert.deepEqual(ranked.filter((c) => [4, 5, 6].includes(c.id)).map((c) => [c.id, c.startWith]), [[4, 'The Name of the Wind']]);
    const popular = catalog.popular({ genre: null, exclude: { ids: [1], authors: [] }, limit: 10 });
    assert.ok(!popular.some((c) => [1, 2, 3].includes(c.id)), 'excluding a Series excludes its Books');
    const withDossier = catalog.similarTo([7], { exclude: { ids: [5], authors: [] }, limit: 10 });
    assert.ok(!withDossier.some((c) => c.id === 4), "excluding a Book excludes its Series");
  });

  it('gives Dossiers in place of excerpts', () => {
    const catalog = openSqliteBookCatalog(createBookDb(titles, mentions, [{ anchor: 7, title: 4, score: 1 }], { dossiers: extras.dossiers }).file);
    const [c] = catalog.similarTo([7], { exclude: none, limit: 1 });
    assert.deepEqual(c!.dossier, { praise: ['gorgeous prose'], complaints: ['unfinished'], advice: [], comparisons: [] });
    assert.deepEqual(c!.excerpts, []);
    assert.match(c!.link ?? '', /reddit\.com/);
  });

  it('ranks wanted tags first, keeps only tagged titles in popular, and ignores tags under 0.6', () => {
    const catalog = openSqliteBookCatalog(createBookDb(titles, mentions, similar, extras).file);
    assert.deepEqual(catalog.similarTo([7], { exclude: none, limit: 10, tags: ['tone:warm'] }).map((c) => c.id), [8, 5, 1]);
    assert.deepEqual(catalog.popular({ genre: null, exclude: none, limit: 10, tags: ['tone:dark'] }).map((c) => c.id), [7]);
    assert.deepEqual(catalog.vocabulary(), [
      { tag: 'tone:dark', description: 'grim, violent' },
      { tag: 'tone:warm', description: 'kind, cozy' },
    ]);
  });
});
