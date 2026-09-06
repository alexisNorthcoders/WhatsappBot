import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  classifyReminderIntent,
  formatReminderDue,
  looksLikeReminderCancel,
  looksLikeReminderHelp,
  looksLikeReminderList,
  looksLikeReminderRequest,
  localDueAtMs,
  parseAbsoluteReminder,
  parseCancelReminder,
  parseRelativeReminder,
  parseReminder,
  REMINDER_HELP_TEXT,
  REMINDER_TIME_EXAMPLES,
  resolveClockHour,
} from '../whatsapp/reminders/reminderParser.js';
import {
  addReminder,
  cancelReminder,
  claimReminderDelivery,
  claimReminderFired,
  clearAllReminderDeliveryInFlightForTests,
  completeReminderDelivery,
  DEFAULT_REMINDER_MAX_PENDING_PER_CHAT,
  DEFAULT_REMINDER_MAX_TEXT_CHARS,
  getReminderSafetyCaps,
  isReminderDeliveryInFlightLocally,
  isReminderLimitError,
  listDuePendingReminders,
  listPendingReminders,
  pruneTerminalReminders,
  readReminderStore,
  releaseReminderDelivery,
  ReminderLimitError,
  REMINDER_LIST_LIMIT,
  settleStaleDeliveries,
  STALE_DELIVERING_MS,
  truncateReminderText,
} from '../whatsapp/reminders/reminderStore.js';
import {
  formatDeliveryMessage,
  isReminderSchedulerTickInFlight,
  ReminderPreSendError,
  resetReminderSchedulerInFlightForTests,
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
    // Precedence: create → help → cancel → list
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

  it('detects reminder help intent and examples phrasing', () => {
    assert.equal(looksLikeReminderHelp('reminder help'), true);
    assert.equal(looksLikeReminderHelp('reminders help'), true);
    assert.equal(looksLikeReminderHelp('help reminders'), true);
    assert.equal(looksLikeReminderHelp('help with reminders'), true);
    assert.equal(looksLikeReminderHelp('how do I set a reminder'), true);
    assert.equal(looksLikeReminderHelp('how to use reminders'), true);
    assert.equal(looksLikeReminderHelp('!reminders'), true);
    assert.equal(looksLikeReminderHelp('!reminder'), true);
    assert.equal(looksLikeReminderHelp('list reminders'), false);
    assert.equal(looksLikeReminderHelp('reminders'), false);

    assert.equal(classifyReminderIntent('reminder help'), 'help');
    assert.equal(classifyReminderIntent('help reminders'), 'help');
    assert.equal(classifyReminderIntent('!reminders'), 'help');
    assert.equal(
      classifyReminderIntent('remind me in 5 minutes to ask for reminder help'),
      'create'
    );
    assert.match(REMINDER_HELP_TEXT, /list reminders/i);
    assert.match(REMINDER_HELP_TEXT, /cancel reminder 3/i);
    assert.match(REMINDER_HELP_TEXT, /cancel #3/i);
    assert.match(REMINDER_HELP_TEXT, /remind me in 20 minutes/i);
    assert.match(REMINDER_HELP_TEXT, /remind me at 6/i);
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

  it('formats due time as today/tomorrow', () => {
    const dueToday = now + 30 * 60_000;
    assert.match(formatReminderDue(dueToday, now), /today$/);
    const dueTomorrow = now + 20 * 3_600_000;
    assert.match(formatReminderDue(dueTomorrow, now), /tomorrow$/);
  });

  it('resolveClockHour: bare 1–7 → PM, 8–11 → AM, 12 → noon; am/pm and 24h override', () => {
    // Bare hours 1–7 → PM
    for (let h = 1; h <= 7; h++) {
      assert.deepEqual(resolveClockHour(h, 0, undefined), { hour: h + 12, minute: 0 });
    }
    // Bare hours 8–11 → AM as written
    for (let h = 8; h <= 11; h++) {
      assert.deepEqual(resolveClockHour(h, 0, undefined), { hour: h, minute: 0 });
    }
    // Bare 12 → noon
    assert.deepEqual(resolveClockHour(12, 0, undefined), { hour: 12, minute: 0 });
    assert.deepEqual(resolveClockHour(12, 30, undefined), { hour: 12, minute: 30 });

    // Explicit am/pm
    assert.deepEqual(resolveClockHour(6, 0, 'am'), { hour: 6, minute: 0 });
    assert.deepEqual(resolveClockHour(6, 30, 'pm'), { hour: 18, minute: 30 });
    assert.deepEqual(resolveClockHour(12, 0, 'am'), { hour: 0, minute: 0 });
    assert.deepEqual(resolveClockHour(12, 0, 'pm'), { hour: 12, minute: 0 });
    assert.deepEqual(resolveClockHour(9, 15, 'a.m.'), { hour: 9, minute: 15 });
    assert.deepEqual(resolveClockHour(9, 15, 'p.m.'), { hour: 21, minute: 15 });

    // 24h (no meridiem)
    assert.deepEqual(resolveClockHour(0, 0, undefined), { hour: 0, minute: 0 });
    assert.deepEqual(resolveClockHour(18, 0, undefined), { hour: 18, minute: 0 });
    assert.deepEqual(resolveClockHour(23, 45, undefined), { hour: 23, minute: 45 });

    assert.equal(resolveClockHour(25, 0, undefined), null);
    assert.equal(resolveClockHour(6, 99, undefined), null);
    assert.equal(resolveClockHour(13, 0, 'pm'), null);
  });

  it('parses “at 6 …” as next future 18:00 (today if still future)', () => {
    // Local noon — 18:00 today is still future
    const noon = localDueAtMs(now, { hour: 12, minute: 0 });
    const r = parseAbsoluteReminder('remind me at 6 to take the bins out', noon);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.text, 'take the bins out');
      assert.equal(r.dueAt, localDueAtMs(noon, { hour: 18, minute: 0 }));
      assert.match(formatReminderDue(r.dueAt, noon), /18:00 today/);
    }

    // Via unified parseReminder
    const u = parseReminder('remind me at 6 to take the bins out', noon);
    assert.equal(u.ok, true);
    if (u.ok) assert.equal(u.dueAt, localDueAtMs(noon, { hour: 18, minute: 0 }));
  });

  it('rolls “at 6 …” to tomorrow when 18:00 today has passed', () => {
    const evening = localDueAtMs(now, { hour: 19, minute: 0 });
    const r = parseAbsoluteReminder('remind me at 6 to take the bins out', evening);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.dueAt, localDueAtMs(evening, { dayOffset: 1, hour: 18, minute: 0 }));
      assert.match(formatReminderDue(r.dueAt, evening), /18:00 tomorrow/);
    }
  });

  it('parses “tomorrow at 9 …” as 09:00 tomorrow (literal calendar tomorrow)', () => {
    const noon = localDueAtMs(now, { hour: 12, minute: 0 });
    const r = parseAbsoluteReminder(
      'remind me tomorrow at 9 to email the landlord',
      noon
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.text, 'email the landlord');
      assert.equal(r.dueAt, localDueAtMs(noon, { dayOffset: 1, hour: 9, minute: 0 }));
      assert.match(formatReminderDue(r.dueAt, noon), /09:00 tomorrow/);
    }

    // Late evening: still tomorrow 09:00, never day-after-tomorrow
    const late = localDueAtMs(now, { hour: 22, minute: 30 });
    const lateR = parseReminder('remind me tomorrow at 9 to email the landlord', late);
    assert.equal(lateR.ok, true);
    if (lateR.ok) {
      assert.equal(lateR.dueAt, localDueAtMs(late, { dayOffset: 1, hour: 9, minute: 0 }));
      assert.match(formatReminderDue(lateR.dueAt, late), /09:00 tomorrow/);
    }
  });

  it('parses absolute task-before-time and time-before-task placements', () => {
    const noon = localDueAtMs(now, { hour: 12, minute: 0 });
    const due1800 = localDueAtMs(noon, { hour: 18, minute: 0 });

    const timeThenTask = parseReminder('remind me at 6 to take bins out', noon);
    assert.equal(timeThenTask.ok, true);
    if (timeThenTask.ok) {
      assert.equal(timeThenTask.text, 'take bins out');
      assert.equal(timeThenTask.dueAt, due1800);
    }

    const taskThenTime = parseReminder('remind me to take bins out at 6', noon);
    assert.equal(taskThenTime.ok, true);
    if (taskThenTime.ok) {
      assert.equal(taskThenTime.text, 'take bins out');
      assert.equal(taskThenTime.dueAt, due1800);
    }

    const leadTime = parseReminder('at 6 remind me to take bins out', noon);
    assert.equal(leadTime.ok, true);
    if (leadTime.ok) {
      assert.equal(leadTime.text, 'take bins out');
      assert.equal(leadTime.dueAt, due1800);
    }

    const taskThenTomorrow = parseReminder(
      'remind me to email the landlord tomorrow at 9',
      noon
    );
    assert.equal(taskThenTomorrow.ok, true);
    if (taskThenTomorrow.ok) {
      assert.equal(taskThenTomorrow.text, 'email the landlord');
      assert.equal(
        taskThenTomorrow.dueAt,
        localDueAtMs(noon, { dayOffset: 1, hour: 9, minute: 0 })
      );
    }

    const tomorrowThenTask = parseReminder(
      'remind me tomorrow at 9 to email the landlord',
      noon
    );
    assert.equal(tomorrowThenTask.ok, true);
    if (tomorrowThenTask.ok) {
      assert.equal(tomorrowThenTask.text, 'email the landlord');
      assert.equal(
        tomorrowThenTask.dueAt,
        localDueAtMs(noon, { dayOffset: 1, hour: 9, minute: 0 })
      );
    }
  });

  it('parses absolute variants (minutes, am/pm, 24h)', () => {
    const noon = localDueAtMs(now, { hour: 12, minute: 0 });

    const withMins = parseReminder('nudge me tomorrow at 9:15 to call dentist', noon);
    assert.equal(withMins.ok, true);
    if (withMins.ok) {
      assert.equal(withMins.text, 'call dentist');
      assert.equal(
        withMins.dueAt,
        localDueAtMs(noon, { dayOffset: 1, hour: 9, minute: 15 })
      );
    }

    const pm = parseReminder('remind me at 6pm to take bins out', noon);
    assert.equal(pm.ok, true);
    if (pm.ok) assert.equal(pm.dueAt, localDueAtMs(noon, { hour: 18, minute: 0 }));

    const am = parseReminder('remind me at 6am to stretch', noon);
    assert.equal(am.ok, true);
    if (am.ok) {
      // 06:00 today is past at noon → tomorrow 06:00
      assert.equal(am.dueAt, localDueAtMs(noon, { dayOffset: 1, hour: 6, minute: 0 }));
    }

    const h24 = parseReminder('remind me at 18:00 to take bins out', noon);
    assert.equal(h24.ok, true);
    if (h24.ok) assert.equal(h24.dueAt, localDueAtMs(noon, { hour: 18, minute: 0 }));
  });

  it('absolute/ambiguous parse errors include exact supported-form examples', () => {
    const noon = localDueAtMs(now, { hour: 12, minute: 0 });

    const noTask = parseReminder('remind me at 6', noon);
    assert.equal(noTask.ok, false);
    if (!noTask.ok) {
      assert.equal(noTask.reason, 'missing_text');
      assert.match(noTask.message, /what should i remind you about/i);
      assert.match(noTask.message, /remind me at 6 to take the bins out/i);
    }

    const bad = parseReminder('remind me at tea time to stretch', noon);
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.reason, 'unsupported_time');
      assert.equal(bad.message, `I couldn't understand that time. ${REMINDER_TIME_EXAMPLES}`);
      assert.match(bad.message, /bare 1–7 → PM/i);
      assert.match(bad.message, /tomorrow at 9/i);
      assert.match(bad.message, /in 20 minutes/i);
    }

    const invalidHour = parseAbsoluteReminder('remind me at 25 to stretch', noon);
    assert.equal(invalidHour.ok, false);
    if (!invalidHour.ok) {
      assert.equal(invalidHour.reason, 'invalid_time');
      assert.equal(
        invalidHour.message,
        `That doesn't look like a valid time. ${REMINDER_TIME_EXAMPLES}`
      );
    }
  });

  it('parseReminder: first time phrase in the string wins (relative vs absolute)', () => {
    const noon = localDueAtMs(now, { hour: 12, minute: 0 });

    // Pure relative still works
    const pureRel = parseReminder('remind me in 20 minutes to check the oven', noon);
    assert.equal(pureRel.ok, true);
    if (pureRel.ok) {
      assert.equal(pureRel.dueAt, noon + 20 * 60_000);
      assert.equal(pureRel.text, 'check the oven');
    }

    // Relative phrase first → relative (keep "at 6" in the task)
    const relFirst = parseReminder('remind me in 20 minutes to meet at 6', noon);
    assert.equal(relFirst.ok, true);
    if (relFirst.ok) {
      assert.equal(relFirst.dueAt, noon + 20 * 60_000);
      assert.equal(relFirst.text, 'meet at 6');
    }

    // Absolute phrase first → absolute (ignore later "in 20 minutes")
    const absFirst = parseReminder(
      'remind me tomorrow at 9 in 20 minutes to call the dentist',
      noon
    );
    assert.equal(absFirst.ok, true);
    if (absFirst.ok) {
      assert.equal(absFirst.dueAt, localDueAtMs(noon, { dayOffset: 1, hour: 9, minute: 0 }));
      assert.equal(absFirst.text, 'call the dentist');
    }

    // "at 6 … in N minutes" → absolute wins (at comes first)
    const atThenIn = parseReminder('remind me at 6 in 20 minutes to stretch', noon);
    assert.equal(atThenIn.ok, true);
    if (atThenIn.ok) {
      assert.equal(atThenIn.dueAt, localDueAtMs(noon, { hour: 18, minute: 0 }));
      assert.equal(atThenIn.text, 'stretch');
    }
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
    clearAllReminderDeliveryInFlightForTests();
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
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'fired');
    assert.ok(store.reminders[0].deliveryAttemptAt != null);
    assert.ok(store.reminders[0].firedAt != null);
    const claimed = await claimReminderDelivery(1, now, filePath);
    assert.equal(claimed, null);
  });

  it('only one concurrent delivery claim wins', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'once',
      createdAt: now - 60_000,
      filePath,
    });

    const results = await Promise.all([
      claimReminderDelivery(1, now, filePath),
      claimReminderDelivery(1, now + 1, filePath),
      claimReminderDelivery(1, now + 2, filePath),
    ]);
    const winners = results.filter((r) => r != null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.status, 'delivering');
    assert.equal(winners[0]?.text, 'once');
    assert.ok(
      winners[0]?.deliveryAttemptAt === now ||
        winners[0]?.deliveryAttemptAt === now + 1 ||
        winners[0]?.deliveryAttemptAt === now + 2
    );

    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'delivering');

    const completed = await completeReminderDelivery(1, now + 10, filePath);
    assert.equal(completed?.status, 'fired');
    assert.equal(completed?.firedAt, now + 10);
  });

  it('releases claim on pre-send failure so a later tick can retry', async () => {
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
        throw new ReminderPreSendError('socket down');
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r1.delivered, 0);
    assert.equal(r1.failed, 1);
    assert.equal(r1.uncertain, 0);

    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'pending');
    assert.equal(store.reminders[0].deliveryAttemptAt, null);

    const sent = [];
    const r2 = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r2.delivered, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Reminder: fail me');
  });

  it('finalizes without retry when send error is uncertain (may have been accepted)', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'maybe sent',
      createdAt: now - 60_000,
      filePath,
    });

    const r1 = await runReminderDeliveryTick({
      sendText: async () => {
        throw new Error('connection reset after write');
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r1.delivered, 0);
    assert.equal(r1.failed, 0);
    assert.equal(r1.uncertain, 1);

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

  it('after simulated downtime, overdue reminders deliver once as late', async () => {
    // Reminder became due while the bot was offline; store still says pending.
    const dueAt = Date.parse('2026-09-06T11:00:00Z');
    const restartAt = Date.parse('2026-09-06T12:30:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt,
      text: 'take bins out',
      createdAt: dueAt - 60_000,
      filePath,
    });

    const due = await listDuePendingReminders(restartAt, filePath);
    assert.equal(due.length, 1);

    const sent = [];
    const r1 = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: restartAt,
      filePath,
    });
    assert.equal(r1.delivered, 1);
    assert.equal(sent[0].text, 'Reminder (late): take bins out');

    const r2 = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: restartAt + 1000,
      filePath,
    });
    assert.equal(r2.delivered, 0);
    assert.equal(sent.length, 1);

    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'fired');
  });

  it('settles stale delivering rows without re-send (crash mid-send)', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 10_000,
      text: 'crash mid-send',
      createdAt: now - 60_000,
      filePath,
    });
    const claimed = await claimReminderDelivery(1, now - STALE_DELIVERING_MS - 1, filePath);
    assert.equal(claimed?.status, 'delivering');
    // Simulate process crash: in-memory in-flight markers are gone.
    clearAllReminderDeliveryInFlightForTests();

    const sent = [];
    const r = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      filePath,
      staleMs: STALE_DELIVERING_MS,
    });
    assert.equal(r.settledStale, 1);
    assert.equal(r.delivered, 0);
    assert.equal(sent.length, 0);

    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'fired');
    assert.equal(store.reminders[0].firedAt, now);
  });

  it('fresh delivering rows are not settled or re-sent', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'in flight',
      createdAt: now - 60_000,
      filePath,
    });
    await claimReminderDelivery(1, now - 1000, filePath);

    const settled = await settleStaleDeliveries(now, {
      filePath,
      staleMs: STALE_DELIVERING_MS,
    });
    assert.equal(settled, 0);

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
    assert.equal((await readReminderStore(filePath)).reminders[0].status, 'delivering');

    await releaseReminderDelivery(1, filePath);
    assert.equal((await readReminderStore(filePath)).reminders[0].status, 'pending');
  });

  it('does not settle stale delivering while this process is still sending', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 10_000,
      text: 'long send',
      createdAt: now - 60_000,
      filePath,
    });
    // Claim with an ancient deliveryAttemptAt (would be stale without local marker).
    await claimReminderDelivery(1, now - STALE_DELIVERING_MS - 1, filePath);
    assert.equal(isReminderDeliveryInFlightLocally(1), true);

    const settled = await settleStaleDeliveries(now, {
      filePath,
      staleMs: STALE_DELIVERING_MS,
    });
    assert.equal(settled, 0);
    assert.equal((await readReminderStore(filePath)).reminders[0].status, 'delivering');

    // Simulate crash: drop local marker — then stale settle finalizes without re-send.
    clearAllReminderDeliveryInFlightForTests();
    const settledAfterCrash = await settleStaleDeliveries(now, {
      filePath,
      staleMs: STALE_DELIVERING_MS,
    });
    assert.equal(settledAfterCrash, 1);
    assert.equal((await readReminderStore(filePath)).reminders[0].status, 'fired');
  });

  it('loads v1 store rows missing deliveryAttemptAt', async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        nextId: 2,
        reminders: [
          {
            id: 1,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: 1,
            dueAt: 2,
            text: 'legacy',
            status: 'pending',
            firedAt: null,
          },
        ],
      }),
      'utf8'
    );
    const store = await readReminderStore(filePath);
    assert.equal(store.version, 2);
    assert.equal(store.reminders[0].deliveryAttemptAt, null);
    assert.equal(store.reminders[0].text, 'legacy');
  });

  it('migrates v1 store with mixed statuses; cancel/listDue/claim/settle behave', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        nextId: 5,
        reminders: [
          {
            id: 1,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 120_000,
            dueAt: now - 60_000,
            text: 'due pending',
            status: 'pending',
            firedAt: null,
          },
          {
            id: 2,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 120_000,
            dueAt: now + 60_000,
            text: 'upcoming',
            status: 'pending',
            firedAt: null,
          },
          {
            id: 3,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 200_000,
            dueAt: now - 180_000,
            text: 'already fired',
            status: 'fired',
            firedAt: now - 170_000,
          },
          {
            id: 4,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 90_000,
            dueAt: now - 30_000,
            text: 'was cancelled',
            status: 'cancelled',
            firedAt: null,
          },
        ],
      }),
      'utf8'
    );

    const store = await readReminderStore(filePath);
    assert.equal(store.version, 2);
    assert.equal(store.nextId, 5);
    assert.equal(store.reminders.length, 4);
    for (const rem of store.reminders) {
      assert.equal(rem.deliveryAttemptAt, null);
    }

    const listed = await listPendingReminders({ chatId: 'c1@s.whatsapp.net', filePath });
    assert.equal(listed.total, 2);
    assert.deepEqual(
      listed.reminders.map((r) => r.id),
      [1, 2]
    );

    const due = await listDuePendingReminders(now, filePath);
    assert.equal(due.length, 1);
    assert.equal(due[0].id, 1);

    const cancelled = await cancelReminder(2, { chatId: 'c1@s.whatsapp.net', filePath });
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.deliveryAttemptAt, null);

    // Crash mid-send on migrated pending row: claim, drop local marker, settle.
    const claimedStale = await claimReminderDelivery(1, now - STALE_DELIVERING_MS - 1, filePath);
    assert.equal(claimedStale?.status, 'delivering');
    assert.ok(claimedStale?.deliveryAttemptAt != null);
    clearAllReminderDeliveryInFlightForTests();
    const settled = await settleStaleDeliveries(now, {
      filePath,
      staleMs: STALE_DELIVERING_MS,
    });
    assert.equal(settled, 1);
    assert.equal((await readReminderStore(filePath)).reminders.find((r) => r.id === 1)?.status, 'fired');

    // Fresh pending after migration: claim → complete works.
    const created = await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'post-migrate',
      createdAt: now,
      filePath,
    });
    const claimed = await claimReminderDelivery(created.id, now, filePath);
    assert.equal(claimed?.status, 'delivering');
    assert.equal(claimed?.deliveryAttemptAt, now);
    const completed = await completeReminderDelivery(created.id, now + 1, filePath);
    assert.equal(completed?.status, 'fired');
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
      claimReminderDelivery(1, now, filePath),
    ]);
    const outcomes = [cancelled, claimed].filter((r) => r != null);
    assert.equal(outcomes.length, 1);

    const store = await readReminderStore(filePath);
    assert.ok(
      store.reminders[0].status === 'cancelled' || store.reminders[0].status === 'delivering'
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
    } else {
      await completeReminderDelivery(1, now, filePath);
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
    const claimedAfterCancel = await claimReminderDelivery(2, now, filePath);
    assert.equal(claimedAfterCancel, null);
  });

  it('legacy claimReminderFired remains pending→fired one-shot (not production path)', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'legacy fire',
      createdAt: now - 60_000,
      filePath,
    });
    const fired = await claimReminderFired(1, now, filePath);
    assert.equal(fired?.status, 'fired');
    assert.equal(fired?.firedAt, now);
    assert.equal(await claimReminderFired(1, now, filePath), null);
    assert.equal(await claimReminderDelivery(1, now, filePath), null);
  });

  it('truncateReminderText caps length with ellipsis', () => {
    assert.equal(truncateReminderText('short', 10), 'short');
    assert.equal(truncateReminderText('abcdefghij', 10), 'abcdefghij');
    assert.equal(truncateReminderText('abcdefghijk', 10), 'abcdefghi…');
    // Does not trim — only truncates
    assert.equal(truncateReminderText('  hi  ', 10), '  hi  ');
    assert.equal(truncateReminderText('  abcdefghijk', 10), '  abcdefg…');
    assert.equal(DEFAULT_REMINDER_MAX_TEXT_CHARS, 500);
  });

  it('addReminder truncates long text to the configured max', async () => {
    const long = 'x'.repeat(600);
    const rem = await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: Date.now() + 60_000,
      text: long,
      filePath,
      caps: { ...getReminderSafetyCaps(), maxTextChars: 40 },
    });
    assert.equal(rem.text.length, 40);
    assert.equal(rem.text.endsWith('…'), true);
    assert.equal(rem.text, truncateReminderText(long, 40));
  });

  it('rejects when pending reminders per chat are at the cap', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const caps = {
      ...getReminderSafetyCaps(),
      maxPendingPerChat: 2,
      maxHorizonMs: null,
      maxHorizonDays: null,
    };
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + 60_000,
      text: 'one',
      createdAt: now,
      filePath,
      caps,
    });
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + 120_000,
      text: 'two',
      createdAt: now,
      filePath,
      caps,
    });
    // Other chat is independent
    await addReminder({
      chatId: 'c2@s.whatsapp.net',
      dueAt: now + 60_000,
      text: 'other',
      createdAt: now,
      filePath,
      caps,
    });

    await assert.rejects(
      () =>
        addReminder({
          chatId: 'c1@s.whatsapp.net',
          dueAt: now + 180_000,
          text: 'three',
          createdAt: now,
          filePath,
          caps,
        }),
      (err) => {
        assert.equal(isReminderLimitError(err), true);
        assert.equal(/** @type {ReminderLimitError} */ (err).reason, 'pending_cap');
        assert.match(err.message, /already has 2 pending reminders/i);
        assert.match(err.message, /cancel reminder #ID/i);
        return true;
      }
    );

    const listed = await listPendingReminders({ chatId: 'c1@s.whatsapp.net', filePath });
    assert.equal(listed.total, 2);
    assert.equal(DEFAULT_REMINDER_MAX_PENDING_PER_CHAT, 25);
  });

  it('rejects reminders beyond the configured horizon', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const caps = {
      ...getReminderSafetyCaps(),
      maxHorizonMs: 2 * dayMs,
      maxHorizonDays: 2,
    };
    await assert.rejects(
      () =>
        addReminder({
          chatId: 'c1@s.whatsapp.net',
          dueAt: now + 3 * dayMs,
          text: 'too far',
          createdAt: now,
          filePath,
          caps,
        }),
      (err) => {
        assert.equal(isReminderLimitError(err), true);
        assert.equal(/** @type {ReminderLimitError} */ (err).reason, 'horizon');
        assert.match(err.message, /too far ahead/i);
        assert.match(err.message, /max 2 days/i);
        return true;
      }
    );
    // Within horizon is fine
    const ok = await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + dayMs,
      text: 'soon enough',
      createdAt: now,
      filePath,
      caps,
    });
    assert.equal(ok.text, 'soon enough');
  });

  it('horizon error message uses configured fractional days (not Math.round)', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const caps = getReminderSafetyCaps({ REMINDERS_MAX_HORIZON_DAYS: '1.5' });
    assert.equal(caps.maxHorizonDays, 1.5);
    assert.equal(caps.maxHorizonMs, Math.floor(1.5 * dayMs));
    await assert.rejects(
      () =>
        addReminder({
          chatId: 'c1@s.whatsapp.net',
          dueAt: now + 2 * dayMs,
          text: 'too far',
          createdAt: now,
          filePath,
          caps,
        }),
      (err) => {
        assert.equal(/** @type {ReminderLimitError} */ (err).reason, 'horizon');
        // Must not round 1.5 up to "2 days"
        assert.match(err.message, /max 1\.5 days/i);
        assert.doesNotMatch(err.message, /max 2 days/i);
        return true;
      }
    );
  });

  it('getReminderSafetyCaps reads optional horizon from env days', () => {
    const capped = getReminderSafetyCaps({
      REMINDERS_MAX_HORIZON_DAYS: '365',
      REMINDERS_MAX_TEXT_CHARS: '100',
      REMINDERS_MAX_PENDING_PER_CHAT: '10',
    });
    assert.equal(capped.maxHorizonMs, 365 * 24 * 60 * 60 * 1000);
    assert.equal(capped.maxHorizonDays, 365);
    assert.equal(capped.maxTextChars, 100);
    assert.equal(capped.maxPendingPerChat, 10);

    const unlimited = getReminderSafetyCaps({ REMINDERS_MAX_HORIZON_DAYS: '' });
    assert.equal(unlimited.maxHorizonMs, null);
    assert.equal(unlimited.maxHorizonDays, null);
  });

  it('addReminder does not prune recent terminal rows using backdated createdAt', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const caps = {
      ...getReminderSafetyCaps(),
      terminalRetentionMs: dayMs,
      maxTerminal: 100,
      maxHorizonMs: null,
      maxHorizonDays: null,
    };
    // Recent fired row: within retention relative to wall clock `now`,
    // but far past retention if prune incorrectly used backdated createdAt.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        nextId: 2,
        reminders: [
          {
            id: 1,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 2 * dayMs,
            dueAt: now - 60_000,
            text: 'keep me',
            status: 'fired',
            deliveryAttemptAt: now - 30_000,
            firedAt: now - 30_000,
          },
        ],
      }),
      'utf8'
    );

    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + 60_000,
      text: 'new',
      createdAt: now - 10 * dayMs,
      nowMs: now,
      filePath,
      caps,
    });

    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 2);
    assert.ok(store.reminders.some((r) => r.status === 'fired' && r.text === 'keep me'));
    assert.ok(store.reminders.some((r) => r.status === 'pending' && r.text === 'new'));
  });

  it('addReminder prunes terminal rows before enforcing the pending cap', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const caps = {
      ...getReminderSafetyCaps(),
      maxPendingPerChat: 1,
      terminalRetentionMs: 60_000,
      maxTerminal: 100,
      maxHorizonMs: null,
      maxHorizonDays: null,
    };
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        nextId: 3,
        reminders: [
          {
            id: 1,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 120_000,
            dueAt: now - 90_000,
            text: 'still pending',
            status: 'pending',
            deliveryAttemptAt: null,
            firedAt: null,
          },
          {
            id: 2,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 200_000,
            dueAt: now - 180_000,
            text: 'stale fired',
            status: 'fired',
            deliveryAttemptAt: now - 150_000,
            firedAt: now - 150_000,
          },
        ],
      }),
      'utf8'
    );

    await assert.rejects(
      () =>
        addReminder({
          chatId: 'c1@s.whatsapp.net',
          dueAt: now + 60_000,
          text: 'blocked',
          createdAt: now,
          nowMs: now,
          filePath,
          caps,
        }),
      (err) => {
        assert.equal(/** @type {ReminderLimitError} */ (err).reason, 'pending_cap');
        return true;
      }
    );

    // Cap reject still compacted terminal rows (prune ran before the check).
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 1);
    assert.equal(store.reminders[0].status, 'pending');
    assert.equal(store.reminders[0].text, 'still pending');
  });

  it('prunes old fired/cancelled reminders while keeping pending', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const caps = {
      ...getReminderSafetyCaps(),
      terminalRetentionMs: 60_000,
      maxTerminal: 100,
    };

    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + 60_000,
      text: 'keep pending',
      createdAt: now,
      nowMs: now,
      filePath,
      caps,
    });
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 10_000,
      text: 'old fired',
      createdAt: now - 120_000,
      nowMs: now,
      filePath,
      caps,
    });
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now + 120_000,
      text: 'will cancel',
      createdAt: now - 120_000,
      nowMs: now,
      filePath,
      caps,
    });
    // Finalize after all adds so prune-on-add does not compact mid-setup.
    await claimReminderFired(2, now - 90_000, filePath);
    await cancelReminder(3, { chatId: 'c1@s.whatsapp.net', filePath });

    const removed = await pruneTerminalReminders({ nowMs: now, filePath, caps });
    assert.equal(removed, 2);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 1);
    assert.equal(store.reminders[0].status, 'pending');
    assert.equal(store.reminders[0].text, 'keep pending');
  });

  it('enforces maxTerminal even when within retention', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    const caps = {
      ...getReminderSafetyCaps(),
      terminalRetentionMs: 24 * 60 * 60 * 1000,
      maxTerminal: 2,
    };
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        nextId: 5,
        reminders: [0, 1, 2, 3].map((i) => ({
          id: i + 1,
          chatId: 'c1@s.whatsapp.net',
          actorId: null,
          createdAt: now - (4 - i) * 1000,
          dueAt: now - (4 - i) * 1000,
          text: `done-${i}`,
          status: 'fired',
          deliveryAttemptAt: now - (4 - i) * 500,
          firedAt: now - (4 - i) * 500,
        })),
      }),
      'utf8'
    );
    const removed = await pruneTerminalReminders({ nowMs: now, filePath, caps });
    assert.equal(removed, 2);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 2);
    assert.deepEqual(
      store.reminders.map((r) => r.text).sort(),
      ['done-2', 'done-3']
    );
  });

  it('delivery tick prunes terminal rows after send', async () => {
    const now = Date.parse('2026-09-06T12:00:00Z');
    // Seed an old fired row directly, then deliver a due pending one.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        nextId: 3,
        reminders: [
          {
            id: 1,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 10 * 24 * 60 * 60 * 1000,
            dueAt: now - 10 * 24 * 60 * 60 * 1000,
            text: 'ancient',
            status: 'fired',
            deliveryAttemptAt: now - 10 * 24 * 60 * 60 * 1000,
            firedAt: now - 10 * 24 * 60 * 60 * 1000,
          },
          {
            id: 2,
            chatId: 'c1@s.whatsapp.net',
            actorId: null,
            createdAt: now - 60_000,
            dueAt: now - 1000,
            text: 'due now',
            status: 'pending',
            deliveryAttemptAt: null,
            firedAt: null,
          },
        ],
      }),
      'utf8'
    );

    const sent = [];
    const r = await runReminderDeliveryTick({
      sendText: async (chatId, text) => {
        sent.push({ chatId, text });
      },
      nowMs: now,
      filePath,
    });
    assert.equal(r.delivered, 1);
    assert.ok(r.pruned >= 1);
    assert.equal(sent[0].text, 'Reminder: due now');
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.some((x) => x.text === 'ancient'), false);
    assert.equal(store.reminders.length, 1);
    assert.equal(store.reminders[0].status, 'fired');
    assert.equal(store.reminders[0].text, 'due now');
  });
});

