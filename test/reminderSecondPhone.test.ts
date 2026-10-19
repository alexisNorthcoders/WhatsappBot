import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runReminderAgent } from '../whatsapp/agents/reminderAgent.ts';
import { createLastLists } from '../whatsapp/calendar/lastLists.ts';
import { runNudgeTick } from '../whatsapp/calendar/nudgeTick.ts';
import {
  clearOwnerLids,
  isAllowedActor,
  resolveOwnerLids,
  secondPhoneJid,
} from '../whatsapp/whatsAppActorAllowlist.ts';
import { createFakeCalendar } from './helpers/fakeCalendar.ts';

const MIN = 60_000;
// Sat 17 Oct 2026, 14:00 in London (BST).
const NOW = Date.parse('2026-10-17T14:00:00+01:00');
const OWNER = '447700900001@s.whatsapp.net';
const OWNER_LID = '111111111111111@lid';
const EXTRA_LID = '333333333333333@lid';
const SECOND = '447700900002@s.whatsapp.net';
const SECOND_LID = '222222222222222@lid';
const STRANGER = '447700900999@s.whatsapp.net';
const ENV_KEYS = ['MY_PHONE', 'SECOND_PHONE', 'CLAUDE_AGENT_EXTRA_JIDS'];

const TEXT = 'Remind me in 30 minutes to feed the cat';
const extractReminder = async () => ({
  ok: (true as const),
  title: 'Feed the cat',
  start: '2026-10-17T14:30',
  allDay: false,
  kind: ('remind' as const),
});

describe('SECOND_PHONE manages Reminders and is Nudged for its own (#129)', () => {
  let saved;
  let dir: string;
  let calendar: ReturnType<typeof createFakeCalendar>;
  let lastLists: ReturnType<typeof createLastLists>;

  /** The production wiring of the reminder agent's access and creator deps. */
  const send = (text: string,m: object) =>
    runReminderAgent(
      { text, chatId: SECOND, actorId: SECOND, ...m },
      {
        isAllowedActor,
        creatorIdFor: (actorId, actorAltId) => secondPhoneJid(actorId, actorAltId) ?? actorId,
        calendar,
        extractReminder,
        lastLists,
        nowMs: NOW,
      }
    );

  /** Who is Nudged when the reminder comes due. */
  const nudgedChats = async () => {
    const chats: string[] = [];
    await runNudgeTick({
      calendar,
      ownerChatId: OWNER,
      creatorChatId: (id) => secondPhoneJid(id),
      sendText: async (chatId) => {
        chats.push(chatId);
      },
      nowMs: NOW + 30 * MIN,
      logPath: join(dir, 'nudged.json'),
    });
    return chats.sort();
  };

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.MY_PHONE = '447700900001';
    process.env.SECOND_PHONE = '447700900002';
    process.env.CLAUDE_AGENT_EXTRA_JIDS = EXTRA_LID;
    clearOwnerLids();
    dir = await mkdtemp(join(tmpdir(), 'second-phone-'));
    calendar = createFakeCalendar({ defaultOffsetsMin: [10] });
    lastLists = createLastLists();
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearOwnerLids();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates, lists and cancels Reminders on the Owner\'s calendar', async () => {
    const created = await send(TEXT, {});
    assert.equal(created.handled, true);
    assert.equal(calendar.all().length, 1);
    const listed = await send('list reminders', {});
    assert.match(listed.replyText, /Feed the cat/);
    const cancelled = await send('cancel 1', {});
    assert.match(cancelled.replyText, /Feed the cat/);
    assert.equal(calendar.all().length, 0);
  });

  it('a Reminder SECOND_PHONE creates Nudges both the owner and SECOND_PHONE', async () => {
    await send(TEXT, {});
    assert.equal(calendar.all()[0].creatorActorId, SECOND);
    assert.deepEqual(await nudgedChats(), [OWNER, SECOND]);
  });

  it('records SECOND_PHONE as the creator when it writes from a LID', async () => {
    await send(TEXT, { actorId: SECOND_LID, actorAltId: SECOND, chatId: SECOND_LID });
    assert.equal(calendar.all()[0].creatorActorId, SECOND);
    assert.deepEqual(await nudgedChats(), [OWNER, SECOND]);
  });

  it('a SECOND_PHONE LID resolved from the mapping store also Nudges SECOND_PHONE', async () => {
    await resolveOwnerLids(
      { signalRepository: { lidMapping: { getLIDForPN: async (pn) => (pn === SECOND ? SECOND_LID : OWNER_LID) } } },
      { logger: { warn() {}, info() {} } }
    );
    await send(TEXT, { actorId: SECOND_LID, chatId: SECOND_LID });
    assert.equal(calendar.all()[0].creatorActorId, SECOND);
    assert.deepEqual(await nudgedChats(), [OWNER, SECOND]);
  });

  it('Reminders by the owner (phone, resolved LID or CLAUDE_AGENT_EXTRA_JIDS) Nudge only the owner', async () => {
    await resolveOwnerLids(
      { signalRepository: { lidMapping: { getLIDForPN: async (pn) => (pn === OWNER ? OWNER_LID : SECOND_LID) } } },
      { logger: { warn() {}, info() {} } }
    );
    for (const actorId of [OWNER, OWNER_LID, EXTRA_LID]) {
      const r = await send(TEXT, { actorId, chatId: actorId });
      assert.equal(r.handled, true, actorId);
    }
    assert.equal(calendar.all().length, 3);
    assert.deepEqual(await nudgedChats(), [OWNER]);
  });

  it('a Reminder not created by the bot Nudges only the owner', async () => {
    calendar.seed({ title: 'From Google', startMs: NOW + 30 * MIN });
    assert.deepEqual(await nudgedChats(), [OWNER]);
  });

  it('refuses strangers for create, list and cancel; help still works', async () => {
    for (const text of [TEXT, 'list reminders', 'cancel 1']) {
      const r = await send(text, { actorId: STRANGER, chatId: STRANGER });
      assert.match(r.replyText, /Not allowed to manage reminders/, text);
    }
    assert.equal(calendar.all().length, 0);
    const help = await send('reminder help', { actorId: STRANGER, chatId: STRANGER });
    assert.equal(help.handled, true);
    assert.doesNotMatch(help.replyText, /Not allowed/);
  });
});
