import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickNextEligibleIssue,
  runCronIssueTracerTick,
} from '../whatsapp/agents/cronIssueTracer.js';
import {
  isCursorAgentBusy,
  releaseAgentBusyLock,
} from '../whatsapp/agents/cursorAgentBusy.js';

describe('pickNextEligibleIssue', () => {
  it('returns null when every issue is PRD-prefixed', () => {
    const r = pickNextEligibleIssue([
      { number: 23, title: 'PRD: some product doc' },
      { number: 99, title: 'prd lowercase' },
    ]);
    assert.equal(r, null);
  });

  it('ignores case and leading whitespace for PRD rule', () => {
    const r = pickNextEligibleIssue([
      { number: 10, title: '  Prd: x' },
      { number: 2, title: 'real task' },
    ]);
    assert.deepEqual(r, { number: 2, title: 'real task' });
  });

  it('picks lowest issue number among eligible', () => {
    const r = pickNextEligibleIssue([
      { number: 30, title: 'Later' },
      { number: 5, title: 'First eligible' },
      { number: 8, title: 'Mid' },
    ]);
    assert.deepEqual(r, { number: 5, title: 'First eligible' });
  });

  it('ignores PRD-prefixed titles that use punctuation after the letters (e.g. PRD-…)', () => {
    const r = pickNextEligibleIssue([{ number: 1, title: 'PRD-foo' }]);
    assert.equal(r, null);
  });
});

function makeMockSock() {
  /** @type {{ jid: string, text: string }[]} */
  const sent = [];
  return {
    sent,
    sendMessage: async (/** @type {string} */ jid, /** @type {{ text?: string }} */ content) => {
      sent.push({ jid, text: String(content?.text ?? '') });
    },
  };
}

const REPO = 'alexisNorthcoders/WhatsappBot';
const OWNER = '123@s.whatsapp.net';

describe('runCronIssueTracerTick', () => {
  beforeEach(() => {
    if (isCursorAgentBusy()) {
      releaseAgentBusyLock();
    }
  });

  it('releases the agent busy lock when issue fetch / git prep returns null', async () => {
    const sock = makeMockSock();
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 1, title: 'Task' }],
      resolveIssueRepoSlug: () => REPO,
      readCronLastStartedIssue: async () => null,
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => null,
      runCursorAgentWithPost: async () => {
        throw new Error('runCursorAgentWithPost should not run when prep failed');
      },
    });
    assert.equal(isCursorAgentBusy(), false);
  });

  it('releases the agent busy lock when runCursorAgentWithPost throws', async () => {
    const sock = makeMockSock();
    /** @type {unknown[]} */
    const writes = [];
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 2, title: 'Task' }],
      resolveIssueRepoSlug: () => REPO,
      readCronLastStartedIssue: async () => null,
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => ({
        prompt: 'p',
        issueSource: { number: 2, repo: REPO, title: 'Task' },
      }),
      runCursorAgentWithPost: async () => {
        throw 'non-Error rejection';
      },
      writeCronLastStartedIssue: async (row) => {
        writes.push(row);
      },
    });
    assert.equal(isCursorAgentBusy(), false);
    assert.deepEqual(writes, []);
    const errMsg = sock.sent.map((m) => m.text).find((t) => t.includes('non-Error'));
    assert.ok(errMsg, 'owner should be notified of run failure');
  });

  it('does not call prep when persisted last-started matches the same open eligible issue', async () => {
    const sock = makeMockSock();
    let prepCalls = 0;
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 10, title: 'Still open' }],
      resolveIssueRepoSlug: () => REPO,
      readCronLastStartedIssue: async () => ({
        repo: REPO,
        number: 10,
        savedAt: '2020-01-01T00:00:00.000Z',
      }),
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => {
        prepCalls++;
        return { prompt: 'x', issueSource: { number: 10, repo: REPO, title: 'Still open' } };
      },
    });
    assert.equal(prepCalls, 0);
  });

  it('after a successful agent run, persists last-started and skips the same issue on the next tick', async () => {
    const sock = makeMockSock();
    let prepCalls = 0;
    /** @type {{ repo: string, number: number } | null} */
    let persisted = null;
    const readLast = async () =>
      persisted
        ? { ...persisted, savedAt: 'saved' }
        : null;
    const writeLast = async (/** @type {{ repo: string, number: number }} */ row) => {
      persisted = { repo: row.repo, number: row.number };
    };

    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 7, title: 'Work' }],
      resolveIssueRepoSlug: () => REPO,
      readCronLastStartedIssue: readLast,
      writeCronLastStartedIssue: writeLast,
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => {
        prepCalls++;
        return { prompt: 'p', issueSource: { number: 7, repo: REPO, title: 'Work' } };
      },
      runCursorAgentWithPost: async () => {},
    });
    assert.equal(prepCalls, 1);
    assert.deepEqual(persisted, { repo: REPO, number: 7 });

    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 7, title: 'Work' }],
      resolveIssueRepoSlug: () => REPO,
      readCronLastStartedIssue: readLast,
      writeCronLastStartedIssue: writeLast,
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => {
        prepCalls++;
        return { prompt: 'p', issueSource: { number: 7, repo: REPO, title: 'Work' } };
      },
      runCursorAgentWithPost: async () => {
        throw new Error('should not run again for same issue');
      },
    });
    assert.equal(prepCalls, 1);
  });

  it('starts work on a different eligible issue when last-started was another number', async () => {
    const sock = makeMockSock();
    let prepFor = /** @type {number | null} */ (null);
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 20, title: 'New' }],
      resolveIssueRepoSlug: () => REPO,
      readCronLastStartedIssue: async () => ({
        repo: REPO,
        number: 3,
        savedAt: 'old',
      }),
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async (p) => {
        prepFor = p.issueNumber;
        return {
          prompt: 'p',
          issueSource: { number: p.issueNumber, repo: REPO, title: 'New' },
        };
      },
      runCursorAgentWithPost: async () => {},
      writeCronLastStartedIssue: async () => {},
    });
    assert.equal(prepFor, 20);
  });
});
