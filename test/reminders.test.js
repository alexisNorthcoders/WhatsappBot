import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyReminderIntent,
  formatReminderDue,
  looksLikeReminderCancel,
  looksLikeReminderList,
  looksLikeReminderRequest,
  parseCancelReminder,
  parseRelativeReminder,
} from '../whatsapp/reminders/reminderParser.js';
import {
  addReminder,
  cancelReminder,
  claimReminderFired,
  listDuePendingReminders,
  listPendingReminders,
  readReminderStore,
  REMINDER_LIST_LIMIT,
} from '../whatsapp/reminders/reminderStore.js';
import {
  formatDeliveryMessage,
  runReminderDeliveryTick,
  startReminderScheduler,
  stopReminderScheduler,
} from '../whatsapp/reminders/reminderScheduler.js';
import { runReminderAgent, shouldTryReminderAgent } from '../whatsapp/agents/reminderAgent.js';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.js';
import { createProductionPorts } from '../whatsapp/orchestration/createProductionPorts.js';

describe('reminderParser', () => {
  const now = Date.parse('2026-09-06T12:00:00+01:00');

  it('detects remind/nudge intent', () => {
    assert.equal(looksLikeReminderRequest('nudge me in 20 minutes to check the oven'), true);
    assert.equal(looksLikeReminderRequest('Please remind me in 1 hour to stretch'), true);
    assert.equal(looksLikeReminderRequest('what is the weather'), false);
  });

  it('detects list and cancel intents', () => {
    assert.equal(looksLikeReminderList('list reminders'), true);
    assert.equal(looksLikeReminderList('show my upcoming reminders'), true);
    assert.equal(looksLikeReminderList('what are my reminders?'), true);
    assert.equal(looksLikeReminderList('reminders'), true);
    assert.equal(looksLikeReminderList('what is the weather'), false);

    assert.equal(looksLikeReminderCancel('cancel reminder 3'), true);
    assert.equal(looksLikeReminderCancel('cancel #12'), true);
    assert.equal(looksLikeReminderCancel('delete reminder #2'), true);
    assert.equal(looksLikeReminderCancel('remove reminder 5'), true);
    assert.equal(looksLikeReminderCancel('list reminders'), false);

    assert.equal(classifyReminderIntent('list my reminders'), 'list');
    assert.equal(classifyReminderIntent('cancel reminder 3'), 'cancel');
    assert.equal(classifyReminderIntent('nudge me in 5 minutes to go'), 'create');
    // Precedence: create → cancel → list
    assert.equal(
      classifyReminderIntent('remind me in 5 minutes to list my reminders'),
      'create'
    );
    assert.equal(
      classifyReminderIntent('remind me in 5 minutes to cancel reminder 1'),
      'create'
    );
    assert.equal(classifyReminderIntent('hello'), null);
  });

  it('parses cancel-by-id', () => {
    const a = parseCancelReminder('cancel reminder 3');
    assert.equal(a.ok, true);
    if (a.ok) assert.equal(a.id, 3);

    const b = parseCancelReminder('Please delete reminder #12');
    assert.equal(b.ok, true);
    if (b.ok) assert.equal(b.id, 12);

    const c = parseCancelReminder('cancel #7');
    assert.equal(c.ok, true);
    if (c.ok) assert.equal(c.id, 7);

    const d = parseCancelReminder('remove reminder 9');
    assert.equal(d.ok, true);
    if (d.ok) assert.equal(d.id, 9);

    const e = parseCancelReminder('delete #4');
    assert.equal(e.ok, true);
    if (e.ok) assert.equal(e.id, 4);
  });

  it('parses minutes and hours with task text', () => {
    const a = parseRelativeReminder('nudge me in 20 minutes to check the oven', now);
    assert.equal(a.ok, true);
    if (a.ok) {
      assert.equal(a.text, 'check the oven');
      assert.equal(a.dueAt, now + 20 * 60_000);
    }

    const b = parseRelativeReminder('remind me in 2 hours to stretch', now);
    assert.equal(b.ok, true);
    if (b.ok) {
      assert.equal(b.text, 'stretch');
      assert.equal(b.dueAt, now + 2 * 3_600_000);
    }
  });

  it('parses remind me to … in N minutes', () => {
    const r = parseRelativeReminder('remind me to take bins out in 30 mins', now);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.text, 'take bins out');
      assert.equal(r.offsetMs, 30 * 60_000);
    }
  });

  it('parses “in an hour”', () => {
    const r = parseRelativeReminder('nudge me in an hour to drink water', now);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.offsetMs, 3_600_000);
      assert.equal(r.text, 'drink water');
    }
  });

  it('handles real-world WhatsApp phrasing (please / punctuation)', () => {
    const noTask = parseRelativeReminder('remind me in 20 minutes please', now);
    assert.equal(noTask.ok, false);
    if (!noTask.ok) assert.equal(noTask.reason, 'missing_text');

    const withPlease = parseRelativeReminder(
      'remind me in 20 minutes to check the oven please',
      now
    );
    assert.equal(withPlease.ok, true);
    if (withPlease.ok) assert.equal(withPlease.text, 'check the oven');

    const punct = parseRelativeReminder('Remind me, in 20 minutes, to check the oven!!!', now);
    assert.equal(punct.ok, true);
    if (punct.ok) assert.equal(punct.text, 'check the oven');

    const pleaseThenTask = parseRelativeReminder(
      'nudge me in 20 minutes please check the oven',
      now
    );
    assert.equal(pleaseThenTask.ok, true);
    if (pleaseThenTask.ok) assert.equal(pleaseThenTask.text, 'check the oven');

    const trailingBang = parseRelativeReminder('remind me in 20 minutes!!!', now);
    assert.equal(trailingBang.ok, false);
    if (!trailingBang.ok) assert.equal(trailingBang.reason, 'missing_text');
  });

  it('rejects zero delay and missing task text', () => {
    const z = parseRelativeReminder('remind me in 0 minutes to spam', now);
    assert.equal(z.ok, false);
    if (!z.ok) assert.equal(z.reason, 'invalid_offset');

    const m = parseRelativeReminder('remind me in 20 minutes', now);
    assert.equal(m.ok, false);
    if (!m.ok) assert.equal(m.reason, 'missing_text');
  });

  it('returns unsupported_time for absolute phrasing (MVP)', () => {
    const r = parseRelativeReminder('remind me at 6 to take the bins out', now);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, 'unsupported_time');
      assert.match(r.message, /minutes or hours/i);
    }
  });

  it('formats due time as today/tomorrow', () => {
    const dueToday = now + 30 * 60_000;
    assert.match(formatReminderDue(dueToday, now), /today$/);
    const dueTomorrow = now + 20 * 3_600_000;
    assert.match(formatReminderDue(dueTomorrow, now), /tomorrow$/);
  });
});

