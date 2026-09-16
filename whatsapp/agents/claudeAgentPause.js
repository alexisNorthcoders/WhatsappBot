import { createClient } from 'redis';

/**
 * Per-workspace pause flag for the Claude CLI agent pipeline (manual `claude` command and the
 * cron issue tracer). Backed by Redis rather than a JSON file so a human working directly in a
 * workspace's git checkout — outside the bot entirely — can set/clear it from `redis-cli`, it
 * survives bot restarts, and expiry is native (`EX`) instead of hand-rolled staleness checks.
 */

const REDIS_KEY_PREFIX = 'claude:agent:paused:';

export const DEFAULT_PAUSE_TTL_SECONDS =
  parseInt(process.env.CLAUDE_AGENT_PAUSE_DEFAULT_TTL_SECONDS || '', 10) || 2 * 60 * 60;

/** @type {import('redis').RedisClientType | null} */
let sharedClient = null;
/** @type {Promise<import('redis').RedisClientType> | null} */
let connecting = null;

async function getRedis() {
  if (sharedClient) return sharedClient;
  if (!connecting) {
    const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const client = createClient({ url });
    client.on('error', (err) => {
      console.error('Claude agent pause (redis):', err.message);
    });
    connecting = client.connect().then(() => {
      sharedClient = client;
      return client;
    });
  }
  return connecting;
}

function pauseKey(workspaceRoot) {
  return `${REDIS_KEY_PREFIX}${workspaceRoot}`;
}

const DURATION_RE = /^(\d+)(m|h|d)$/i;
const UNIT_SECONDS = { m: 60, h: 3600, d: 86400 };

/**
 * Parses the free-text argument to `claude pause …` into a TTL and an optional reason.
 * Only a compact leading duration token (`30m`, `2h`, `1d`) is recognized as a duration; anything
 * else is treated entirely as the reason, with the default TTL.
 *
 * @param {string} argsText
 * @param {number} [defaultTtlSeconds]
 * @returns {{ ttlSeconds: number, reason: string }}
 */
export function parsePauseArgs(argsText, defaultTtlSeconds = DEFAULT_PAUSE_TTL_SECONDS) {
  const trimmed = (argsText || '').trim();
  if (!trimmed) return { ttlSeconds: defaultTtlSeconds, reason: '' };
  const [firstToken, ...restTokens] = trimmed.split(/\s+/);
  const m = firstToken.match(DURATION_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    const ttlSeconds = n * UNIT_SECONDS[m[2].toLowerCase()];
    return { ttlSeconds, reason: restTokens.join(' ').trim() };
  }
  return { ttlSeconds: defaultTtlSeconds, reason: trimmed };
}

/**
 * @param {number} totalSeconds
 * @returns {string} compact human-readable duration, e.g. "2h", "45m", "90s"
 */
export function formatDurationSeconds(totalSeconds) {
  const s = Math.round(totalSeconds);
  if (!Number.isFinite(s) || s <= 0) return '0m';
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/**
 * @param {{ workspaceRoot: string, reason?: string, ttlSeconds?: number, redis?: import('redis').RedisClientType }} opts
 * @returns {Promise<{ pausedAt: string, reason: string, ttlSeconds: number }>}
 */
export async function pauseAgentForWorkspace({ workspaceRoot, reason, ttlSeconds, redis }) {
  const client = redis ?? (await getRedis());
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_PAUSE_TTL_SECONDS;
  const payload = {
    pausedAt: new Date().toISOString(),
    reason: (reason || '').trim() || 'manual work in progress',
  };
  await client.set(pauseKey(workspaceRoot), JSON.stringify(payload), { EX: ttl });
  return { ...payload, ttlSeconds: ttl };
}

/**
 * @param {{ workspaceRoot: string, redis?: import('redis').RedisClientType }} opts
 * @returns {Promise<boolean>} true if a pause was actually cleared
 */
export async function resumeAgentForWorkspace({ workspaceRoot, redis }) {
  const client = redis ?? (await getRedis());
  const removed = await client.del(pauseKey(workspaceRoot));
  return removed > 0;
}

/**
 * Fails open (returns null) on Redis errors so an unrelated Redis outage cannot silently freeze
 * all issue automation forever — this is a courtesy pause, not a correctness-critical lock.
 *
 * @param {{ workspaceRoot: string, redis?: import('redis').RedisClientType }} opts
 * @returns {Promise<{ pausedAt: string | null, reason: string, ttlRemainingSeconds: number | null } | null>}
 */
export async function getAgentPauseForWorkspace({ workspaceRoot, redis }) {
  try {
    const client = redis ?? (await getRedis());
    const key = pauseKey(workspaceRoot);
    const [raw, ttl] = await Promise.all([client.get(key), client.ttl(key)]);
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pausedAt: typeof parsed.pausedAt === 'string' ? parsed.pausedAt : null,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'manual work in progress',
      ttlRemainingSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    };
  } catch (err) {
    console.error('Claude agent pause: failed to read pause state, treating as not paused:', err.message);
    return null;
  }
}
