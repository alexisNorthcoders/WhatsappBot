import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ftsQuery, poolAnswers } from '../whatsapp/books/askRetrieval.ts';
import { openSqliteBookCatalog } from '../whatsapp/books/sqliteBookCatalog.ts';
import { createBookDb, type FixtureAsk } from './helpers/bookDb.ts';

const titles = [
  { id: 1, title: 'Mistborn', author: 'Brandon Sanderson', kind: 'series' as const },
  { id: 2, title: 'The Wheel of Time', author: 'Robert Jordan', kind: 'series' as const },
  { id: 3, title: 'The Lies of Locke Lamora', author: 'Scott Lynch' },
  { id: 4, title: 'The Stormlight Archive', author: 'Brandon Sanderson', kind: 'series' as const },
  { id: 5, title: 'Gideon the Ninth', author: 'Tamsyn Muir' },
  { id: 7, title: 'Legends & Lattes', author: 'Travis Baldree' },
  { id: 8, title: 'The House in the Cerulean Sea', author: 'TJ Klune' },
];
const mentions = titles.map((t, i) => ({ bookId: t.id, threads: 10, from: i * 100 }));

const asks: FixtureAsk[] = [
  {
    thread: 'a1', title: 'books like mistborn with heists', likes: [1],
    answers: [
      { title: 3, support: 10, redditors: 5 },
      { title: 2, support: 12, redditors: 6, against: 10 },
      { title: 4, support: 8, redditors: 4 },
    ],
  },
  { thread: 'a2', title: 'cozy low stakes', likes: [7], wants: ['subgenre:cozy'], answers: [{ title: 8, support: 5, redditors: 3 }] },
  { thread: 'a3', title: 'anything but mistborn please', unlikes: [1], answers: [{ title: 5, support: 50, redditors: 9 }] },
];

const none = { ids: [], authors: [] };

describe('ftsQuery', () => {
  it('keeps distinct content words, quoted and OR-joined, and drops stopwords and short words', () => {
    assert.equal(ftsQuery('Something like Mistborn, but DARKER... mistborn!'), '"mistborn" OR "darker"');
    assert.equal(ftsQuery('what should I read next'), '"should" OR "next"');
    assert.equal(ftsQuery('a book for my kid'), '"kid"');
    assert.equal(ftsQuery('Naïve "quotes" AND NOT x'), '"naive" OR "quotes"');
    assert.equal(ftsQuery(''), '');
  });
});

describe('poolAnswers', () => {
  it('weights answers by ask score, sums across asks, and demotes by the share arguing against', () => {
    const ranked = [
      { threadId: 'x', title: 'X', permalink: null, score: 2 },
      { threadId: 'y', title: 'Y', permalink: null, score: 1 },
    ];
    const answers: Record<string, { titleId: number; support: number; redditors: number; against: number }[]> = {
      x: [{ titleId: 1, support: 3, redditors: 2, against: 0 }, { titleId: 2, support: 10, redditors: 1, against: 3 }],
      y: [{ titleId: 1, support: 4, redditors: 2, against: 0 }],
    };
    const pooled = poolAnswers(ranked, (id) => answers[id]!);
    assert.deepEqual(pooled.map((p) => [p.titleId, p.rank, p.redditors, p.asks, p.best.threadId]), [
      [1, 10, 4, 2, 'x'],
      [2, 5, 1, 1, 'x'],
    ]);
  });
});

describe('sqliteBookCatalog answeredFor', () => {
  it('is empty on a DB without the ask index', () => {
    const catalog = openSqliteBookCatalog(createBookDb(titles, mentions).file);
    assert.deepEqual(catalog.answeredFor({ likes: [1], unlikes: [], wants: [], avoids: [], text: 'like Mistborn' }, { exclude: none, limit: 10 }), []);
  });

  it("pools what similar asks answered, demotes rebuttals, skips asks unlike the reader's, and links the ask", () => {
    const catalog = openSqliteBookCatalog(createBookDb(titles, mentions, [], { asks }).file);
    const out = catalog.answeredFor(
      { likes: [1], unlikes: [], wants: [], avoids: [], text: 'something like Mistborn' },
      { exclude: { ids: [1], authors: ['Brandon Sanderson'] }, limit: 10 },
    );
    assert.deepEqual(out.map((c) => c.id), [3, 2], 'Locke beats the rebutted WoT; Stormlight is by an excluded author; the unlike-Mistborn ask is not pooled');
    assert.deepEqual(out[0]!.answered, {
      redditors: 5, against: 0, asks: 1,
      example: { title: 'books like mistborn with heists', link: 'https://www.reddit.com/r/Fantasy/comments/a1/ask/' },
    });
    assert.equal(out[0]!.link, 'https://www.reddit.com/r/Fantasy/comments/a1/ask/');
    assert.equal(out[1]!.answered!.against, 10);
  });

  it('pools only asks for the same audience when the reader names one', () => {
    const kids: FixtureAsk[] = [
      { thread: 'adult', title: 'like mistborn for a prison book club', likes: [1], answers: [{ title: 3, support: 30, redditors: 8 }] },
      { thread: 'kid', title: 'for my 9 year old', wants: ['audience:middle_grade'], answers: [{ title: 8, support: 2, redditors: 2 }] },
    ];
    const catalog = openSqliteBookCatalog(createBookDb(titles, mentions, [], { asks: kids }).file);
    const query = { likes: [1], unlikes: [], avoids: [], text: 'for a 10 year old who loved Mistborn' };
    assert.deepEqual(catalog.answeredFor({ ...query, wants: ['audience:middle_grade'] }, { exclude: none, limit: 10 }).map((c) => c.id), [8]);
    assert.equal(catalog.answeredFor({ ...query, wants: [] }, { exclude: none, limit: 10 })[0]!.id, 3, 'without an age the adult ask leads');
  });

  it('retrieves by tags and by unlikes', () => {
    const catalog = openSqliteBookCatalog(createBookDb(titles, mentions, [], { asks }).file);
    const query = { likes: [], unlikes: [], wants: [], avoids: [], text: '' };
    assert.deepEqual(catalog.answeredFor({ ...query, wants: ['subgenre:cozy'] }, { exclude: none, limit: 10 }).map((c) => c.id), [8]);
    assert.deepEqual(catalog.answeredFor({ ...query, unlikes: [1] }, { exclude: none, limit: 10 }).map((c) => c.id), [5]);
  });
});