describe('reminderStore + delivery', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let filePath;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reminders-'));
    filePath = join(dir, 'reminders.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists reminders and survives re-read', async () => {
    const dueAt = Date.now() + 60_000;
    const rem = await addReminder({
      chatId: 'chat@s.whatsapp.net',
      actorId: 'actor@s.whatsapp.net',
      dueAt,
      text: 'check oven',
      filePath,
    });
    assert.equal(rem.id, 1);
    const raw = await readFile(filePath, 'utf8');
    assert.match(raw, /check oven/);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 1);
    assert.equal(store.reminders[0].status, 'pending');
    assert.equal(store.nextId, 2);
  });

  it('treats malformed store JSON as empty (survives corruption)', async () => {
    await writeFile(filePath, '{not-json', 'utf8');
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 0);
    assert.equal(store.nextId, 1);

    const rem = await addReminder({
      chatId: 'c@s.whatsapp.net',
      dueAt: Date.now() + 1000,
      text: 'recover',
      filePath,
    });
    assert.equal(rem.id, 1);
    const again = await readReminderStore(filePath);
    assert.equal(again.reminders.length, 1);
  });

  it('delivers due reminders once (claim before send)', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'stretch',
      createdAt: now - 60_000,
      filePath,
    });
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + 60_000,
      text: 'not yet',
      createdAt: now,
      filePath,
    });

    const sent = [];
    const r1 = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r1.delivered, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 'c1@s.whatsapp.net');
    assert.equal(sent[0].text, 'Reminder: stretch');

    const r2 = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r2.delivered, 0);
    assert.equal(sent.length, 1);

    const due = await listDuePendingReminders(now, filePath);
    assert.equal(due.length, 0);
    const claimed = await claimReminderFired(1, now, filePath);
    assert.equal(claimed, null);
  });

  it('only one concurrent claim wins', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'once',
      createdAt: now - 60_000,
      filePath,
    });

    const results = await Promise.all([
      claimReminderFired(1, now, filePath),
      claimReminderFired(1, now + 1, filePath),
      claimReminderFired(1, now + 2, filePath),
    ]);
    const winners = results.filter((r) => r != null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.status, 'fired');
    assert.equal(winners[0]?.text, 'once');

    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'fired');
  });

  it('records send failure after claim (does not redeliver)', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'fail me',
      createdAt: now - 60_000,
      filePath,
    });

    const r1 = await runReminderDeliveryTick({
      sendText: async () => {
        throw new Error('socket down');
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r1.delivered, 0);
    assert.equal(r1.failed, 1);

    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'fired');

    const sent = [];
    const r2 = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r2.delivered, 0);
    assert.equal(sent.length, 0);
  });

  it('marks overdue deliveries as late', () => {
    const now = 1_000_000;
    assert.equal(
      formatDeliveryMessage({ text: 'bins', dueAt: now - 5 * 60_000, nowMs: now }),
      'Reminder (late): bins'
    );
  });

  it('lists pending reminders for a chat (not other chats / not cancelled)', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + 60_000,
      text: 'first',
      createdAt: now,
      filePath,
    });
    await addReminder({
      chatId: 'c2@s.whatsapp.net',
      dueAt: now + 30_000,
      text: 'other chat',
      createdAt: now,
      filePath,
    });
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + 120_000,
      text: 'second',
      createdAt: now,
      filePath,
    });
    const cancelled = await cancelReminder(1, { chatId: 'c1@s.whatsapp.net', filePath });
    assert.equal(cancelled?.id, 1);

    const listed = await listPendingReminders({ chatId: 'c1@s.whatsapp.net', filePath });
    assert.equal(listed.total, 1);
    assert.equal(listed.reminders.length, 1);
    assert.equal(listed.reminders[0].id, 3);
    assert.equal(listed.reminders[0].text, 'second');
  });

  it('caps listPendingReminders with deterministic soonest-first truncation', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    for (let i = 0; i < 5; i++) {
      await addReminder({
        chatId: 'c1@s.whatsapp.net',
        dueAt: now + (i + 1) * 60_000,
        text: `task-${i + 1}`,
        createdAt: now,
        filePath,
      });
    }
    const capped = await listPendingReminders({
      chatId: 'c1@s.whatsapp.net',
      filePath,
      limit: 3,
    });
    assert.equal(capped.total, 5);
    assert.equal(capped.limit, 3);
    assert.equal(capped.reminders.length, 3);
    assert.deepEqual(
      capped.reminders.map((r) => r.text),
      ['task-1', 'task-2', 'task-3']
    );
    assert.equal(REMINDER_LIST_LIMIT, 20);
  });

  it('cancel prevents future delivery', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'should not fire',
      createdAt: now - 60_000,
      filePath,
    });
    const cancelled = await cancelReminder(1, { chatId: 'c1@s.whatsapp.net', filePath });
    assert.equal(cancelled?.status, 'cancelled');

    const sent = [];
    const r = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r.delivered, 0);
    assert.equal(sent.length, 0);

    const again = await cancelReminder(1, { chatId: 'c1@s.whatsapp.net', filePath });
    assert.equal(again, null);
  });

  it('stale listDue + concurrent cancel cannot fire (claim re-reads under lock)', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'race me',
      createdAt: now - 60_000,
      filePath,
    });

    // Snapshot as delivery tick would (before cancel).
    const due = await listDuePendingReminders(now, filePath);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, 1);

    const [cancelled, claimed] = await Promise.all([
      cancelReminder(1, { chatId: 'c1@s.whatsapp.net', filePath }),
      claimReminderFired(1, now, filePath),
    ]);
    const outcomes = [cancelled, claimed].filter((r) => r != null);
    assert.equal(outcomes.length, 1);

    const store = await readReminderStore(filePath);
    assert.ok(
      store.reminders[0].status === 'cancelled' || store.reminders[0].status === 'fired'
    );

    // If cancel won, a later delivery tick must not send.
    if (store.reminders[0].status === 'cancelled') {
      const sent = [];
      const r = await runReminderDeliveryTick({
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        nowMs: now,
        filePath,
      });
      assert.equal(r.delivered, 0);
      assert.equal(sent.length, 0);
    }

    // Stale due id after cancel alone: claim must return null.
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 500,
      text: 'stale after cancel',
      createdAt: now - 30_000,
      filePath,
    });
    const due2 = await listDuePendingReminders(now, filePath);
    assert.equal(due2.some((r) => r.id === 2), true);
    await cancelReminder(2, { chatId: 'c1@s.whatsapp.net', filePath });
    const claimedAfterCancel = await claimReminderFired(2, now, filePath);
    assert.equal(claimedAfterCancel, null);
  });
});

