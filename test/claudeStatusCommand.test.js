import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import claudeStatusCommand from '../whatsapp/commands/claudeStatus.js';
import * as commands from '../whatsapp/commands/index.js';
import { collectStatus } from '../whatsapp/agents/claudeStatusCollect.js';

const SENDER = '15551234567@s.whatsapp.net';
const NOW = Date.parse('2026-09-22T12:00:00Z');

function fakeSock() {
  const sent = [];
  return { sent, sendMessage: async (jid, content) => void sent.push({ jid, text: String(content?.text ?? '') }) };
}

const run = (o) => ({
  runId: 'r1', kind: 'issue', repo: 'me/bot', issueNumber: 94, issueTitle: 'Add status', workspaceRoot: '/ws/bot',
  startedAt: new Date(NOW - 125_000).toISOString(), health: 'running', pid: 42, lastActivity: 'Edit foo.js', ...o,
});
const data = (o) => ({ now: NOW, cron: null, cronAlive: false, active: [], history: [], pauses: [], ...o });
const hist = (n) => ({ repo: 'me/bot', issueNumber: n, issueTitle: 'T' + n, result: 'merged', outcome: 'success', endedAt: new Date(NOW - 3_600_000).toISOString() });

const call = (d, recent = [], sender = SENDER) => {
  const sock = fakeSock();
  return claudeStatusCommand(sock, sender, 'claude:status', { key: {} }, { collect: async () => d, readIssueHistory: async () => recent }).then(() => sock);
};

describe('claude:status command', () => {
  beforeEach(() => {
    process.env.MY_PHONE = '15551234567';
  });

  it('is registered', () => assert.equal(typeof commands['claude:status'], 'function'));

  it('refuses non-allowlisted senders without collecting', async () => {
    const sock = fakeSock();
    let collected = false;
    await claudeStatusCommand(sock, '999@s.whatsapp.net', 'claude:status', { key: {} }, { collect: async () => ((collected = true), data()) });
    assert.match(sock.sent[0].text, /not allowed/i);
    assert.equal(collected, false);
  });

  it('reports idle, no pause, cron and recent runs', async () => {
    const sock = await call(
      data({ cronAlive: true, cron: { pid: 1, intervalMs: 6e4, lastTickEndedAt: new Date(NOW - 60_000).toISOString(), outcome: { kind: 'no_eligible' } } }),
      [hist(93), hist(92)]
    );
    assert.equal(sock.sent.length, 1);
    const t = sock.sent[0].text;
    assert.match(t, /Agent: idle/);
    assert.match(t, /Paused: no/);
    assert.match(t, /Cron: last tick 1m00s ago — idle — no eligible issue/);
    assert.match(t, /me\/bot #93 T93 — merged, 1h00m ago\nme\/bot #92/);
    assert.doesNotMatch(t, /\x1b/);
  });

  it('shows the active run with phase, and pauses', async () => {
    const t = (await call(data({ active: [run()], pauses: [{ workspaceRoot: '/ws/bot', reason: 'rate limit' }] }))).sent[0].text;
    assert.match(t, /Agent: #94 Add status \(me\/bot\) — running, 2m05s/);
    assert.match(t, /Phase: Edit foo\.js/);
    assert.match(t, /Paused: bot \(rate limit\)/);
  });

  it('shows freeform runs', async () => {
    const t = (await call(data({ active: [run({ issueNumber: null, kind: 'freeform', repo: null })] }))).sent[0].text;
    assert.match(t, /Agent: freeform \(bot\)/);
  });

  it('flags orphaned and stale runs like the terminal CLI', async () => {
    const t = (await call(data({ active: [run({ health: 'orphaned' }), run({ health: 'stale', runId: 'r2' })] }))).sent[0].text;
    assert.match(t, /Orphaned: .*pid 42/);
    assert.match(t, /Stale: /);
  });

  it('says pause state is unknown when Redis is unreachable', async () => {
    assert.match((await call(data({ pauses: null }))).sent[0].text, /Paused: unknown/);
  });
});

describe('collectStatus', () => {
  it('assembles the snapshot from injected readers', async () => {
    const cron = { pid: 7 };
    const d = await collectStatus({
      dir: '/x', now: () => NOW,
      readCronState: async () => cron, readActiveRuns: async () => [], readRunHistory: async ({ sinceMs }) => [{ sinceMs }],
      readPauses: async () => [], pidAlive: (p) => p === 7,
    });
    assert.deepEqual(d, { now: NOW, cron, cronAlive: true, active: [], history: [{ sinceMs: NOW - 7 * 864e5 }], pauses: [] });
  });
});