describe('reminderScheduler lifecycle', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let filePath;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reminders-sched-'));
    filePath = join(dir, 'reminders.json');
  });

  afterEach(async () => {
    stopReminderScheduler();
    resetReminderSchedulerInFlightForTests();
    clearAllReminderDeliveryInFlightForTests();
    await rm(dir, { recursive: true, force: true });
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

  it('immediate tick on start catches overdue reminders after restart', async () => {
    const now = Date.now();
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 5 * 60_000,
      text: 'catch up',
      createdAt: now - 10 * 60_000,
      filePath,
    });

    const sent = [];
    /** @type {any} */
    const fakeSock = {
      sendMessage: async (chatId, content) => {
        sent.push({ chatId, text: content.text });
      },
    };

    startReminderScheduler({
      getSocket: () => fakeSock,
      pollMs: 60_000,
      filePath,
    });

    await new Promise((r) => setTimeout(r, 80));
    stopReminderScheduler();

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Reminder \(late\): catch up/);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders[0].status, 'fired');
  });

  it('overlapping ticks / reconnect cannot double-claim the same reminder', async () => {
    const now = Date.now();
    await addReminder({
      chatId: 'c1@s.whatsapp.net',
      dueAt: now - 1000,
      text: 'once only',
      createdAt: now - 60_000,
      filePath,
    });

    /** @type {{ resolve: () => void }} */
    const gate = { resolve: () => {} };
    const releaseSend = new Promise((resolve) => {
      gate.resolve = resolve;
    });
    const sent = [];
    /** @type {any} */
    const fakeSock = {
      sendMessage: async (chatId, content) => {
        sent.push({ chatId, text: content.text });
        await releaseSend;
      },
    };

    startReminderScheduler({
      getSocket: () => fakeSock,
      pollMs: 20,
      filePath,
    });

    // Wait until first tick has claimed and entered send.
    for (let i = 0; i < 50 && sent.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(sent.length, 1);
    assert.equal(isReminderSchedulerTickInFlight(), true);

    // Reconnect while first send is still blocked: must not start a second tick.
    startReminderScheduler({
      getSocket: () => fakeSock,
      pollMs: 20,
      filePath,
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sent.length, 1);
    assert.equal((await readReminderStore(filePath)).reminders[0].status, 'delivering');

    // Overlapping runReminderDeliveryTick also cannot double-claim.
    const parallel = await Promise.all([
      runReminderDeliveryTick({
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        nowMs: now,
        filePath,
      }),
      runReminderDeliveryTick({
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
        },
        nowMs: now,
        filePath,
      }),
    ]);
    assert.equal(
      parallel.reduce((n, r) => n + r.delivered, 0),
      0
    );
    assert.equal(sent.length, 1);

    gate.resolve();
    for (let i = 0; i < 50; i++) {
      const store = await readReminderStore(filePath);
      if (store.reminders[0].status === 'fired') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    stopReminderScheduler();
    assert.equal(sent.length, 1);
    assert.equal((await readReminderStore(filePath)).reminders[0].status, 'fired');
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

  it('shouldTryReminderAgent matches create/list/cancel/help', () => {
    assert.equal(shouldTryReminderAgent('nudge me in 5 minutes to go'), true);
    assert.equal(shouldTryReminderAgent('list reminders'), true);
    assert.equal(shouldTryReminderAgent('cancel reminder 2'), true);
    assert.equal(shouldTryReminderAgent('reminder help'), true);
    assert.equal(shouldTryReminderAgent('!reminders'), true);
    assert.equal(shouldTryReminderAgent('hello'), false);
  });

  it('returns reminder help examples without requiring allowlist', async () => {
    const r = await runReminderAgent(
      {
        text: 'reminder help',
        chatId: 'c@s.whatsapp.net',
        actorId: 'stranger@s.whatsapp.net',
      },
      {
        isAllowedActor: () => false,
        filePath,
      }
    );
    assert.equal(r.handled, true);
    assert.equal(r.replyText, REMINDER_HELP_TEXT);
    assert.match(r.replyText, /list reminders/i);
    assert.match(r.replyText, /cancel reminder 3/i);
    assert.match(r.replyText, /cancel #3/i);
    assert.match(r.replyText, /remind me at 6/i);
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

  it('creates absolute-time reminder (at 6 → next 18:00)', async () => {
    const noon = Date.parse('2026-09-06T12:00:00+01:00');
    const r = await runReminderAgent(
      {
        text: 'remind me at 6 to take the bins out',
        chatId: 'c@s.whatsapp.net',
        actorId: 'owner@s.whatsapp.net',
      },
      {
        isAllowedActor: () => true,
        nowMs: noon,
        filePath,
      }
    );
    assert.equal(r.handled, true);
    assert.match(r.replyText, /OK — I'll remind you at 18:00 today: take the bins out \(#1\)/);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 1);
    assert.equal(store.reminders[0].dueAt, localDueAtMs(noon, { hour: 18, minute: 0 }));
  });

  it('surfaces supported-form examples on invalid create input', async () => {
    const r = await runReminderAgent(
      {
        text: 'remind me at tea time to stretch',
        chatId: 'c@s.whatsapp.net',
        actorId: 'owner@s.whatsapp.net',
      },
      {
        isAllowedActor: () => true,
        filePath,
      }
    );
    assert.equal(r.handled, true);
    assert.equal(r.replyText, `I couldn't understand that time. ${REMINDER_TIME_EXAMPLES}`);
    assert.match(r.replyText, /bare 1–7 → PM/i);
    const store = await readReminderStore(filePath);
    assert.equal(store.reminders.length, 0);
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
  it('surfaces pending-cap and horizon errors to allowlisted actors', async () => {
    const now = Date.parse('2026-09-06T15:00:00+01:00');
    const prevHorizon = process.env.REMINDERS_MAX_HORIZON_DAYS;
    const prevPending = process.env.REMINDERS_MAX_PENDING_PER_CHAT;
    process.env.REMINDERS_MAX_PENDING_PER_CHAT = '1';
    process.env.REMINDERS_MAX_HORIZON_DAYS = '1';
    try {
      await addReminder({
        chatId: 'c@s.whatsapp.net',
        dueAt: now + 10 * 60_000,
        text: 'first',
        createdAt: now,
        filePath,
      });
      const capped = await runReminderAgent(
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
      assert.equal(capped.handled, true);
      assert.match(capped.replyText, /already has 1 pending reminder/i);

      // Free the slot, then exceed horizon via a huge relative delay.
      await cancelReminder(1, { chatId: 'c@s.whatsapp.net', filePath });
      const far = await runReminderAgent(
        {
          text: 'remind me in 99999 hours to stretch',
          chatId: 'c@s.whatsapp.net',
          actorId: 'owner@s.whatsapp.net',
        },
        {
          isAllowedActor: () => true,
          nowMs: now,
          filePath,
        }
      );
      assert.equal(far.handled, true);
      assert.match(far.replyText, /too far ahead/i);
      assert.match(far.replyText, /max 1 day/i);
    } finally {
      if (prevHorizon === undefined) delete process.env.REMINDERS_MAX_HORIZON_DAYS;
      else process.env.REMINDERS_MAX_HORIZON_DAYS = prevHorizon;
      if (prevPending === undefined) delete process.env.REMINDERS_MAX_PENDING_PER_CHAT;
      else process.env.REMINDERS_MAX_PENDING_PER_CHAT = prevPending;
    }
  });

  it('creates reminder with truncated text when over max chars', async () => {
    const now = Date.parse('2026-09-06T15:00:00+01:00');
    const prev = process.env.REMINDERS_MAX_TEXT_CHARS;
    process.env.REMINDERS_MAX_TEXT_CHARS = '30';
    try {
      const longTask = 'x'.repeat(80);
      const r = await runReminderAgent(
        {
          text: `nudge me in 5 minutes to ${longTask}`,
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
      assert.match(r.replyText, /…/);
      const store = await readReminderStore(filePath);
      assert.equal(store.reminders[0].text.length, 30);
    } finally {
      if (prev === undefined) delete process.env.REMINDERS_MAX_TEXT_CHARS;
      else process.env.REMINDERS_MAX_TEXT_CHARS = prev;
    }
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
