import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runReminderAgent, routedReminderIntent, shouldTryReminderAgent } from '../whatsapp/agents/reminderAgent.ts';
import { classifyReminderIntent } from '../whatsapp/calendar/reminderIntent.ts';
import { createLastLists } from '../whatsapp/calendar/lastLists.ts';
import { runAgentsChainSequential } from '../whatsapp/orchestration/agentsTryHandle.ts';
import type { AgentChainDeps } from '../whatsapp/orchestration/agentsTryHandle.ts';
import type { ExtractReminder } from '../whatsapp/calendar/reminderExtraction.ts';
import { createFakeCalendar } from './helpers/fakeCalendar.ts';

// Sat 17 Oct 2026, 14:00 in London (BST), as in reminderCalendarManage.test.ts.
const NOW = Date.parse('2026-10-17T14:00:00+01:00');
const OWNER = '447700900001@s.whatsapp.net';
const at = (local: string) => Date.parse(`${local}+01:00`);

function seededCalendar() {
  const calendar = createFakeCalendar();
  calendar.seed({ id: 'later', title: 'Haircut', startMs: at('2026-10-17T16:00:00') });
  calendar.seed({ id: 'gym', title: 'Gym', startMs: at('2026-10-18T19:00:00'), endMs: at('2026-10-18T20:00:00') });
  calendar.seed({ id: 'dentist', title: 'Dentist', startMs: at('2026-10-23T15:00:00'), endMs: at('2026-10-23T16:00:00') });
  calendar.seed({ id: 'swim', title: 'Swimming', startMs: at('2026-10-22T18:00:00'), endMs: at('2026-10-22T19:00:00') });
  return calendar;
}

const notReminder: ExtractReminder = async () => ({ ok: false, notReminder: true });
const noExtraction: ExtractReminder = async () => {
  throw new Error('extraction should not run');
};

function send(text: string, deps: object = {}) {
  return runReminderAgent(
    { text, chatId: OWNER, actorId: OWNER },
    { nowMs: NOW, isAllowedActor: () => true, extractReminder: noExtraction, ...deps },
  );
}

describe('reminder intents: wider phrasing (routed reminder messages)', () => {
  it('reads list windows for weekdays, the weekend and polite or terse phrasing', () => {
    const cases = {
      'what do i have on thursday': 'thursday',
      'any events on wednesday': 'wednesday',
      "what's happening this friday": 'friday',
      'can u check my cal for tomorrow pls': 'tomorrow',
      "what's on my cal for next week??": 'nextWeek',
      'any appointments tomorrow morning': 'tomorrow',
      'what have I got on this weekend': 'weekend',
      'Reminders for Sunday?': 'sunday',
      'Agenda for tomorrow': 'tomorrow',
      'u got any reminders for today? 📱': 'today',
      'check my schedule for next mon': 'monday',
      'what have I got on for this afternoon': 'today',
    };
    for (const [text, window] of Object.entries(cases)) {
      assert.deepEqual(classifyReminderIntent(text), { kind: 'list', window }, text);
    }
    for (const text of ['anything coming up?', "what's on my calendar", 'show me my schedule for the next 7 days']) {
      assert.deepEqual(classifyReminderIntent(text), { kind: 'list', window: 'upcoming' }, text);
    }
  });

  it('reads cancel N with polite padding, ordinals and "from my list"', () => {
    const cases: [string, number][] = [
      ['pls cancel #3', 3],
      ['delete 1 pls', 1],
      ['remove #1 pls thx', 1],
      ['delete the 3rd', 3],
      ['delete item 10', 10],
      ['cancel number 2 on my list please', 2],
      ['can i cancel 4?', 4],
      ['can u remove reminder 2', 2],
      ['i dont want reminder 4 anymore', 4],
      ['delete item 5 from my list', 5],
      ['pls take off #5', 5],
      ['i messed up, delete 2', 2],
      ['scrap the second one', 2],
    ];
    for (const [text, n] of cases) assert.deepEqual(classifyReminderIntent(text), { kind: 'cancel', n }, text);
  });

  it('reads create requests without "remind me"', () => {
    for (const text of [
      'set a reminder in one hour to feed the cat',
      'Would you mind setting a reminder for the 27th? That’s Grandad’s birthday',
      'reminder to buy milk & bread tmrw morning pls',
      'Remind in 4 hours',
      "don't let me miss the start of the football match tmrw night ⚽️",
      "can u make sure I don't forget to pay the Council Tax tmrw? 🙏",
      "pls put 'dry clean clothes' on the cal for tomorrow evening",
      'pls add ‘family picnic’ as all-day event on 20th july',
      'Could you add an event for the school play on Thursday evening? It starts at 6:30pm.',
      'Could you give me a shout in 15 minutes to take the bins out?',
    ]) {
      assert.deepEqual(classifyReminderIntent(text), { kind: 'create' }, text);
      assert.equal(shouldTryReminderAgent(text), true, text);
    }
  });

  it('still leaves look-alikes alone', () => {
    for (const text of [
      'remove 2 eggs from the list',
      'cancel the 3 meetings please',
      'remind me how to set the timer on the oven',
      'i set a reminder for the school run but now i can’t find my notes',
      'was gonna set a reminder but the lights flickered',
      'Can you please add a reminder to the grocery list note to pick up some tea',
      'could you add the local charity event details to the community notes?',
      "what's on TV tonight",
      'what is on my mind',
      'when is Easter next year',
    ]) {
      assert.equal(classifyReminderIntent(text), null, text);
    }
  });
});

