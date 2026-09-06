import {
  claimReminderFired,
  listDuePendingReminders,
  remindersStorePath,
} from './reminderStore.js';

const DEFAULT_POLL_MS = 30_000;

let intervalId = /** @type {ReturnType<typeof setInterval> | null} */ (null);
let inFlight = false;

/**
 * @param {unknown} e
 * @returns {string}
 */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Format outbound reminder body.
 * @param {{ text: string, dueAt?: number, nowMs?: number }} opts
 */
export function formatDeliveryMessage(opts) {
  const text = String(opts.text ?? '').trim() || '(no text)';
  const nowMs = opts.nowMs ?? Date.now();
  const dueAt = opts.dueAt;
  const late =
    typeof dueAt === 'number' && Number.isFinite(dueAt) && nowMs - dueAt > 2 * 60_000;
  return late ? `Reminder (late): ${text}` : `Reminder: ${text}`;
}

/**
 * Deliver all due pending reminders (exactly-once claim before send).
 * listDue is a snapshot; {@link claimReminderFired} re-reads under lock so a
 * concurrent cancel (pending → cancelled) cannot still deliver.
 * @param {{
 *   sendText: (chatId: string, text: string) => Promise<void>,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   nowMs?: number,
 *   filePath?: string,
 * }} deps
 * @returns {Promise<{ delivered: number, failed: number }>}
 */
export async function runReminderDeliveryTick(deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const filePath = deps.filePath ?? remindersStorePath();
  const due = await listDuePendingReminders(nowMs, filePath);
  let delivered = 0;
  let failed = 0;

  for (const rem of due) {
    // Authoritative gate: skip if cancelled/already fired since listDue.
    const claimed = await claimReminderFired(rem.id, nowMs, filePath);
    if (!claimed) continue;
    const body = formatDeliveryMessage({
      text: claimed.text,
      dueAt: claimed.dueAt,
      nowMs,
    });
    try {
      await deps.sendText(claimed.chatId, body);
      delivered += 1;
      deps.logger?.info?.({ id: claimed.id, chatId: claimed.chatId }, 'reminder delivered');
    } catch (e) {
      failed += 1;
      deps.logger?.warn?.(
        { err: errMsg(e), id: claimed.id, chatId: claimed.chatId },
        'reminder delivery send failed (already marked fired)'
      );
    }
  }

  return { delivered, failed };
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function parseEnvInt(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {string | undefined} raw
 */
function truthyEnv(raw) {
  const v = String(raw || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Restart-safe poller for due reminders.
 * Clears any existing interval first so reconnect / tests do not stack pollers.
 * @param {{
 *   getSocket: () => import('@whiskeysockets/baileys').WASocket | null | undefined,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   pollMs?: number,
 *   filePath?: string,
 * }} opts
 */
export function startReminderScheduler(opts) {
  const { getSocket, logger } = opts;
  stopReminderScheduler();
  if (truthyEnv(process.env.REMINDERS_DISABLE)) {
    logger?.info?.('reminders: disabled (REMINDERS_DISABLE)');
    return;
  }

  const pollMs = Number.isFinite(opts.pollMs)
    ? opts.pollMs
    : parseEnvInt(process.env.REMINDERS_POLL_MS, DEFAULT_POLL_MS);
  const filePath = opts.filePath ?? remindersStorePath();

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const sock = getSocket?.();
      if (!sock?.sendMessage) return;
      await runReminderDeliveryTick({
        sendText: async (chatId, text) => {
          await sock.sendMessage(chatId, { text });
        },
        logger,
        filePath,
      });
    } catch (e) {
      logger?.warn?.({ err: errMsg(e) }, 'reminder scheduler tick failed');
    } finally {
      inFlight = false;
    }
  };

  intervalId = setInterval(() => {
    void tick();
  }, pollMs);
  void tick();
  logger?.info?.({ pollMs, filePath }, 'reminders: scheduler started');
}

/** Stop the singleton interval (connection close / tests / restart). */
export function stopReminderScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  inFlight = false;
}
