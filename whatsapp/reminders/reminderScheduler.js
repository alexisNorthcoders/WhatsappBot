import {
  claimReminderDelivery,
  completeReminderDelivery,
  listDuePendingReminders,
  releaseReminderDelivery,
  remindersStorePath,
  settleStaleDeliveries,
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
 * Deliver all due pending reminders with restart-safe, at-most-once semantics:
 * 1. Finalize stale `delivering` rows from a prior crash (no re-send).
 * 2. Claim pending → delivering (records deliveryAttemptAt).
 * 3. Send; on success delivering → fired; on failure release back to pending for retry.
 *
 * listDue is a snapshot; {@link claimReminderDelivery} re-reads under lock so a
 * concurrent cancel (pending → cancelled) cannot still deliver.
 * @param {{
 *   sendText: (chatId: string, text: string) => Promise<void>,
 *   logger?: { info?: Function, warn?: Function, error?: Function },
 *   nowMs?: number,
 *   filePath?: string,
 *   staleMs?: number,
 * }} deps
 * @returns {Promise<{ delivered: number, failed: number, settledStale: number }>}
 */
export async function runReminderDeliveryTick(deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const filePath = deps.filePath ?? remindersStorePath();
  const settledStale = await settleStaleDeliveries(nowMs, {
    filePath,
    staleMs: deps.staleMs,
  });
  if (settledStale > 0) {
    deps.logger?.info?.({ settledStale }, 'reminders: settled stale delivering rows');
  }

  const due = await listDuePendingReminders(nowMs, filePath);
  let delivered = 0;
  let failed = 0;

  for (const rem of due) {
    // Authoritative gate: skip if cancelled/already claimed since listDue.
    const claimed = await claimReminderDelivery(rem.id, nowMs, filePath);
    if (!claimed) continue;
    const body = formatDeliveryMessage({
      text: claimed.text,
      dueAt: claimed.dueAt,
      nowMs,
    });
    try {
      await deps.sendText(claimed.chatId, body);
      const completed = await completeReminderDelivery(claimed.id, nowMs, filePath);
      if (!completed) {
        // Claim disappeared (unexpected); do not retry — avoid duplicates.
        deps.logger?.warn?.(
          { id: claimed.id, chatId: claimed.chatId },
          'reminder send ok but complete failed (left non-pending)'
        );
      }
      delivered += 1;
      deps.logger?.info?.({ id: claimed.id, chatId: claimed.chatId }, 'reminder delivered');
    } catch (e) {
      failed += 1;
      await releaseReminderDelivery(claimed.id, filePath);
      deps.logger?.warn?.(
        { err: errMsg(e), id: claimed.id, chatId: claimed.chatId },
        'reminder delivery send failed (released for retry)'
      );
    }
  }

  return { delivered, failed, settledStale };
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
 * Runs an immediate tick on start so overdue reminders from downtime are
 * delivered within one short window after reconnect (not only after pollMs).
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
  // Catch up overdue reminders immediately after restart / reconnect.
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
