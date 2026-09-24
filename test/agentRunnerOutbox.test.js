import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboxDrain } from '../whatsapp/agentRunner/agentRunnerOutbox.js';

const OWNER_JID = '447000000000@s.whatsapp.net';

/** In-memory stand-in for the Redis-backed outbox store (stream + two string keys). */
function fakeStore(entries = []) {
  const stream = [...entries];
  const kv = new Map();
  const cmp = (a, b) => {
    const [am, as] = a.split('-').map(Number);
    const [bm, bs] = b.split('-').map(Number);
    return am - bm || as - bs;
  };
  return {
    stream,
    kv,
    add(id, fields) {
      stream.push({ id, fields });
    },
    async readAfter(afterId, toId) {
      return stream.filter((e) => cmp(e.id, afterId) > 0 && (toId == null || cmp(e.id, toId) <= 0));
    },
    async getCursor() {
      return kv.get('cursor') ?? null;
    },
    async setCursor(id) {
      kv.set('cursor', id);
    },
    async getMissed() {
      return kv.get('missed') ?? null;
    },
    async setMissed(range) {
      kv.set('missed', range);
    },
  };
}

const entry = (id, replyTo, text, runId = '', ts = '2026-09-24T10:15:00.000Z') => ({
  id,
  fields: { replyTo, text, runId, ts },
});

function setup(entries, { owner = OWNER_JID } = {}) {
  const store = fakeStore(entries);
  const sent = [];
  const drain = createOutboxDrain({
    store,
    sendText: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    getOwnerJid: () => owner,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { store, sent, drain };
}

describe('agent-runner outbox drain', () => {
  it('on the first poll, reports entries that arrived while the bot was down instead of replaying them', async () => {
    const { store, sent, drain } = setup([
      entry('1-0', 'owner', 'cron started #5'),
      entry('2-0', 'chat@s.whatsapp.net', 'done'),
    ]);
    await store.setCursor('0-0');

    await drain.poll();

    assert.deepEqual(sent, [
      { chatId: OWNER_JID, text: 'You missed 2 agent messages, `claude:missed` to list them' },
    ]);
    assert.equal(await store.getCursor(), '2-0');
  });

  it('says nothing on the first poll when nothing was missed, then delivers live entries', async () => {
    const { store, sent, drain } = setup([entry('1-0', 'owner', 'old')]);
    await store.setCursor('1-0');

    await drain.poll();
    assert.deepEqual(sent, []);

    store.add('2-0', { replyTo: 'owner', text: 'fresh', runId: '', ts: '' });
    await drain.poll();
    assert.deepEqual(sent, [{ chatId: OWNER_JID, text: 'fresh' }]);
    assert.equal(await store.getCursor(), '2-0');
  });

  it('merges the entries waiting in one poll into one message per recipient', async () => {
    const { store, sent, drain } = setup([]);
    await drain.poll(); // catch-up with an empty stream
    store.add('1-0', { replyTo: 'owner', text: 'a', runId: '', ts: '' });
    store.add('2-0', { replyTo: 'x@lid', text: 'b', runId: '', ts: '' });
    store.add('3-0', { replyTo: 'owner', text: 'c', runId: '', ts: '' });

    await drain.poll();

    assert.deepEqual(sent, [
      { chatId: OWNER_JID, text: 'a\n\nc' },
      { chatId: 'x@lid', text: 'b' },
    ]);
    assert.equal(await store.getCursor(), '3-0');
  });

  it('keeps the cursor when a send fails, so the next poll retries', async () => {
    const store = fakeStore([]);
    let fail = true;
    const sent = [];
    const drain = createOutboxDrain({
      store,
      sendText: async (chatId, text) => {
        if (fail) throw new Error('socket closed');
        sent.push({ chatId, text });
      },
      getOwnerJid: () => OWNER_JID,
      logger: { info() {}, warn() {}, error() {} },
    });
    await drain.poll();
    store.add('1-0', { replyTo: 'owner', text: 'a', runId: '', ts: '' });

    await assert.rejects(drain.poll(), /socket closed/);
    assert.equal(await store.getCursor(), '0-0');

    fail = false;
    await drain.poll();
    assert.deepEqual(sent, [{ chatId: OWNER_JID, text: 'a' }]);
  });

  it('drops owner messages when MY_PHONE is not set, but still moves the cursor', async () => {
    const { store, sent, drain } = setup([], { owner: null });
    await drain.poll();
    store.add('1-0', { replyTo: 'owner', text: 'a', runId: '', ts: '' });
    await drain.poll();
    assert.deepEqual(sent, []);
    assert.equal(await store.getCursor(), '1-0');
  });

  it('claude:missed lists the missed entries one line each (time, run id, first line)', async () => {
    const { store, drain } = setup([
      entry('1-0', 'owner', 'Agent run r1 finished\nlots of detail', 'r1', '2026-09-24T10:15:00.000Z'),
      entry('2-0', 'owner', 'Cron: nothing to do', '', '2026-09-24T11:02:30.000Z'),
    ]);
    await store.setCursor('0-0');
    await drain.poll();
    store.add('3-0', { replyTo: 'owner', text: 'live, not missed', runId: 'r2', ts: '' });
    await drain.poll();

    const report = await drain.missedReport();

    assert.equal(
      report,
      'Missed agent messages (2):\n' +
        '2026-09-24 10:15 r1 — Agent run r1 finished\n' +
        '2026-09-24 11:02 - — Cron: nothing to do'
    );
  });

  it('claude:missed says so when nothing was missed', async () => {
    const { drain } = setup([]);
    await drain.poll();
    assert.equal(await drain.missedReport(), 'No missed agent messages.');
  });
});
