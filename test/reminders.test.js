import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatReminderDue,
  looksLikeReminderRequest,
  parseRelativeReminder,
} from '../whatsapp/reminders/reminderParser.js';
import {
  addReminder,
  claimReminderFired,
  listDuePendingReminders,
  readReminderStore,
} from '../whatsapp/reminders/reminderStore.js';
import {
  formatDeliveryMessage,
  runReminderDeliveryTick,
} from '../whatsapp/reminders/reminderScheduler.js';
import { runReminderAgent, shouldTryReminderAgent } from '../whatsapp/agents/reminderAgent.js';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.js';

describe('reminderParser', () => {
  const now = Date.parse('2026-09-06T12:00:00+01:00');

  it('detects remind/nudge intent', () => {
    assert.equal(looksLikeReminderRequest('nudge me in 20 minutes to check the oven'), true);
    assert.equal(looksLikeReminderRequest('Please remind me in 1 hour to stretch'), true);
    assert.equal(looksLikeReminderRequest('what is the weather'), false);
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

  it('marks overdue deliveries as late', () => {
    const now = 1_000_000;
    assert.equal(
      formatDeliveryMessage({ text: 'bins', dueAt: now - 5 * 60_000, nowMs: now }),
      'Reminder (late): bins'
    );
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

  it('shouldTryReminderAgent matches intent', () => {
    assert.equal(shouldTryReminderAgent('nudge me in 5 minutes to go'), true);
    assert.equal(shouldTryReminderAgent('hello'), false);
  });

  it('denies non-allowlisted actors', async () => {
    const r = await runReminderAgent(
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
    assert.equal(r.handled, true);
    assert.match(r.replyText, /Not allowed to set reminders/);
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
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 1);
    assert.equal(store.reminders[0].dueAt, now + 20 * 60_000);
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
