import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBookRecommender, NOT_ENOUGH_DATA } from '../whatsapp/books/recommendBooks.ts';
import { openSqliteBookCatalog } from '../whatsapp/books/sqliteBookCatalog.ts';
import { createBookDb } from './helpers/bookDb.ts';
import type { ReadingProfile } from '../whatsapp/books/readingProfile.ts';

function catalog() {
  const db = createBookDb(
    [
      { id: 1, title: 'Mistborn', author: 'Brandon Sanderson', kind: 'series' },
      { id: 2, title: 'The Stormlight Archive', author: 'Brandon Sanderson', kind: 'series' },
      { id: 3, title: 'The Lies of Locke Lamora', author: 'Scott Lynch' },
      { id: 4, title: 'The Black Company', author: 'Glen Cook', genre: 'grimdark' },
      { id: 5, title: 'Prince of Thorns', author: 'Mark Lawrence', genre: 'grimdark' },
      { id: 6, title: 'The Blade Itself', author: 'Joe Abercrombie', genre: 'grimdark' },
    ],
    [
      { bookId: 1, threads: 60 },
      { bookId: 2, threads: 50 },
      { bookId: 3, threads: 40 },
      { bookId: 4, threads: 35, from: 20 },
      { bookId: 5, threads: 30, from: 30 },
      { bookId: 6, threads: 40, from: 200 },
    ],
    [
      { anchor: 1, title: 2, score: 0.5 },
      { anchor: 1, title: 3, score: 0.4 },
      { anchor: 1, title: 4, score: 0.3 },
      { anchor: 1, title: 5, score: 0.2 },
    ],
  );
  return openSqliteBookCatalog(db.file);
}

/** A model that answers the parse prompt with `parse` and the pick prompt with `pick`. */
function fakeModel(parse: object, pick: object = { picks: [] }) {
  const prompts: string[] = [];
  const complete = async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify(prompt.startsWith('You pick') ? pick : parse);
  };
  return { complete, prompts };
}

const request = (fields: object) => ({ anchors: [], genre: null, excludeTitles: [], excludeAuthors: [], ...fields });

describe('createBookRecommender', () => {
  it('says not_a_request without querying for picks', async () => {
    const model = fakeModel({ notRequest: true });
    const recommend = createBookRecommender({ catalog: catalog(), complete: model.complete });
    assert.deepEqual(await recommend('finished my book today'), { kind: 'not_a_request' });
    assert.equal(model.prompts.length, 1);
  });

  it("for 'like X', shortlists what's discussed with X minus X's author, and formats the picks", async () => {
    const model = fakeModel(
      request({ anchors: ['mistborn'] }),
      { picks: [{ id: 3, reason: 'Heists and banter, like Mistborn.' }, { id: 999, reason: 'invented' }, { id: 4, reason: 'Darker.' }] },
    );
    const recommend = createBookRecommender({ catalog: catalog(), complete: model.complete });
    const result = await recommend('something like Mistborn but darker');

    const shortlisted = model.prompts[1];
    assert.match(shortlisted, /The Lies of Locke Lamora/);
    assert.doesNotMatch(shortlisted, /Stormlight|"Mistborn"/);
    assert.equal(result.kind, 'answer');
    const text = result.kind === 'answer' ? result.text : '';
    const link = /\nhttps:\/\/www\.reddit\.com\/r\/Fantasy\/comments\/\w+\/x\/c(\d)\//g;
    assert.deepEqual([...text.matchAll(link)].map((m) => m[1]), ['3', '4']);
    assert.equal(text.replace(link, ''), [
      '1. *The Lies of Locke Lamora* by Scott Lynch\nHeists and banter, like Mistborn.\n40 mentions on r/Fantasy, 100% positive',
      '2. *The Black Company* by Glen Cook\nDarker.\n35 mentions on r/Fantasy, 100% positive',
    ].join('\n\n'));
  });

  it('notes an unknown anchor and falls back to the genre', async () => {
    const model = fakeModel(request({ anchors: ['Unheard Of'], genre: 'grimdark' }), { picks: [{ id: 6, reason: 'Grim.' }] });
    const recommend = createBookRecommender({ catalog: catalog(), complete: model.complete });
    const result = await recommend('like Unheard Of, but grimdark');
    assert.equal(result.kind === 'answer' && result.text.split('\n')[0], "I don't have data on Unheard Of.");
    assert.match(model.prompts[1], /Prince of Thorns/);
    assert.doesNotMatch(model.prompts[1], /Locke Lamora/);
  });

  it('ignores a genre the catalog does not know', async () => {
    const model = fakeModel(request({ genre: 'space_opera' }), { picks: [{ id: 1, reason: 'Classic.' }] });
    const recommend = createBookRecommender({ catalog: catalog(), complete: model.complete });
    await recommend('recommend a space opera');
    assert.match(model.prompts[1], /Locke Lamora/);
  });

  it('says there is not enough data when too few titles are left, without asking the model to pick', async () => {
    const model = fakeModel(request({ excludeAuthors: ['Sanderson', 'Scott Lynch', 'Glen Cook', 'Mark Lawrence'] }));
    const recommend = createBookRecommender({ catalog: catalog(), complete: model.complete });
    assert.deepEqual(await recommend('what should I read next'), { kind: 'answer', text: NOT_ENOUGH_DATA, picks: [] });
    assert.equal(model.prompts.length, 1);
  });

  it('says there is not enough data when the model picks nothing usable', async () => {
    const model = fakeModel(request({}), { picks: [{ id: 999, reason: 'invented' }] });
    const recommend = createBookRecommender({ catalog: catalog(), complete: model.complete });
    assert.deepEqual(await recommend('what should I read next'), { kind: 'answer', text: NOT_ENOUGH_DATA, picks: [] });
  });

  it('reads JSON wrapped in reasoning text', async () => {
    const recommend = createBookRecommender({
      catalog: catalog(),
      complete: async () => '<think>{"maybe": true}</think>\nSure: {"notRequest": true}',
    });
    assert.deepEqual(await recommend('nice weather'), { kind: 'not_a_request' });
  });
});

