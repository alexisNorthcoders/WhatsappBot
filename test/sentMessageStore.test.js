import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSentMessageStore } from '../whatsapp/sentMessageStore.js';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function sent(chat, id, text = `text ${id}`) {
  return { key: { remoteJid: chat, fromMe: true, id }, message: { conversation: text } };
}

const CHAT = '447700900000@s.whatsapp.net';

test('getMessage returns the stored content for a recent outgoing message', async () => {
  const store = createSentMessageStore({ maxEntries: 10, ttlMs: 60_000, now: fakeClock().now });
  store.recordUpsert({ type: 'append', messages: [sent(CHAT, 'A1', 'hello')] });
  assert.deepEqual(await store.getMessage({ remoteJid: CHAT, fromMe: true, id: 'A1' }), {
    conversation: 'hello',
  });
});

test('getMessage returns undefined for unknown ids and other chats', async () => {
  const store = createSentMessageStore({ maxEntries: 10, ttlMs: 60_000, now: fakeClock().now });
  store.recordUpsert({ messages: [sent(CHAT, 'A1')] });
  assert.equal(await store.getMessage({ remoteJid: CHAT, id: 'nope' }), undefined);
  assert.equal(await store.getMessage({ remoteJid: 'other@s.whatsapp.net', id: 'A1' }), undefined);
  assert.equal(await store.getMessage(undefined), undefined);
});

test('a retry key carrying a device suffix still finds the message', async () => {
  const store = createSentMessageStore({ maxEntries: 10, ttlMs: 60_000, now: fakeClock().now });
  store.recordUpsert({ messages: [sent(CHAT, 'A1', 'hi')] });
  assert.deepEqual(
    await store.getMessage({ remoteJid: '447700900000:12@s.whatsapp.net', id: 'A1' }),
    { conversation: 'hi' }
  );
});

test('only the bot’s own messages with content are recorded', async () => {
  const store = createSentMessageStore({ maxEntries: 10, ttlMs: 60_000, now: fakeClock().now });
  store.recordUpsert({
    messages: [
      { key: { remoteJid: CHAT, fromMe: false, id: 'IN' }, message: { conversation: 'inbound' } },
      { key: { remoteJid: CHAT, fromMe: true, id: 'EMPTY' } },
    ],
  });
  assert.equal(store.size, 0);
  assert.equal(await store.getMessage({ remoteJid: CHAT, id: 'IN' }), undefined);
});

test('entries expire after the TTL', async () => {
  const clock = fakeClock();
  const store = createSentMessageStore({ maxEntries: 10, ttlMs: 60_000, now: clock.now });
  store.recordUpsert({ messages: [sent(CHAT, 'A1')] });
  clock.advance(59_999);
  assert.ok(await store.getMessage({ remoteJid: CHAT, id: 'A1' }));
  clock.advance(1);
  assert.equal(await store.getMessage({ remoteJid: CHAT, id: 'A1' }), undefined);
  assert.equal(store.size, 0);
});

test('expired entries are pruned when new ones are recorded', () => {
  const clock = fakeClock();
  const store = createSentMessageStore({ maxEntries: 10, ttlMs: 60_000, now: clock.now });
  store.recordUpsert({ messages: [sent(CHAT, 'A1'), sent(CHAT, 'A2')] });
  clock.advance(60_000);
  store.recordUpsert({ messages: [sent(CHAT, 'A3')] });
  assert.equal(store.size, 1);
});

test('the oldest entry is evicted once maxEntries is reached', async () => {
  const store = createSentMessageStore({ maxEntries: 2, ttlMs: 60_000, now: fakeClock().now });
  store.recordUpsert({ messages: [sent(CHAT, 'A1'), sent(CHAT, 'A2'), sent(CHAT, 'A3')] });
  assert.equal(store.size, 2);
  assert.equal(await store.getMessage({ remoteJid: CHAT, id: 'A1' }), undefined);
  assert.ok(await store.getMessage({ remoteJid: CHAT, id: 'A2' }));
  assert.ok(await store.getMessage({ remoteJid: CHAT, id: 'A3' }));
});

test('re-recording an id refreshes it so it is not the next evicted', async () => {
  const clock = fakeClock();
  const store = createSentMessageStore({ maxEntries: 2, ttlMs: 60_000, now: clock.now });
  store.recordUpsert({ messages: [sent(CHAT, 'A1'), sent(CHAT, 'A2')] });
  clock.advance(1_000);
  store.recordUpsert({ messages: [sent(CHAT, 'A1', 'edited')] });
  store.recordUpsert({ messages: [sent(CHAT, 'A3')] });
  assert.deepEqual(await store.getMessage({ remoteJid: CHAT, id: 'A1' }), { conversation: 'edited' });
  assert.equal(await store.getMessage({ remoteJid: CHAT, id: 'A2' }), undefined);
});

test('defaults are bounded', () => {
  const store = createSentMessageStore();
  assert.ok(store.maxEntries > 0 && Number.isFinite(store.maxEntries));
  assert.ok(store.ttlMs > 0 && Number.isFinite(store.ttlMs));
});
