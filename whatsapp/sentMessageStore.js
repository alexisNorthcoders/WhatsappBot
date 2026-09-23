const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** `123:4@s.whatsapp.net` → `123@s.whatsapp.net`: retry receipts may name a specific device. */
function chatKey(jid) {
  const s = String(jid || '');
  const at = s.indexOf('@');
  if (at < 0) return s;
  const user = s.slice(0, at).split(':')[0];
  return `${user}${s.slice(at)}`;
}

/**
 * Bounded, TTL-limited in-memory store of the bot's own outgoing messages, so Baileys'
 * `getMessage` can resend one when a recipient's device asks for a decryption retry.
 * Create once per process and reuse across reconnects (retries can arrive after a reconnect).
 *
 * Map insertion order doubles as age order: the first entry is always the oldest, so both
 * TTL pruning and size eviction only ever touch the front.
 *
 * @param {{ maxEntries?: number, ttlMs?: number, now?: () => number }} [opts]
 */
export function createSentMessageStore({
  maxEntries = DEFAULT_MAX_ENTRIES,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, { message: object, expiresAt: number }>} */
  const entries = new Map();

  const keyOf = (remoteJid, id) => `${chatKey(remoteJid)}|${id}`;

  function pruneExpired() {
    const t = now();
    for (const [k, entry] of entries) {
      if (entry.expiresAt > t) break;
      entries.delete(k);
    }
  }

  function remember(remoteJid, id, message) {
    const k = keyOf(remoteJid, id);
    entries.delete(k);
    entries.set(k, { message, expiresAt: now() + ttlMs });
    pruneExpired();
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    maxEntries,
    ttlMs,
    get size() {
      return entries.size;
    },

    /** Records every `fromMe` message with content from a `messages.upsert` event. */
    recordUpsert(upsert) {
      for (const msg of upsert?.messages || []) {
        const key = msg?.key;
        if (!key?.fromMe || !key.remoteJid || !key.id || !msg.message) continue;
        remember(key.remoteJid, key.id, msg.message);
      }
    },

    /** Baileys `getMessage` socket option: the stored content, or `undefined` if unknown/expired. */
    async getMessage(key) {
      if (!key?.remoteJid || !key.id) return undefined;
      const k = keyOf(key.remoteJid, key.id);
      const entry = entries.get(k);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(k);
        return undefined;
      }
      return entry.message;
    },
  };
}
