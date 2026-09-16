import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePauseArgs,
  formatDurationSeconds,
  pauseAgentForWorkspace,
  resumeAgentForWorkspace,
  getAgentPauseForWorkspace,
  DEFAULT_PAUSE_TTL_SECONDS,
} from '../whatsapp/agents/claudeAgentPause.js';

/** In-memory stand-in for the subset of the redis v4 client API this module calls. */
function makeFakeRedis() {
  const store = new Map();
  return {
    async set(key, value, opts) {
      const ttl = opts?.EX;
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : null });
      return 'OK';
    },
    async get(key) {
      const e = store.get(key);
      if (!e) return null;
      if (e.expiresAt && e.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return e.value;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
    async ttl(key) {
      const e = store.get(key);
      if (!e) return -2;
      if (!e.expiresAt) return -1;
      const remaining = Math.ceil((e.expiresAt - Date.now()) / 1000);
      return remaining > 0 ? remaining : -2;
    },
  };
}

function makeThrowingRedis(message = 'connection refused') {
  return {
    async get() {
      throw new Error(message);
    },
    async ttl() {
      throw new Error(message);
    },
    async set() {
      throw new Error(message);
    },
    async del() {
      throw new Error(message);
    },
  };
}

describe('parsePauseArgs', () => {
  it('uses the default TTL and empty reason when given nothing', () => {
    assert.deepEqual(parsePauseArgs(''), { ttlSeconds: DEFAULT_PAUSE_TTL_SECONDS, reason: '' });
  });

  it('parses a compact duration token with no reason', () => {
    assert.deepEqual(parsePauseArgs('2h'), { ttlSeconds: 7200, reason: '' });
    assert.deepEqual(parsePauseArgs('30m'), { ttlSeconds: 1800, reason: '' });
    assert.deepEqual(parsePauseArgs('1d'), { ttlSeconds: 86400, reason: '' });
  });

  it('parses a duration token followed by a reason', () => {
    assert.deepEqual(parsePauseArgs('3h working on issue 90 by hand'), {
      ttlSeconds: 10800,
      reason: 'working on issue 90 by hand',
    });
  });

  it('treats non-duration text as the reason with the default TTL', () => {
    assert.deepEqual(parsePauseArgs('working on issue 90 by hand'), {
      ttlSeconds: DEFAULT_PAUSE_TTL_SECONDS,
      reason: 'working on issue 90 by hand',
    });
  });
});

describe('formatDurationSeconds', () => {
  it('formats whole days, hours, minutes, and falls back to seconds', () => {
    assert.equal(formatDurationSeconds(86400), '1d');
    assert.equal(formatDurationSeconds(7200), '2h');
    assert.equal(formatDurationSeconds(1800), '30m');
    assert.equal(formatDurationSeconds(90), '90s');
  });

  it('treats zero/negative/non-finite as 0m', () => {
    assert.equal(formatDurationSeconds(0), '0m');
    assert.equal(formatDurationSeconds(-5), '0m');
    assert.equal(formatDurationSeconds(NaN), '0m');
  });
});

describe('pauseAgentForWorkspace / getAgentPauseForWorkspace / resumeAgentForWorkspace', () => {
  it('round-trips a pause with a custom reason and TTL', async () => {
    const redis = makeFakeRedis();
    const workspaceRoot = '/home/alexis/Projects/WhatsappBot';

    const state = await pauseAgentForWorkspace({
      workspaceRoot,
      reason: 'manual git surgery',
      ttlSeconds: 120,
      redis,
    });
    assert.equal(state.reason, 'manual git surgery');
    assert.equal(state.ttlSeconds, 120);

    const read = await getAgentPauseForWorkspace({ workspaceRoot, redis });
    assert.equal(read.reason, 'manual git surgery');
    assert.ok(read.ttlRemainingSeconds > 0 && read.ttlRemainingSeconds <= 120);
  });

  it('defaults the reason when none is given', async () => {
    const redis = makeFakeRedis();
    const workspaceRoot = '/home/alexis/Projects/chess-trainer';

    await pauseAgentForWorkspace({ workspaceRoot, ttlSeconds: 60, redis });
    const read = await getAgentPauseForWorkspace({ workspaceRoot, redis });
    assert.equal(read.reason, 'manual work in progress');
  });

  it('returns null when nothing is paused for that workspace', async () => {
    const redis = makeFakeRedis();
    const read = await getAgentPauseForWorkspace({ workspaceRoot: '/nothing/here', redis });
    assert.equal(read, null);
  });

  it('does not leak a pause across different workspace roots', async () => {
    const redis = makeFakeRedis();
    await pauseAgentForWorkspace({ workspaceRoot: '/repo/a', ttlSeconds: 60, redis });
    const readB = await getAgentPauseForWorkspace({ workspaceRoot: '/repo/b', redis });
    assert.equal(readB, null);
  });

  it('resumeAgentForWorkspace clears an active pause and reports it was cleared', async () => {
    const redis = makeFakeRedis();
    const workspaceRoot = '/home/alexis/Projects/WhatsappBot';
    await pauseAgentForWorkspace({ workspaceRoot, ttlSeconds: 60, redis });

    const cleared = await resumeAgentForWorkspace({ workspaceRoot, redis });
    assert.equal(cleared, true);

    const read = await getAgentPauseForWorkspace({ workspaceRoot, redis });
    assert.equal(read, null);
  });

  it('resumeAgentForWorkspace reports false when there was nothing to clear', async () => {
    const redis = makeFakeRedis();
    const cleared = await resumeAgentForWorkspace({ workspaceRoot: '/nothing/here', redis });
    assert.equal(cleared, false);
  });

  it('getAgentPauseForWorkspace fails open (returns null) on a Redis error', async () => {
    const redis = makeThrowingRedis();
    const read = await getAgentPauseForWorkspace({ workspaceRoot: '/home/alexis/Projects/WhatsappBot', redis });
    assert.equal(read, null);
  });
});
