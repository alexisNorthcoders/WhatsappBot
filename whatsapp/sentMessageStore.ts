import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type { WAMessage, WAMessageContent, WAMessageKey } from '@whiskeysockets/baileys';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Retry receipts name a specific device (`123:4@s.whatsapp.net`) and we may have sent to the
 * `@c.us` form, so both sides are normalized to `123@s.whatsapp.net` before matching.
 * Matching stays per-chat (not id-only) so a retry can never pull another chat's message.
 */
function entryKey(remoteJid: string, id: string) {
  return `${jidNormalizedUser(remoteJid)}|${id}`;
}

/**
 * Bounded, TTL-limited in-memory store of the bot's own outgoing messages, so Baileys'
 * `getMessage` can resend one when a recipient's device asks for a decryption retry.
 * Create once per process and reuse across reconnects (retries can arrive after a reconnect).
 *
 * Map insertion order doubles as age order: the first entry is always the oldest, so both
 * TTL pruning and size eviction only ever touch the front.
 */
export function createSentMessageStore({
  maxEntries = DEFAULT_MAX_ENTRIES,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
}: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
  const entries: Map<string, { message: WAMessageContent; expiresAt: number }> = new Map();

  const isExpired = (entry: { expiresAt: number }) => entry.expiresAt <= now();

  function pruneExpired() {
    for (const [k, entry] of entries) {
      if (!isExpired(entry)) break;
      entries.delete(k);
    }
  }

  function remember(k: string, message: WAMessageContent) {
    entries.delete(k);
    entries.set(k, { message, expiresAt: now() + ttlMs });
    pruneExpired();
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value!);
    }
  }

  return {
    maxEntries,
    ttlMs,
    get size() {
      return entries.size;
    },

    /** Records every `fromMe` message with content from a `messages.upsert` event. */
    recordUpsert(upsert: { messages?: WAMessage[] }) {
      for (const msg of upsert?.messages || []) {
        const key = msg?.key;
        if (!key?.fromMe || !key.remoteJid || !key.id || !msg.message) continue;
        remember(entryKey(key.remoteJid, key.id), msg.message);
      }
    },

    /** Baileys `getMessage` socket option: the stored content, or `undefined` if unknown/expired. */
    async getMessage(key: WAMessageKey | undefined): Promise<WAMessageContent | undefined> {
      if (!key?.remoteJid || !key.id) return undefined;
      const k = entryKey(key.remoteJid, key.id);
      const entry = entries.get(k);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        entries.delete(k);
        return undefined;
      }
      return entry.message;
    },
  };
}