describe('reminderScheduler lifecycle', () => {
  afterEach(() => {
    stopReminderScheduler();
  });

  it('startReminderScheduler replaces prior interval (no duplicate pollers)', async () => {
    const ticks = [];
    /** @type {any} */
    const fakeSock = {
      sendMessage: async () => {},
    };
    startReminderScheduler({
      getSocket: () => fakeSock,
      pollMs: 50,
      filePath: join(tmpdir(), `reminders-sched-${Date.now()}.json`),
      logger: {
        info: (a, b) => ticks.push(['info', a, b]),
      },
    });
    startReminderScheduler({
      getSocket: () => fakeSock,
      pollMs: 50,
      filePath: join(tmpdir(), `reminders-sched2-${Date.now()}.json`),
      logger: {
        info: (a, b) => ticks.push(['info2', a, b]),
      },
    });
    // Two starts should leave a single live interval; stop clears it.
    stopReminderScheduler();
    assert.ok(ticks.some((t) => t[0] === 'info2'));
  });
});

describe('reminderAgent allowlist', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let filePath;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reminders-agent-'));
    filePath = join(dir, 'reminders.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('shouldTryReminderAgent matches create/list/cancel', () => {
    assert.equal(shouldTryReminderAgent('nudge me in 5 minutes to go'), true);
    assert.equal(shouldTryReminderAgent('list reminders'), true);
    assert.equal(shouldTryReminderAgent('cancel reminder 2'), true);
    assert.equal(shouldTryReminderAgent('hello'), false);
  });

  it('denies non-allowlisted actors for create/list/cancel', async () => {
    const denied = await runReminderAgent(
      {
        text: 'nudge me in 10 minutes to check the oven',
        chatId: 'c@s.whatsapp.net',
        actorId: 'stranger@s.whatsapp.net',
      },
      {
        isAllowedActor: () => false,
        filePath,
      }
    );
    assert.equal(denied.handled, true);
    assert.match(denied.replyText, /Not allowed to manage reminders/);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 0);

    const listDenied = await runReminderAgent(
      {
        text: 'list reminders',
        chatId: 'c@s.whatsapp.net',
        actorId: 'stranger@s.whatsapp.net',
      },
      {
        isAllowedActor: () => false,
        filePath,
      }
    );
    assert.equal(listDenied.handled, true);
    assert.match(listDenied.replyText, /Not allowed to manage reminders/);

    const cancelDenied = await runReminderAgent(
      {
        text: 'cancel reminder 1',
        chatId: 'c@s.whatsapp.net',
        actorId: 'stranger@s.whatsapp.net',
      },
      {
        isAllowedActor: () => false,
        filePath,
      }
    );
    assert.equal(cancelDenied.handled, true);
    assert.match(cancelDenied.replyText, /Not allowed to manage reminders/);
  });

  it('denies safely when isAllowedActor is missing', async () => {
    const r = await runReminderAgent(
      {
        text: 'nudge me in 10 minutes to check the oven',
        chatId: 'c@s.whatsapp.net',
        actorId: 'anyone@s.whatsapp.net',
      },
      /** @type {any} */ ({ filePath })
    );
    assert.equal(r.handled, true);
    assert.match(r.replyText, /Not allowed to manage reminders/);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 0);
  });

  it('creates reminder and confirms due time for allowlisted actors', async () => {
    const now = Date.parse('2026-09-06T15:00:00+01:00');
    const r = await runReminderAgent(
      {
        text: 'nudge me in 20 minutes to check the oven',
        chatId: 'c@s.whatsapp.net',
        actorId: 'owner@s.whatsapp.net',
      },
      {
        isAllowedActor: () => true,
        nowMs: now,
        filePath,
      }
    );
    assert.equal(r.handled, true);
    assert.match(r.replyText, /OK — I'll remind you at/);
    assert.match(r.replyText, /check the oven/);
    assert.match(r.replyText, /#1/);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 1);
    assert.equal(store.reminders[0].dueAt, now + 20 * 60_000);
  });

  it('lists upcoming reminders with id, due time, and text', async () => {
    const now = Date.parse('2026-09-06T15:00:00+01:00');
    await addReminder({
      chatId: 'c@s.whatsapp.net',
      dueAt: now + 20 * 60_000,
      text: 'check the oven',
      createdAt: now,
      filePath,
    });
    await addReminder({
      chatId: 'c@s.whatsapp.net',
      dueAt: now + 60 * 60_000,
      text: 'stretch',
      createdAt: now,
      filePath,
    });

    const r = await runReminderAgent(
      {
        text: 'list my reminders',
        chatId: 'c@s.whatsapp.net',
        actorId: 'owner@s.whatsapp.net',
      },
      {
        isAllowedActor: () => true,
        nowMs: now,
        filePath,
      }
    );
    assert.equal(r.handled, true);
    assert.match(r.replyText, /^Upcoming reminders:/);
    assert.match(r.replyText, /#1 — .+ today: check the oven/);
    assert.match(r.replyText, /#2 — .+ today: stretch/);
  });

  it('truncates long reminder lists in the agent reply', async () => {
    const now = Date.parse('2026-09-06T15:00:00+01:00');
    for (let i = 0; i < 25; i++) {
      await addReminder({
        chatId: 'c@s.whatsapp.net',
        dueAt: now + (i + 1) * 60_000,
        text: `item-${i + 1}`,
        createdAt: now,
        filePath,
      });
    }
    const r = await runReminderAgent(
      {
        text: 'list reminders',
        chatId: 'c@s.whatsapp.net',
        actorId: 'owner@s.whatsapp.net',
      },
      {
        isAllowedActor: () => true,
        nowMs: now,
        filePath,
      }
    );
    assert.equal(r.handled, true);
    assert.match(r.replyText, /#1 —/);
    assert.match(r.replyText, /#20 —/);
    assert.doesNotMatch(r.replyText, /#21 —/);
    assert.match(r.replyText, /…and 5 more \(showing soonest 20\)/);
  });

  it('cancels by id and confirms', async () => {
    const now = Date.parse('2026-09-06T15:00:00+01:00');
    await addReminder({
      chatId: 'c@s.whatsapp.net',
      dueAt: now + 20 * 60_000,
      text: 'check the oven',
      createdAt: now,
      filePath,
    });

    const r = await runReminderAgent(
      {
        text: 'cancel reminder 1',
        chatId: 'c@s.whatsapp.net',
        actorId: 'owner@s.whatsapp.net',
      },
      {
        isAllowedActor: () => true,
        nowMs: now,
        filePath,
      }
    );
    assert.equal(r.handled, true);
    assert.equal(r.replyText, 'Cancelled reminder #1');

    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'cancelled');

    const empty = await runReminderAgent(
      {
        text: 'list reminders',
        chatId: 'c@s.whatsapp.net',
        actorId: 'owner@s.whatsapp.net',
      },
      {
        isAllowedActor: () => true,
        nowMs: now,
        filePath,
      }
    );
    assert.equal(empty.replyText, 'No upcoming reminders.');
  });
});

describe('runAgentsChainSequential reminders', () => {
  it('handles reminder before other agents', async () => {
    const log = [];
    const r = await runAgentsChainSequential(
      {
        id: '1',
        chatId: 'c@s.whatsapp.net',
        actorId: 'a@s.whatsapp.net',
        fromMe: false,
        text: 'nudge me in 5 minutes to stand up',
        features: { hasImage: false },
        raw: {},
      },
      {
        logger: { info() {}, warn() {}, error() {} },
        messaging: {
          sendText: async (chatId, text) => {
            log.push({ chatId, text });
          },
        },
        chatMemory: {
          append: async () => {},
        },
        shouldTryReminderAgent: () => true,
        runReminderAgent: async () => ({
          handled: true,
          replyText: 'OK — reminder set',
        }),
        shouldTryLightsAgent: () => true,
        runLightsAgent: async () => {
          throw new Error('lights should not run');
        },
        LIGHTS_AGENT_SKIP: 'SKIP',
        shouldTryWeatherAgent: () => false,
        runWeatherAgent: async () => 'SKIP',
        WEATHER_AGENT_SKIP: 'SKIP',
        shouldTryJoplinAgent: () => false,
        runJoplinAgent: async () => 'SKIP',
        JOPLIN_AGENT_SKIP: 'SKIP',
        shouldTryEmailAgent: () => false,
        runEmailAgent: async () => 'SKIP',
        EMAIL_AGENT_SKIP: 'SKIP',
      }
    );
    assert.equal(r.handled, true);
    assert.equal(log[0].text, 'OK — reminder set');
  });
});

describe('production ports reminder list/cancel (e2e path)', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let filePath;
  /** @type {string | undefined} */
  let prevStoreEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reminders-e2e-'));
    filePath = join(dir, 'reminders.json');
    prevStoreEnv = process.env.REMINDERS_STORE_FILE;
    process.env.REMINDERS_STORE_FILE = filePath;
  });

  afterEach(async () => {
    if (prevStoreEnv === undefined) delete process.env.REMINDERS_STORE_FILE;
    else process.env.REMINDERS_STORE_FILE = prevStoreEnv;
    await rm(dir, { recursive: true, force: true });
  });

  function stubPorts(isAllowedActor) {
    const sent = [];
    const sock = {
      sendMessage: async (jid, content) => {
        sent.push({ jid, ...content });
      },
      readMessages: async () => {},
      logger: {},
      updateMediaMessage: async () => {},
    };
    const ports = createProductionPorts({
      sock,
      downloadMediaMessage: async () => Buffer.from(''),
      fs: { writeFile: async () => {} },
      logger: { info() {}, warn() {}, error() {} },
      commands: {},
      secondPhone: undefined,
      isAllowedActor,
    });
    return { ports, sent };
  }

  function inbound(text, actorId = 'owner@s.whatsapp.net') {
    return {
      id: 'x',
      chatId: 'c@s.whatsapp.net',
      actorId,
      fromMe: false,
      text,
      features: { hasImage: false },
      raw: {
        key: { remoteJid: 'c@s.whatsapp.net', participant: null, id: 'x' },
        message: {},
      },
    };
  }

  it('routes list reminders through agents.tryHandle for allowlisted actors', async () => {
    const now = Date.parse('2026-09-06T15:00:00+01:00');
    await addReminder({
      chatId: 'c@s.whatsapp.net',
      dueAt: now + 20 * 60_000,
      text: 'check the oven',
      createdAt: now,
      filePath,
    });

    const { ports, sent } = stubPorts(() => true);
    const r = await ports.agents.tryHandle(inbound('list reminders'));
    assert.equal(r.handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^Upcoming reminders:/);
    assert.match(sent[0].text, /#1 — .+ today: check the oven/);
  });

  it('routes cancel reminder N through agents.tryHandle for allowlisted actors', async () => {
    const now = Date.parse('2026-09-06T15:00:00+01:00');
    await addReminder({
      chatId: 'c@s.whatsapp.net',
      dueAt: now + 20 * 60_000,
      text: 'check the oven',
      createdAt: now,
      filePath,
    });

    const { ports, sent } = stubPorts(() => true);
    const r = await ports.agents.tryHandle(inbound('cancel reminder 1'));
    assert.equal(r.handled, true);
    assert.equal(sent[0].text, 'Cancelled reminder #1');
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'cancelled');
  });

  it('deny-gates list/cancel for non-allowlisted actors on the same path', async () => {
    const { ports, sent } = stubPorts(() => false);
    const list = await ports.agents.tryHandle(
      inbound('list reminders', 'stranger@s.whatsapp.net')
    );
    assert.equal(list.handled, true);
    assert.match(sent[0].text, /Not allowed to manage reminders/);

    sent.length = 0;
    const cancel = await ports.agents.tryHandle(
      inbound('cancel reminder 1', 'stranger@s.whatsapp.net')
    );
    assert.equal(cancel.handled, true);
    assert.match(sent[0].text, /Not allowed to manage reminders/);
  });
});
