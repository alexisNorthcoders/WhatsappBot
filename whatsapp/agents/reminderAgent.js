import { lidExtraJidsHint } from '../whatsAppActorAllowlist.js';
import {
  classifyReminderIntent,
  formatReminderDue,
  parseCancelReminder,
  parseReminder,
} from '../reminders/reminderParser.js';
import {
  addReminder,
  cancelReminder,
  listPendingReminders,
} from '../reminders/reminderStore.js';

/**
 * @param {string} text
 * @returns {boolean}
 */
export function shouldTryReminderAgent(text) {
  return classifyReminderIntent(text) != null;
}

/**
 * @param {{ id: number, dueAt: number, text: string }[]} reminders
 * @param {number} nowMs
 * @param {{ total?: number, limit?: number }} [meta]
 * @returns {string}
 */
function formatUpcomingList(reminders, nowMs, meta = {}) {
  if (!reminders.length) return 'No upcoming reminders.';
  const lines = reminders.map(
    (r) => `#${r.id} — ${formatReminderDue(r.dueAt, nowMs)}: ${r.text}`
  );
  const total = meta.total ?? reminders.length;
  const limit = meta.limit ?? reminders.length;
  if (total > reminders.length) {
    const more = total - reminders.length;
    lines.push(`…and ${more} more (showing soonest ${limit}).`);
  }
  return `Upcoming reminders:\n${lines.join('\n')}`;
}

/**
 * Handle reminder create / list / cancel (allowlisted actors only).
 * @param {{
 *   text: string,
 *   chatId: string,
 *   actorId: string | null,
 * }} m
 * @param {{
 *   isAllowedActor: (actorId: string | null) => boolean,
 *   nowMs?: number,
 *   filePath?: string,
 * }} deps
 * @returns {Promise<{ handled: boolean, replyText: string }>}
 */
export async function runReminderAgent(m, deps) {
  const text = m.text;
  const intent = classifyReminderIntent(text);
  if (!intent) {
    return { handled: false, replyText: '' };
  }

  const isAllowed =
    typeof deps?.isAllowedActor === 'function' ? deps.isAllowedActor(m.actorId) : false;
  if (!isAllowed) {
    const hint = lidExtraJidsHint(m.actorId);
    return {
      handled: true,
      replyText:
        `Not allowed to manage reminders from this identity.${hint}\n\n` +
        '(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CURSOR_AGENT_EXTRA_JIDS.)',
    };
  }

  const nowMs = deps.nowMs ?? Date.now();
  const filePath = deps.filePath;

  if (intent === 'list') {
    const { reminders, total, limit } = await listPendingReminders({
      chatId: m.chatId,
      filePath,
    });
    return {
      handled: true,
      replyText: formatUpcomingList(reminders, nowMs, { total, limit }),
    };
  }

  if (intent === 'cancel') {
    const parsed = parseCancelReminder(text);
    if (!parsed.ok) {
      return { handled: true, replyText: parsed.message };
    }
    const cancelled = await cancelReminder(parsed.id, { chatId: m.chatId, filePath });
    if (!cancelled) {
      return {
        handled: true,
        replyText: `No pending reminder #${parsed.id} in this chat.`,
      };
    }
    return { handled: true, replyText: `Cancelled reminder #${cancelled.id}` };
  }

  const parsed = parseReminder(text, nowMs);
  if (!parsed.ok) {
    if (parsed.reason === 'not_reminder') {
      return { handled: false, replyText: '' };
    }
    return { handled: true, replyText: parsed.message };
  }

  const reminder = await addReminder({
    chatId: m.chatId,
    actorId: m.actorId,
    dueAt: parsed.dueAt,
    text: parsed.text,
    createdAt: nowMs,
    filePath,
  });

  const when = formatReminderDue(reminder.dueAt, nowMs);
  const replyText = `OK — I'll remind you at ${when}: ${reminder.text} (#${reminder.id})`;
  return { handled: true, replyText };
}
