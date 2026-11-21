import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createReadingProfile,
  excludedIds,
  fileReadingProfileStore,
  parseProfileCommand,
  RECENT_DAYS,
  withPicks,
  type ReadingProfile,
} from '../whatsapp/books/readingProfile.ts';
import type { Title } from '../whatsapp/books/bookCatalog.ts';

const title = (id: number, name: string): Title =>
  ({ id, title: name, author: null, kind: 'book', genre: null, mentions: 10, positive: 10, negative: 0 });
const CATALOG: Record<string, Title> = {
  mistborn: title(1, 'Mistborn'),
  piranesi: title(2, 'Piranesi'),
  earthsea: title(3, 'Earthsea'),
  'shadow and bone': title(4, 'Shadow and Bone'),
};
const catalog = { find: (name: string) => CATALOG[name.toLowerCase().trim()] ?? null };
const store = () => fileReadingProfileStore(path.join(mkdtempSync(path.join(tmpdir(), 'profile-')), 'books', 'profile.json'));

describe('parseProfileCommand', () => {
  it('reads shelf statements, show, clear and forget', () => {
    const cases: [string, unknown][] = [
      ["I've read Mistborn", { kind: 'shelve', status: 'read', names: ['Mistborn'] }],
      ['I have already read Mistborn, Piranesi and Earthsea.', { kind: 'shelve', status: 'read', names: ['Mistborn', 'Piranesi and Earthsea'] }],
      ['finished Piranesi', { kind: 'shelve', status: 'read', names: ['Piranesi'] }],
      ['loved Piranesi', { kind: 'shelve', status: 'loved', names: ['Piranesi'] }],
      ['I really loved Earthsea!', { kind: 'shelve', status: 'loved', names: ['Earthsea'] }],
      ['DNF Mistborn', { kind: 'shelve', status: 'dnf', names: ['Mistborn'] }],
      ["I didn't finish Mistborn", { kind: 'shelve', status: 'dnf', names: ['Mistborn'] }],
      ['gave up on Mistborn', { kind: 'shelve', status: 'dnf', names: ['Mistborn'] }],
      ['show my reading profile', { kind: 'show' }],
      ['my bookshelf', { kind: 'show' }],
      ['what have I read?', { kind: 'show' }],
      ['clear my reading profile', { kind: 'clear' }],
      ['forget Mistborn from my reading profile', { kind: 'forget', names: ['Mistborn'] }],
    ];
    for (const [text, want] of cases) assert.deepEqual(parseProfileCommand(text), want, text);
  });

  it('leaves requests and chat to the recommender', () => {
    for (const text of [
      'I loved Piranesi, what else would I like?',
      "I've read Mistborn, recommend something similar",
      'I read your message',
      'read the docs',
      'I love you',
      'what should I read next',
    ]) {
      assert.equal(parseProfileCommand(text), null, text);
    }
  });
});

describe('createReadingProfile', () => {
  it('shelves, shows, forgets and clears, persisting to the file', async () => {
    const s = store();
    const handle = createReadingProfile({ store: s, catalog, now: () => 5 });
    assert.match((await handle('I have read Mistborn, Piranesi and Earthsea'))!, /Noted: you read \*Mistborn\*, \*Piranesi\*, \*Earthsea\*/);
    assert.match((await handle('loved Piranesi'))!, /open asks will start from it/);
    assert.match((await handle('loved Shadow and Bone'))!, /\*Shadow and Bone\*/);
    assert.equal(await handle('show my reading profile'),
      '*Loved:* Piranesi, Shadow and Bone\n*Read:* Mistborn, Earthsea');
    assert.equal(await handle('forget Mistborn from my reading profile'), 'Removed Mistborn.');
    assert.deepEqual((await s.load()).shelf.map((e) => [e.id, e.status]), [[3, 'read'], [2, 'loved'], [4, 'loved']]);
    assert.match((await handle('clear my reading profile'))!, /Cleared/);
    assert.deepEqual(await s.load(), { shelf: [], recent: [] });
  });

  it('notes unknown names, and lets a statement naming nothing it knows fall through', async () => {
    const handle = createReadingProfile({ store: store(), catalog });
    assert.equal(await handle("I've read Mistborn, Unheard Of"), "I don't have data on Unheard Of.\nNoted: you read *Mistborn*. I won't recommend it.");
    assert.equal(await handle('finished my homework'), null);
  });
});

describe('reading profile exclusions', () => {
  it(`excludes the shelf and picks from the last ${RECENT_DAYS} days`, () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    let p: ReadingProfile = { shelf: [{ id: 1, title: 'Mistborn', status: 'dnf', at: 0 }], recent: [{ id: 9, title: 'Old', at: now - 31 * day }] };
    p = withPicks(p, [title(2, 'Piranesi')], now);
    assert.deepEqual(excludedIds(p, now), [1, 2]);
    assert.deepEqual(excludedIds(p, now + 31 * day), [1]);
  });
});
