import dotenv from 'dotenv';
import { createClient } from 'redis';

dotenv.config();

const MAX_CONTENT_LEN = parseInt(process.env.CHAT_MEMORY_MAX_CONTENT || '4000', 10);
export const CHAT_MEMORY_MAX_MESSAGES = parseInt(process.env.CHAT_MEMORY_MAX_MESSAGES || '10', 10);

const BACKEND = (process.env.CHAT_MEMORY_BACKEND || 'memory').toLowerCase() === 'redis' ? 'redis' : 'memory';
const REDIS_KEY_PREFIX = 'whatsapp:chat:';

/** @type {Map<string, { role: string, content: string }[]>} */
const memoryStore = new Map();

/** @type {import('redis').RedisClientType | null} */
let redisClient = null;

function truncate(content) {
  const s = String(content ?? '');
  if (s.length <= MAX_CONTENT_LEN) return s;
  return `${s.slice(0, MAX_CONTENT_LEN)}…`;
}

function trimToCap(arr) {
  const max = CHAT_MEMORY_MAX_MESSAGES;
  if (arr.length <= max) return;
  arr.splice(0, arr.length - max);
}

async function getRedis() {
  if (!redisClient) {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    redisClient = createClient({ url });
    redisClient.on('error', (err) => {
      console.error('Redis chat memory:', err.message);
    });
    await redisClient.connect();
  }
  return redisClient;
}

function redisKey(jid) {
  return `${REDIS_KEY_PREFIX}${jid}`;
}

/**
 * @param {string} jid
 * @returns {Promise<{ role: 'user' | 'assistant', content: string }[]>}
 */
export async function getMessages(jid) {
  if (!jid) return [];
  if (BACKEND === 'redis') {
    const client = await getRedis();
    const raw = await client.lRange(redisKey(jid), 0, -1);
    const out = [];
    for (const line of raw) {
      try {
        const o = JSON.parse(line);
        if (o && (o.role === 'user' || o.role === 'assistant') && typeof o.content === 'string') {
          out.push({ role: o.role, content: o.content });
        }
      } catch {
        /* skip bad entries */
      }
    }
    return out;
  }
  const arr = memoryStore.get(jid);
  return arr ? [...arr] : [];
}

/**
 * @param {string} jid
 * @param {'user' | 'assistant'} role
 * @param {string} content
 */
/**
 * @param {string} jid
 * @returns {Promise<number>} number of messages that were cleared
 */
export async function clearMessages(jid) {
  if (!jid) return 0;
  if (BACKEND === 'redis') {
    const client = await getRedis();
    const key = redisKey(jid);
    const len = await client.lLen(key);
    await client.del(key);
    return len;
  }
  const arr = memoryStore.get(jid);
  const len = arr ? arr.length : 0;
  memoryStore.delete(jid);
  return len;
}

/**
 * @param {string} jid
 * @param {'user' | 'assistant'} role
 * @param {string} content
 */
export async function appendMessage(jid, role, content) {
  if (!jid) return;
  if (role !== 'user' && role !== 'assistant') return;
  const entry = { role, content: truncate(content) };

  if (BACKEND === 'redis') {
    const client = await getRedis();
    const key = redisKey(jid);
    await client.rPush(key, JSON.stringify(entry));
    const len = await client.lLen(key);
    if (len > CHAT_MEMORY_MAX_MESSAGES) {
      await client.lTrim(key, len - CHAT_MEMORY_MAX_MESSAGES, -1);
    }
    return;
  }

  if (!memoryStore.has(jid)) memoryStore.set(jid, []);
  const arr = memoryStore.get(jid);
  arr.push(entry);
  trimToCap(arr);
}