function memoryProfile(initial: ReadingProfile = { shelf: [], recent: [] }) {
  let p = initial;
  return { load: async () => p, save: async (next: ReadingProfile) => void (p = next), get: () => p };
}

describe('createBookRecommender with tags and a reading profile', () => {
  function taggedCatalog() {
    const db = createBookDb(
      [
        { id: 1, title: 'Mistborn', author: 'Brandon Sanderson', kind: 'series' },
        { id: 3, title: 'The Lies of Locke Lamora', author: 'Scott Lynch' },
        { id: 4, title: 'The Black Company', author: 'Glen Cook' },
        { id: 5, title: 'Prince of Thorns', author: 'Mark Lawrence' },
        { id: 6, title: 'The Blade Itself', author: 'Joe Abercrombie' },
        { id: 7, title: 'Legends & Lattes', author: 'Travis Baldree' },
        { id: 8, title: 'The Final Empire', author: 'Brandon Sanderson' },
      ],
      [1, 3, 4, 5, 6, 7, 8].map((id, i) => ({ bookId: id, threads: 60 - 5 * i, from: 100 * id })),
      [
        { anchor: 1, title: 3, score: 0.5 },
        { anchor: 1, title: 4, score: 0.4 },
        { anchor: 1, title: 5, score: 0.3 },
        { anchor: 1, title: 7, score: 0.2 },
        { anchor: 7, title: 3, score: 0.9 },
        { anchor: 7, title: 4, score: 0.8 },
        { anchor: 7, title: 6, score: 0.7 },
        { anchor: 7, title: 5, score: 0.6 },
        { anchor: 7, title: 1, score: 0.5 },
      ],
      {
        tags: [{ title: 4, tag: 'tone:dark' }, { title: 5, tag: 'tone:dark' }, { title: 6, tag: 'tone:dark' }],
        vocabulary: [{ tag: 'tone:dark', description: 'grim' }, { tag: 'tone:warm', description: 'cozy' }],
        dossiers: [{ title: 4, praise: ['soldiers as family'] }],
        seriesBooks: [{ series: 1, book: 8, position: 1 }],
      },
    );
    return openSqliteBookCatalog(db.file);
  }

  it('offers the vocabulary to the parser, keeps only known tags, and ranks tagged candidates first', async () => {
    const model = fakeModel(request({ anchors: ['Mistborn'], tags: ['tone:dark', 'tone:invented'] }), { picks: [{ id: 4, reason: 'Grim.' }] });
    const recommend = createBookRecommender({ catalog: taggedCatalog(), complete: model.complete });
    await recommend('something like Mistborn but darker');
    assert.match(model.prompts[0]!, /tone:dark \(grim\)/);
    const listed = JSON.parse(model.prompts[1]!.split('Candidates: ')[1]!) as { id: number; what_redditors_say?: unknown }[];
    assert.deepEqual(listed.map((c) => c.id), [4, 5, 3, 7, 6], 'dark neighbours first, then a dark popular title as fill');
    assert.deepEqual(listed[0]!.what_redditors_say, { praise: ['soldiers as family'], complaints: [], advice: [], comparisons: [] });
    assert.match(model.prompts[1]!, /The reader asked for: tone:dark\./);
  });

  it('leaves out the shelf and recent picks, starts open asks from loved titles, and records its picks', async () => {
    const now = 1_000_000_000_000;
    const profile = memoryProfile({
      shelf: [{ id: 7, title: 'Legends & Lattes', status: 'loved', at: now }, { id: 3, title: 'The Lies of Locke Lamora', status: 'read', at: now }],
      recent: [{ id: 6, title: 'The Blade Itself', at: now - 1000 }],
    });
    const model = fakeModel(request({}), { picks: [{ id: 4, reason: 'Found family.' }] });
    const recommend = createBookRecommender({ catalog: taggedCatalog(), complete: model.complete, profile, now: () => now });
    const result = await recommend('what should I read next');
    assert.deepEqual(result.kind === 'answer' && result.picks.map((p) => p.candidate.id), [4]);
    const listed = (JSON.parse(model.prompts[1]!.split('Candidates: ')[1]!) as { id: number }[]).map((c) => c.id);
    assert.ok(!listed.some((id) => [3, 6, 7].includes(id)), `shelf and recent left out: ${listed}`);
    assert.match(model.prompts[1]!, /The reader loved Legends & Lattes/);
    assert.deepEqual(profile.get().recent.map((r) => r.id), [6, 4]);
  });

  it('says which Book starts a picked Series', async () => {
    const model = fakeModel(request({ anchors: ['Locke Lamora'] }), { picks: [{ id: 1, reason: 'Heists.' }] });
    const db = createBookDb(
      [{ id: 1, title: 'Mistborn', kind: 'series' }, { id: 2, title: 'The Final Empire' }, { id: 3, title: 'Locke Lamora' }, { id: 4, title: 'A' }, { id: 5, title: 'B' }],
      [1, 2, 3, 4, 5].map((id) => ({ bookId: id, threads: 10, from: 100 * id })),
      [{ anchor: 3, title: 1, score: 0.9 }, { anchor: 3, title: 4, score: 0.5 }, { anchor: 3, title: 5, score: 0.4 }],
      { seriesBooks: [{ series: 1, book: 2, position: 1 }] },
    );
    const recommend = createBookRecommender({ catalog: openSqliteBookCatalog(db.file), complete: model.complete });
    const result = await recommend('like Locke Lamora');
    assert.match(result.kind === 'answer' ? result.text : '', /^1\. \*Mistborn\* \(series\)\nHeists\.\nStart with \*The Final Empire\*\.\n10 mentions/);
  });
});