describe('reminder agent: messages the router sent here', () => {
  it('lists a weekday from the calendar', async () => {
    const r = await send('what do i have on thursday', { calendar: seededCalendar(), lastLists: createLastLists() });
    assert.equal(r.handled, true);
    assert.match(r.replyText, /^Thu 22 Oct:\n1\. Thu 22 Oct 18:00–19:00: Swimming/);
  });

  it('lists the weekend from now', async () => {
    const r = await send('what have I got on this weekend', { calendar: seededCalendar(), lastLists: createLastLists() });
    assert.match(r.replyText, /^This weekend \(Sat 17 Oct – Sun 18 Oct\):/);
    assert.match(r.replyText, /1\. Sat 17 Oct 16:00–16:30: Haircut/);
    assert.match(r.replyText, /2\. Sun 18 Oct 19:00–20:00: Gym/);
  });

  it('guesses for a routed message its own check misses, and falls through when the guess is wrong', async () => {
    const calendar = seededCalendar();
    // without the router, "School play Friday" (no time) isn't the agent's
    assert.equal((await send('School play Friday', { calendar })).handled, false);
    const asked: string[] = [];
    const extractReminder: ExtractReminder = async ({ text }) => {
      asked.push(text);
      return { ok: true, title: 'School play', start: '2026-10-23', allDay: true, kind: 'appointment' };
    };
    const r = await send('School play Friday', { calendar, extractReminder, routed: true });
    assert.equal(r.handled, true);
    assert.deepEqual(asked, ['School play Friday']);
    assert.ok(calendar.all().some((e) => e.title === 'School play'));
    // the extractor turning it down hands the message to chat
    assert.equal((await send('Eve is so funny', { calendar, extractReminder: notReminder, routed: true })).handled, false);
  });

  it('answers a routed calendar question with the upcoming list', async () => {
    assert.deepEqual(routedReminderIntent('tmrw’s plan? anything i need to remember? 🙃'), { kind: 'list', window: 'upcoming' });
    assert.deepEqual(routedReminderIntent('can you add the dentist on the 15th?'), { kind: 'create' });
    const r = await send('tmrw’s plan? anything i need to remember? 🙃', {
      calendar: seededCalendar(),
      lastLists: createLastLists(),
      routed: true,
    });
    assert.match(r.replyText, /^Upcoming reminders:/);
  });

  it('a guess still falls through for someone not allowed, or without a calendar', async () => {
    const notAllowed = await send('School play Friday', { routed: true, isAllowedActor: () => false, calendar: seededCalendar() });
    assert.equal(notAllowed.handled, false);
    assert.equal((await send('School play Friday', { routed: true })).handled, false);
  });
});

describe('agent chain: the reminder agent knows when the router picked it', () => {
  function deps(routeIntent?: AgentChainDeps['routeIntent']) {
    const seen: (boolean | undefined)[] = [];
    const run = async () => 'x';
    const d: AgentChainDeps = {
      logger: { error: () => {} },
      messaging: { sendText: async () => {} },
      chatMemory: { append: async () => {} },
      routeIntent,
      shouldTryReminderAgent: () => true,
      runReminderAgent: async (_m, opts) => {
        seen.push(opts?.routed);
        return { handled: true, replyText: 'ok' };
      },
      shouldTryLightsAgent: () => false,
      runLightsAgent: run,
      LIGHTS_AGENT_SKIP: 'SKIP',
      shouldTryWeatherAgent: () => false,
      runWeatherAgent: run,
      WEATHER_AGENT_SKIP: 'SKIP',
      shouldTryJoplinAgent: () => false,
      runJoplinAgent: run,
      JOPLIN_AGENT_SKIP: 'SKIP',
      shouldTryEmailAgent: () => false,
      runEmailAgent: run,
      EMAIL_AGENT_SKIP: 'SKIP',
    };
    return { d, seen };
  }
  const m = { id: '1', chatId: 'c', actorId: OWNER, actorAltId: null, text: 'what do i have on thursday', raw: {}, features: {} } as never;

  it('passes routed: true after a reminder route, false on the keyword gates', async () => {
    const routed = deps(async () => ({ agent: 'reminder', probability: 0.9, answers: {} }));
    await runAgentsChainSequential(m, routed.d);
    assert.deepEqual(routed.seen, [true]);
    const gates = deps();
    await runAgentsChainSequential(m, gates.d);
    assert.deepEqual(gates.seen, [false]);
  });
});
