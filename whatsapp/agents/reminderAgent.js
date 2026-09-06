import { lidExtraJidsHint } from '../whatsAppActorAllowlist.js';
import {
  formatReminderDue,
  looksLikeReminderRequest,
  parseRelativeReminder,
} from '../reminders/reminderParser.js';
import { addReminder } from '../reminders/reminderStore.js';

/**
 * @param {string} text
 * @returns {boolean}
 */
export function shouldTryReminderAgent(text) {
  return looksLikeReminderRequest(text);
}

/**
 * Handle a reminder create request (relative MVP).
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
  if (!shouldTryReminderAgent(text)) {
    return { handled: false, replyText: '' };
  }

  if (!deps.isAllowedActor(m.actorId)) {
    const hint = lidExtraJidsHint(m.actorId);
    return {
      handled: true,
      replyText:
        `Not allowed to set reminders from this identity.${hint}\n\n` +
        '(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CURSOR_AGENT_EXTRA_JIDS.)',
    };
  }

  const nowMs = deps.nowMs ?? Date.now();
  const parsed = parseRelativeReminder(text, nowMs);
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
    filePath: deps.filePath,
  });

  const when = formatReminderDue(reminder.dueAt, nowMs);
  const replyText = `OK — I'll remind you at ${when}: ${reminder.text}`;
  return { handled: true, replyText };
}
