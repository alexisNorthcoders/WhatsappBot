import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { atMostOneBy, createBookRecommender, NOT_ENOUGH_DATA } from '../whatsapp/books/recommendBooks.ts';
import type { Backend, BookPick, Completion } from '../whatsapp/books/recommendBooks.ts';
import { withFallback } from '../whatsapp/books/haikuComplete.ts';
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
function fakeModel(parse: object, pick: object = { picks: [] }, backend: Backend = 'minipc') {
  const prompts: string[] = [];
  const complete = async (prompt: string): Promise<Completion> => {
    prompts.push(prompt);
    return { text: JSON.stringify(prompt.startsWith('You pick') ? pick : parse), backend };
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
      complete: async () => ({ text: '<think>{"maybe": true}</think>\nSure: {"notRequest": true}', backend: 'minipc' }),
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

describe('createBookRecommender anchor guard', () => {
  function guardCatalog() {
    const db = createBookDb(
      [
        { id: 1, title: 'Cradle', author: 'A', genre: 'progression' },
        { id: 2, title: 'N1', author: 'B', genre: 'progression' },
        { id: 3, title: 'N2', author: 'C', genre: 'progression' },
        { id: 4, title: 'N3', author: 'D', genre: 'progression' },
        { id: 5, title: 'Grim One', author: 'E', genre: 'grimdark' },
        { id: 6, title: 'Grim Two', author: 'F', genre: 'grimdark' },
        { id: 7, title: 'Grim Three', author: 'G', genre: 'grimdark' },
      ],
      [1, 2, 3, 4, 5, 6, 7].map((id) => ({ bookId: id, threads: 20, from: 100 * id })),
      [{ anchor: 1, title: 2, score: 0.9 }, { anchor: 1, title: 3, score: 0.8 }, { anchor: 1, title: 4, score: 0.7 }],
      {
        tags: [{ title: 1, tag: 'tone:hopeful' }, { title: 1, tag: 'pacing:fast' }, { title: 3, tag: 'tone:dark' }],
        vocabulary: [{ tag: 'tone:hopeful' }, { tag: 'pacing:fast' }, { tag: 'tone:dark' }],
      },
    );
    return openSqliteBookCatalog(db.file);
  }

  it("drops the tags a named Book carries and the genre, keeping the reader's own wishes", async () => {
    const logged: Record<string, unknown>[] = [];
    const model = fakeModel(
      request({ anchors: ['Cradle'], genre: 'grimdark', tags: ['tone:hopeful', 'pacing:fast', 'tone:dark'] }),
      { picks: [{ id: 3, reason: 'Darker.' }] },
    );
    const recommend = createBookRecommender({ catalog: guardCatalog(), complete: model.complete, logger: { info: (o) => logged.push(o as Record<string, unknown>) } });
    await recommend('like Cradle but darker');
    const listed = (JSON.parse(model.prompts[1]!.split('Candidates: ')[1]!) as { id: number }[]).map((c) => c.id);
    assert.deepEqual(listed.slice(0, 3), [3, 2, 4], "Cradle's neighbours, the dark one first; no grimdark genre list");
    assert.match(model.prompts[1]!, /The reader asked for: tone:dark\./);
    assert.deepEqual(
      [(logged[0]!.request as { genre: unknown; tags: unknown }).genre, (logged[0]!.request as { tags: unknown }).tags, logged[0]!.parsed],
      [null, ['tone:dark'], { genre: 'grimdark', tags: ['tone:hopeful', 'pacing:fast', 'tone:dark'] }],
    );
  });

  it('keeps what Claude parsed, but guards the mini PC fallback when Claude fails', async () => {
    const parse = request({ anchors: ['Cradle'], genre: 'grimdark', tags: ['tone:hopeful', 'tone:dark'] });
    const requests: unknown[] = [];
    const logger = { info: (o: unknown) => requests.push((o as { request: unknown; parsedBy: unknown }).request) };
    const claude = fakeModel(parse, { picks: [] }, 'claude');
    await createBookRecommender({ catalog: guardCatalog(), complete: claude.complete, logger })('like Cradle but darker');
    const minipc = fakeModel(parse, { picks: [] });
    const failing = async (): Promise<Completion> => {
      throw new Error('overloaded');
    };
    await createBookRecommender({ catalog: guardCatalog(), complete: withFallback(failing, minipc.complete), logger })('like Cradle but darker');
    assert.deepEqual(
      requests.map((r) => [(r as { genre: unknown }).genre, (r as { tags: unknown }).tags]),
      [['grimdark', ['tone:hopeful', 'tone:dark']], [null, ['tone:dark']]],
    );
  });

  it('keeps the genre and tags when no named Book resolves', async () => {
    const model = fakeModel(request({ genre: 'grimdark', tags: ['tone:hopeful'] }), { picks: [] });
    const recommend = createBookRecommender({ catalog: guardCatalog(), complete: model.complete });
    await recommend('a hopeful grimdark book');
    assert.match(model.prompts[1] ?? '', /The reader asked for: tone:hopeful\./);
    const listed = (JSON.parse(model.prompts[1]!.split('Candidates: ')[1]!) as { id: number }[]).map((c) => c.id);
    assert.deepEqual(listed.sort(), [5, 6, 7], 'the grimdark genre still picks the list');
  });
});

describe('loved authors on open asks', () => {
  const pick = (id: number, author: string | null): BookPick => ({ candidate: { id, author } as BookPick['candidate'], reason: '' });

  it('atMostOneBy keeps the first pick by a loved author and drops the rest', () => {
    const picks = [pick(1, 'Other'), pick(2, 'Susanna Clarke'), pick(3, 'Susanna Clarke'), pick(4, null)];
    assert.deepEqual(atMostOneBy(['Susanna Clarke'], picks).map((p) => p.candidate.id), [1, 2, 4]);
    assert.deepEqual(atMostOneBy([], picks).map((p) => p.candidate.id), [1, 2, 3, 4]);
  });

  it('an answer drawn from loved titles has at most one pick by their authors, and the picker is told so', async () => {
    const db = createBookDb(
      [
        { id: 1, title: 'Piranesi', author: 'Susanna Clarke' },
        { id: 2, title: 'Jonathan Strange', author: 'Susanna Clarke' },
        { id: 3, title: 'The Ladies of Grace Adieu', author: 'Susanna Clarke' },
        { id: 4, title: 'Annihilation', author: 'Jeff VanderMeer' },
        { id: 5, title: 'The Raw Shark Texts', author: 'Steven Hall' },
      ],
      [1, 2, 3, 4, 5].map((id) => ({ bookId: id, threads: 20, from: 100 * id })),
      [{ anchor: 1, title: 2, score: 0.9 }, { anchor: 1, title: 3, score: 0.8 }, { anchor: 1, title: 4, score: 0.7 }, { anchor: 1, title: 5, score: 0.6 }],
    );
    const now = 1_000_000_000_000;
    const profile = memoryProfile({ shelf: [{ id: 1, title: 'Piranesi', status: 'loved', at: now }], recent: [] });
    const model = fakeModel(request({}), { picks: [{ id: 2, reason: 'a' }, { id: 3, reason: 'b' }, { id: 4, reason: 'c' }] });
    const recommend = createBookRecommender({ catalog: openSqliteBookCatalog(db.file), complete: model.complete, profile, now: () => now });
    const result = await recommend('what should I read next');
    assert.deepEqual(result.kind === 'answer' && result.picks.map((p) => p.candidate.id), [2, 4]);
    assert.match(model.prompts[1]!, /The reader loved Piranesi; .* Pick at most one book by Susanna Clarke\./);
  });

  it('anchored asks are unaffected: the anchor author is excluded as before', async () => {
    const db = createBookDb(
      [{ id: 1, title: 'Piranesi', author: 'Susanna Clarke' }, { id: 2, title: 'Jonathan Strange', author: 'Susanna Clarke' }, { id: 4, title: 'A', author: 'X' }, { id: 5, title: 'B', author: 'Y' }, { id: 6, title: 'C', author: 'Z' }],
      [1, 2, 4, 5, 6].map((id) => ({ bookId: id, threads: 20, from: 100 * id })),
      [{ anchor: 1, title: 2, score: 0.9 }, { anchor: 1, title: 4, score: 0.7 }, { anchor: 1, title: 5, score: 0.6 }, { anchor: 1, title: 6, score: 0.5 }],
    );
    const model = fakeModel(request({ anchors: ['Piranesi'] }), { picks: [{ id: 4, reason: 'a' }] });
    await createBookRecommender({ catalog: openSqliteBookCatalog(db.file), complete: model.complete })('like Piranesi');
    const listed = (JSON.parse(model.prompts[1]!.split('Candidates: ')[1]!) as { id: number }[]).map((c) => c.id);
    assert.ok(!listed.includes(2));
    assert.doesNotMatch(model.prompts[1]!, /Pick at most one book by/);
  });
});

describe('community answers from similar asks', () => {
  function askedCatalog() {
    const db = createBookDb(
      [
        { id: 1, title: 'Mistborn', author: 'Brandon Sanderson', kind: 'series' },
        { id: 2, title: 'The Stormlight Archive', author: 'Brandon Sanderson', kind: 'series' },
        { id: 3, title: 'The Lies of Locke Lamora', author: 'Scott Lynch' },
        { id: 4, title: 'The Black Company', author: 'Glen Cook' },
        { id: 5, title: 'Prince of Thorns', author: 'Mark Lawrence' },
        { id: 6, title: 'The Blade Itself', author: 'Joe Abercrombie' },
        { id: 7, title: 'Temeraire', author: 'Naomi Novik' },
        { id: 9, title: 'Fourth Wing', author: 'Rebecca Yarros' },
      ],
      [1, 2, 3, 4, 5, 6, 7, 9].map((id) => ({ bookId: id, threads: 30, from: 100 * id })),
      [
        { anchor: 1, title: 2, score: 0.5 },
        { anchor: 1, title: 3, score: 0.4 },
        { anchor: 1, title: 4, score: 0.3 },
        { anchor: 1, title: 5, score: 0.2 },
      ],
      {
        vocabulary: [{ tag: 'trope:dragons', description: 'dragons' }, { tag: 'romance:central', description: 'romance-led' }],
        asks: [
          {
            thread: 'm1', title: 'books like mistborn', likes: [1],
            answers: [{ title: 6, support: 9, redditors: 4 }, { title: 5, support: 20, redditors: 1 }],
          },
          { thread: 'd1', title: 'dragons but not fourth wing', unlikes: [9], wants: ['trope:dragons'], answers: [{ title: 7, support: 6, redditors: 3 }] },
        ],
      },
    );
    return openSqliteBookCatalog(db.file);
  }
  const listed = (prompt: string) => JSON.parse(prompt.split('Candidates: ')[1]!) as { id: number; answered_in_similar_asks?: string }[];

  it('lead the shortlist with their evidence, link the ask, and leave a lone suggestion to the other sources', async () => {
    const model = fakeModel(request({ anchors: ['Mistborn'] }), { picks: [{ id: 6, reason: 'r/Fantasy suggests it to Mistborn fans.' }] });
    const result = await createBookRecommender({ catalog: askedCatalog(), complete: model.complete })('something like Mistborn');
    const candidates = listed(model.prompts[1]!);
    assert.deepEqual(candidates.map((c) => c.id), [6, 3, 4, 5], 'the answer first; Prince of Thorns, one Redditor, stays in its similarity place');
    assert.equal(candidates[0]!.answered_in_similar_asks, 'recommended by 4 Redditors in 1 similar ask, e.g. "books like mistborn"');
    assert.equal(candidates[3]!.answered_in_similar_asks, undefined);
    assert.match(model.prompts[1]!, /answered_in_similar_asks means/);
    assert.match(result.kind === 'answer' ? result.text : '', /\nRecommended by 4 Redditors in 1 similar r\/Fantasy ask\nhttps:\/\/www\.reddit\.com\/r\/Fantasy\/comments\/m1\/ask\/$/);
    assert.match(model.prompts[1]!, /Don't mention past asks/);
  });

  it('retrieves by the books the reader names as unwanted and by avoided tags, and excludes those books', async () => {
    const model = fakeModel(request({ unlike: ['Fourth Wing'], tags: ['trope:dragons'], avoidTags: ['romance:central', 'romance:invented'] }));
    await createBookRecommender({ catalog: askedCatalog(), complete: model.complete })('dragons, but nothing like Fourth Wing');
    assert.match(model.prompts[0]!, /"unlike": string\[\]/);
    assert.match(model.prompts[0]!, /"avoidTags": string\[\]/);
    const candidates = listed(model.prompts[1]!);
    assert.equal(candidates[0]!.id, 7);
    assert.ok(!candidates.some((c) => c.id === 9), 'the unwanted book is never offered');
  });

  it('change nothing when no ask is close: the prompt has no ask line', async () => {
    const model = fakeModel(request({ anchors: ['The Black Company'] }));
    await createBookRecommender({ catalog: askedCatalog(), complete: model.complete })('like the black company');
    assert.equal(model.prompts.length, 2);
    assert.doesNotMatch(model.prompts[1]!, /answered_in_similar_asks/);
  });
});

describe('community answers with a tag fill', () => {
  it('keep the best-liked tagged titles when many untagged neighbours follow the answers', async () => {
    const neighbours = Array.from({ length: 25 }, (_, i) => ({ id: 100 + i, title: `Long Series ${i}`, author: `Author ${i}`, kind: 'series' as const }));
    const db = createBookDb(
      [{ id: 1, title: 'The Wheel of Time', author: 'Robert Jordan', kind: 'series' }, ...neighbours,
        { id: 200, title: 'A Standalone', author: 'Solo One' }, { id: 201, title: 'Another Standalone', author: 'Solo Two' }, { id: 202, title: 'Answered Pick', author: 'Asked For' }],
      [1, ...neighbours.map((n) => n.id), 200, 201, 202].map((id) => ({ bookId: id, threads: 20, from: 100 * id })),
      neighbours.map((n, i) => ({ anchor: 1, title: n.id, score: 1 - i / 100 })),
      {
        tags: [{ title: 200, tag: 'format:standalone' }, { title: 201, tag: 'format:standalone' }],
        vocabulary: [{ tag: 'format:standalone', description: 'a standalone novel' }],
        asks: [{ thread: 'w1', title: 'after wheel of time', likes: [1], answers: [{ title: 202, support: 5, redditors: 3 }] }],
      },
    );
    const model = fakeModel(request({ anchors: ['The Wheel of Time'], tags: ['format:standalone'] }), { picks: [] }, 'claude');
    await createBookRecommender({ catalog: openSqliteBookCatalog(db.file), complete: model.complete })('like Wheel of Time but a standalone');
    const ids = (JSON.parse(model.prompts[1]!.split('Candidates: ')[1]!) as { id: number }[]).map((c) => c.id);
    assert.equal(ids[0], 202, 'the answer leads');
    assert.ok(ids.includes(200) && ids.includes(201), 'the tagged standalones still reach the picker');
  });
});
