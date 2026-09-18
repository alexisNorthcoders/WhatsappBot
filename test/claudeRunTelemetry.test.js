import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRunTracker,
  readActiveRuns,
  readRunHistory,
  writeCronTick,
  readCronState,
} from '../whatsapp/agents/claudeRunTelemetry.js';

describe('claudeRunTelemetry', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'telemetry-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const snap = { model: 'claude-opus-5', turns: 4, outputTokens: 50, contextTokens: 900, lastActivity: 'Bash: ls', rateLimits: null, sessionId: 's', result: null };

  it('publishes an active run, then moves it to history on finish', async () => {
    let t = 1_000_000;
    const tracker = createRunTracker({ runId: 'r1', workspaceRoot: '/ws', logPath: '/ws/r1.log', meta: { trigger: 'cron', kind: 'issue', issueNumber: 7 }, dir, now: () => t });
    await tracker.start(process.pid);
    t += 5000;
    await tracker.update(snap);

    const [active] = await readActiveRuns({ dir });
    assert.equal(active.runId, 'r1');
    assert.equal(active.issueNumber, 7);
    assert.equal(active.lastActivity, 'Bash: ls');
    assert.equal(active.health, 'running');

    await tracker.finish({
      outcome: 'success',
      exitCode: 0,
      snapshot: { ...snap, result: { text: 'ok', isError: false, costUsd: 0.5, turns: 5, durationMs: 1, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 } } },
    });
    assert.deepEqual(await readActiveRuns({ dir }), []);
    const [row] = await readRunHistory({ dir });
    assert.equal(row.outcome, 'success');
    assert.equal(row.costUsd, 0.5);
    assert.equal(row.turns, 5);
    assert.equal(row.trigger, 'cron');
    assert.equal(row.logPath, '/ws/r1.log');
  });

  it('throttles live updates but still flushes the last one', async () => {
    let t = 0;
    const tracker = createRunTracker({ runId: 'r2', workspaceRoot: '/ws', logPath: 'x', dir, now: () => t });
    await tracker.start(1);
    t += 100;
    await tracker.update({ ...snap, turns: 9 });
    assert.equal((await readActiveRuns({ dir }))[0].turns, 0);
    t += 2000; // real timer fires after the remaining ~1.4s; clock is fake so it then writes
    await new Promise((r) => setTimeout(r, 1600));
    await tracker.update({ ...snap, turns: 9 });
    assert.equal((await readActiveRuns({ dir }))[0].turns, 9);
  });

  it('flags orphaned and stale runs when processes are gone', async () => {
    const tracker = createRunTracker({ runId: 'r3', workspaceRoot: '/ws', logPath: 'x', dir });
    await tracker.start(4242);
    const ownerDead = (pid) => pid === 4242;
    assert.equal((await readActiveRuns({ dir, isAlive: ownerDead }))[0].health, 'orphaned');
    assert.equal((await readActiveRuns({ dir, isAlive: () => false }))[0].health, 'stale');
  });

  it('history is newest-first, tolerates torn lines and honours limit/since', async () => {
    for (const id of ['a', 'b', 'c']) {
      const tr = createRunTracker({ runId: id, workspaceRoot: '/ws', logPath: 'x', dir });
      await tr.start(1);
      await tr.finish({ outcome: 'success', exitCode: 0, snapshot: snap });
    }
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'runs.jsonl'), '{"torn":');
    assert.deepEqual((await readRunHistory({ dir })).map((r) => r.runId), ['c', 'b', 'a']);
    assert.equal((await readRunHistory({ dir, limit: 1 })).length, 1);
    assert.equal((await readRunHistory({ dir, sinceMs: Date.now() + 10_000 })).length, 0);
    assert.ok(!(await readdir(dir)).some((n) => n.endsWith('.tmp')));
  });

  it('round-trips cron tick state', async () => {
    assert.equal(await readCronState({ dir }), null);
    await writeCronTick({ outcome: { kind: 'no_eligible' }, intervalMs: 600000, startedAt: 1000, dir });
    const s = await readCronState({ dir });
    assert.equal(s.intervalMs, 600000);
    assert.equal(s.outcome.kind, 'no_eligible');
  });
});
