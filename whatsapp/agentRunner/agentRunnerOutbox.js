/**
 * Delivers agent-runner's outbox (Redis Stream `agent-runner:outbox`) over WhatsApp.
 *
 * The bot keeps its own read cursor (last delivered stream id). Entries that piled up while the
 * bot was down are not replayed: the first poll of the process sends one "you missed N" line and
 * moves the cursor past them, remembering the range for `claude:missed`. After that, each poll
 * merges what's waiting into one message per recipient, so messages never go out back to back.
 */

export const OWNER = 'owner';
const START_ID = '0-0';
const FIRST_LINE_MAX = 120;

/**
 * @typedef {{ id: string, fields: Record<string, string> }} OutboxEntry
 * @typedef {{
 *   readAfter(afterId: string, toId?: string): Promise<OutboxEntry[]>,
 *   getCursor(): Promise<string | null>,
 *   setCursor(id: string): Promise<void>,
 *   getMissed(): Promise<{ afterId: string, toId: string } | null>,
 *   setMissed(range: { afterId: string, toId: string }): Promise<void>,
 * }} OutboxStore
 */

/**
 * @param {{
 *   store: OutboxStore,
 *   sendText: (chatId: string, text: string) => Promise<void>,
 *   getOwnerJid: () => string | null,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} deps
 */
export function createOutboxDrain({ store, sendText, getOwnerJid, logger }) {
  let caughtUp = false;
  let polling = null;
  let timer = null;

  const recipientOf = (replyTo) => (replyTo === OWNER ? getOwnerJid() : replyTo || null);

  async function catchUp() {
    const cursor = (await store.getCursor()) ?? START_ID;
    const missed = await store.readAfter(cursor);
    if (!missed.length) {
      await store.setCursor(cursor);
      caughtUp = true;
      return;
    }
    const lastId = missed[missed.length - 1].id;
    await store.setMissed({ afterId: cursor, toId: lastId });
    const owner = getOwnerJid();
    const n = missed.length;
    if (owner) {
      // before moving the cursor: a failed notice is retried (with a fresh count) on the next poll
      await sendText(owner, `You missed ${n} agent message${n === 1 ? '' : 's'}, \`claude:missed\` to list them`);
    } else {
      logger.warn({ count: n }, 'agent-runner: missed outbox messages, but MY_PHONE is not set');
    }
    await store.setCursor(lastId);
    caughtUp = true;
  }

  async function deliver() {
    const cursor = (await store.getCursor()) ?? START_ID;
    const entries = await store.readAfter(cursor);
    if (!entries.length) return;

    /** @type {Map<string, string[]>} */
    const byRecipient = new Map();
    for (const { id, fields } of entries) {
      const to = recipientOf(fields.replyTo);
      if (!to) {
        logger.warn({ id, replyTo: fields.replyTo }, 'agent-runner: outbox entry has no resolvable recipient, dropped');
        continue;
      }
      if (!byRecipient.has(to)) byRecipient.set(to, []);
      byRecipient.get(to).push(fields.text ?? '');
    }
    for (const [to, texts] of byRecipient) {
      await sendText(to, texts.join('\n\n'));
    }
    await store.setCursor(entries[entries.length - 1].id);
  }

  /** One poll: the first one of the process is the catch-up, later ones deliver. Never overlaps. */
  function poll() {
    if (!polling) {
      polling = (caughtUp ? deliver() : catchUp()).finally(() => {
        polling = null;
      });
    }
    return polling;
  }

  return {
    poll,

    /** @returns {Promise<string>} the `claude:missed` reply */
    async missedReport() {
      const range = await store.getMissed();
      const entries = range ? await store.readAfter(range.afterId, range.toId) : [];
      if (!entries.length) return 'No missed agent messages.';
      const lines = entries.map(({ fields }) => {
        const when = fields.ts ? fields.ts.slice(0, 16).replace('T', ' ') : '?';
        let first = String(fields.text ?? '').split('\n', 1)[0].trim();
        if (first.length > FIRST_LINE_MAX) first = `${first.slice(0, FIRST_LINE_MAX - 1)}…`;
        return `${when} ${fields.runId || '-'} — ${first}`;
      });
      return `Missed agent messages (${entries.length}):\n${lines.join('\n')}`;
    },

    /** Polls every `intervalMs` (first poll right away) until `stop()`. */
    start(intervalMs) {
      if (timer) return;
      const tick = () =>
        poll().catch((err) => logger.warn({ err: err?.message || err }, 'agent-runner outbox poll failed'));
      void tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * Redis-backed {@link OutboxStore}. `connect` resolves a connected node-redis client (lazily, so a
 * Redis outage only fails polls, not bot startup).
 *
 * @param {{ connect: () => Promise<import('redis').RedisClientType>, streamKey?: string, keyPrefix?: string }} p
 * @returns {OutboxStore}
 */
export function createRedisOutboxStore({
  connect,
  streamKey = 'agent-runner:outbox',
  keyPrefix = 'whatsapp-bot:agent-runner-outbox:',
}) {
  const cursorKey = `${keyPrefix}cursor`;
  const missedKey = `${keyPrefix}missed`;
  return {
    async readAfter(afterId, toId) {
      const client = await connect();
      const rows = await client.xRange(streamKey, `(${afterId}`, toId ?? '+');
      return rows.map(({ id, message }) => ({ id, fields: message }));
    },
    async getCursor() {
      return (await connect()).get(cursorKey);
    },
    async setCursor(id) {
      await (await connect()).set(cursorKey, id);
    },
    async getMissed() {
      const raw = await (await connect()).get(missedKey);
      try {
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    async setMissed(range) {
      await (await connect()).set(missedKey, JSON.stringify(range));
    },
  };
}