describe('createBookRecommender tag fill', () => {
  it('adds best-liked titles carrying a wanted tag when few of the neighbours do', async () => {
    const db = createBookDb(
      [{ id: 1, title: 'Epic', author: 'A' }, { id: 2, title: 'N1', author: 'B' }, { id: 3, title: 'N2', author: 'C' }, { id: 4, title: 'N3', author: 'D' }, { id: 5, title: 'Short One', author: 'E' }],
      [1, 2, 3, 4, 5].map((id) => ({ bookId: id, threads: 20, from: 100 * id })),
      [{ anchor: 1, title: 2, score: 0.9 }, { anchor: 1, title: 3, score: 0.8 }, { anchor: 1, title: 4, score: 0.7 }],
      { tags: [{ title: 5, tag: 'format:standalone' }], vocabulary: [{ tag: 'format:standalone' }] },
    );
    const model = fakeModel(request({ anchors: ['Epic'], tags: ['format:standalone'] }), { picks: [{ id: 5, reason: 'Short.' }] });
    const recommend = createBookRecommender({ catalog: openSqliteBookCatalog(db.file), complete: model.complete });
    await recommend('like Epic but a standalone');
    const listed = (JSON.parse(model.prompts[1]!.split('Candidates: ')[1]!) as { id: number }[]).map((c) => c.id);
    assert.deepEqual(listed, [2, 3, 4, 5]);
  });
});
