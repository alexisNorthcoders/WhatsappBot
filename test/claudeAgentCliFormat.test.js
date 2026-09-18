import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatTokens, formatCost, shortModel, renderStatus } from '../whatsapp/agents/claudeAgentCliFormat.js';

describe('claudeAgentCliFormat', () => {
  it('formats units', () => {
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(125_000), '2m05s');
    assert.equal(formatDuration(3_720_000), '1h02m');
    assert.equal(formatTokens(950), '950');
    assert.equal(formatTokens(12_400), '12k');
    assert.equal(formatTokens(2_500_000), '2.5M');
    assert.equal(formatCost(0.456), '$0.46');
    assert.equal(formatCost(null), '-');
    assert.equal(shortModel('claude-haiku-4-5-20251001'), 'haiku-4-5');
  });

  it('renders running, orphaned and recent runs plus cron state', () => {
    const now = Date.parse('2026-09-18T12:00:00Z');
    const iso = (ms) => new Date(now - ms).toISOString();
    const out = renderStatus({
      now,
      cron: { pid: 10, intervalMs: 600_000, lastTickStartedAt: iso(240_000), lastTickEndedAt: iso(230_000), outcome: { kind: 'ran', repo: 'me/bot', issue: 42, result: 'progress' } },
      cronAlive: true,
      active: [
        { runId: 'r1', workspaceRoot: '/x/WhatsappBot', issueNumber: 42, trigger: 'cron', kind: 'issue', model: 'claude-opus-5', startedAt: iso(90_000), turns: 6, outputTokens: 2000, contextTokens: 80_000, pid: 11, health: 'running', lastActivity: 'Bash: npm test' },
        { runId: 'r2', workspaceRoot: '/x/dots', issueNumber: null, kind: 'freeform', startedAt: iso(1000), pid: 12, health: 'orphaned' },
      ],
      history: [{ runId: 'h1', repo: 'me/bot', workspaceRoot: '/x/WhatsappBot', issueNumber: 41, trigger: 'cron', outcome: 'success', durationMs: 300_000, model: 'claude-opus-5', turns: 9, tokens: { input: 1, output: 2, cacheRead: 3000, cacheCreate: 0 }, costUsd: 1.5, endedAt: iso(3_600_000), rateLimits: { fiveHour: 0.35, sevenDay: 0.73 } }],
      pauses: [],
    });
    assert.match(out, /every 10m/);
    assert.match(out, /worked me\/bot#42 — made progress/);
    assert.match(out, /next tick in ~6m00s/);
    assert.match(out, /1 running|2 running/);
    assert.match(out, /↳ Bash: npm test/);
    assert.match(out, /still running — nothing will report/);
    assert.match(out, /│ WhatsappBot\s+│ #42/);
    assert.match(out, /┌─+┬/);
    assert.match(out, /5h window 35% · 7d window 73%/);
    assert.match(out, /today 1 runs · \$1\.5/);
  });

  it('reports missing cron state and unreachable Redis', () => {
    const out = renderStatus({ now: Date.now(), cron: null, cronAlive: false, active: [], history: [], pauses: null });
    assert.match(out, /cron disabled or the bot has not started/);
    assert.match(out, /Redis unreachable/);
  });
});
