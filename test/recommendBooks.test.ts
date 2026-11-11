import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBookRecommender, NOT_ENOUGH_DATA } from '../whatsapp/books/recommendBooks.ts';
import { openSqliteBookCatalog } from '../whatsapp/books/sqliteBookCatalog.ts';
import { createBookDb } from './helpers/bookDb.ts';

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
    assert.deepEqual(await recommend('what should I read next'), { kind: 'answer', text: NOT_ENOUGH_DATA });
    assert.equal(model.prompts.length, 1);
  });

  it('says there is not enough data when the model picks nothing usable', async () => {
    const model = fakeModel(request({}), { picks: [{ id: 999, reason: 'invented' }] });
    const recommend = createBookRecommender({ catalog: catalog(), complete: model.complete });
    assert.deepEqual(await recommend('what should I read next'), { kind: 'answer', text: NOT_ENOUGH_DATA });
  });

  it('reads JSON wrapped in reasoning text', async () => {
    const recommend = createBookRecommender({
      catalog: catalog(),
      complete: async () => '<think>{"maybe": true}</think>\nSure: {"notRequest": true}',
    });
    assert.deepEqual(await recommend('nice weather'), { kind: 'not_a_request' });
  });
});
