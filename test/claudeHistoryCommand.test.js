import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import claudeHistoryCommand, { MAX_HISTORY_COUNT } from '../whatsapp/commands/claudeHistory.js';
import * as commands from '../whatsapp/commands/index.js';
import { renderIssueHistoryText } from '../whatsapp/agents/claudeAgentCliFormat.js';
import { classifyIssueRunResult } from '../whatsapp/agents/claudeIssuePipeline.js';
import { createRunTracker, recordIssueRunResult, readIssueRunHistory } from '../whatsapp/agents/claudeRunTelemetry.js';

const SENDER = '15551234567@s.whatsapp.net';
const NOW = Date.parse('2026-09-22T12:00:00Z');

function fakeSock() {
  const sent = [];
  return { sent, sendMessage: async (jid, content) => void sent.push({ jid, text: String(content?.text ?? '') }) };
}

const row = (o) => ({ repo: 'me/bot', issueNumber: 1, issueTitle: 'A title', result: 'merged', outcome: 'success', endedAt: new Date(NOW - 3_600_000).toISOString(), ...o });

describe('claude:history command', () => {
  beforeEach(() => {
    process.env.MY_PHONE = '15551234567';
  });

  it('is registered in the command registry', () => {
    assert.equal(typeof commands['claude:history'], 'function');
  });

  it('refuses non-allowlisted senders without reading history', async () => {
    const sock = fakeSock();
    let read = false;
    await claudeHistoryCommand(sock, '999@s.whatsapp.net', 'claude:history', { key: {} }, { readHistory: async () => ((read = true), []) });
    assert.match(sock.sent[0].text, /not allowed/i);
    assert.equal(read, false);
  });

  it('defaults to 10 rows and replies with one line per run', async () => {
    const sock = fakeSock();
    let limit;
    await claudeHistoryCommand(sock, SENDER, 'claude:history', { key: {} }, {
      now: () => NOW,
      readHistory: async ({ limit: l }) => ((limit = l), [row({ issueNumber: 93 }), row({ issueNumber: 92, result: 'pr_open' })]),
    });
    assert.equal(limit, 10);
    assert.equal(sock.sent.length, 1);
    const lines = sock.sent[0].text.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[1], 'me/bot #93 A title — merged, 1h00m ago');
    assert.match(lines[2], /#92 A title — PR open/);
  });

  it('honours a count argument and caps it', async () => {
    const sock = fakeSock();
    const limits = [];
    const deps = { now: () => NOW, readHistory: async ({ limit }) => (limits.push(limit), [row()]) };
    await claudeHistoryCommand(sock, SENDER, 'claude:history 20', { key: {} }, deps);
    await claudeHistoryCommand(sock, SENDER, 'claude:history 5000', { key: {} }, deps);
    assert.deepEqual(limits, [20, MAX_HISTORY_COUNT]);
  });

  it('rejects a bad count with usage', async () => {
    const sock = fakeSock();
    await claudeHistoryCommand(sock, SENDER, 'claude:history abc', { key: {} }, { readHistory: async () => [] });
    assert.match(sock.sent[0].text, /usage/i);
  });

  it('says so when there is no history', async () => {
    const sock = fakeSock();
    await claudeHistoryCommand(sock, SENDER, 'claude:history', { key: {} }, { readHistory: async () => [] });
    assert.match(sock.sent[0].text, /no issue runs/i);
  });
});

describe('renderIssueHistoryText', () => {
  it('renders old entries without a title gracefully, in plain text', () => {
    const text = renderIssueHistoryText([row({ issueNumber: 114, issueTitle: undefined, result: null })], NOW);
    assert.equal(text, 'me/bot #114 (title unknown) — unknown, 1h00m ago');
    assert.doesNotMatch(text, /\x1b/);
  });

  it('labels each result', () => {
    const labels = ['merged', 'pr_open', 'no_changes', 'failed', 'timeout'].map((result) => renderIssueHistoryText([row({ result })], NOW));
    assert.match(labels[1], /PR open/);
    assert.match(labels[2], /no changes/);
    assert.match(labels[4], /timeout/);
  });
});

describe('classifyIssueRunResult', () => {
  const ok = { agentRunOk: true };
  it('maps pipeline outcomes', () => {
    assert.equal(classifyIssueRunResult({ ...ok, post: { commit: { ok: true }, prResult: { ok: true }, prAutoMergeResult: { ok: true, mergedDirectly: true } } }), 'merged');
    assert.equal(classifyIssueRunResult({ ...ok, post: { commit: { ok: true }, prResult: { ok: true } } }), 'pr_open');
    assert.equal(classifyIssueRunResult({ ...ok, post: { ran: false, skipReason: 'clean_after_wait' } }), 'no_changes');
    assert.equal(classifyIssueRunResult({ ...ok, post: { commit: { ok: true }, pushResult: { ok: false } } }), 'failed');
    assert.equal(classifyIssueRunResult({ agentRunOk: false, result: { timedOut: true }, post: null }), 'timeout');
    assert.equal(classifyIssueRunResult({ agentRunOk: false, post: null }), 'failed');
  });
});

describe('readIssueRunHistory', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'issue-history-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const finish = (runId, meta) =>
    createRunTracker({ runId, workspaceRoot: '/ws', logPath: '/ws/x.log', meta, dir }).finish({ outcome: 'success', exitCode: 0, snapshot: {} });

  it('joins title and result, excludes freeform/autofix, tolerates old entries', async () => {
    await finish('a', { kind: 'issue', repo: 'me/bot', issueNumber: 1, issueTitle: 'First' });
    await finish('b', { kind: 'freeform' });
    await finish('c', { kind: 'autofix', issueNumber: 1 });
    await finish('d', { kind: 'issue', repo: 'me/bot', issueNumber: 2 }); // no title, no result
    await recordIssueRunResult({ runId: 'a', result: 'merged', dir });

    const rows = await readIssueRunHistory({ dir });
    assert.deepEqual(rows.map((r) => [r.runId, r.issueTitle, r.result]), [['d', null, null], ['a', 'First', 'merged']]);
    assert.equal((await readIssueRunHistory({ dir, limit: 1 })).length, 1);
  });
});
