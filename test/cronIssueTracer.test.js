import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickNextEligibleIssue,
  pickNextRunnableIssueForRepo,
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

describe('pickNextRunnableIssueForRepo', () => {
  it('returns null when the only eligible issue matches last-started for that repo', () => {
    const last = new Map([[REPO, 3]]);
    const r = pickNextRunnableIssueForRepo([{ number: 3, title: 'Open' }], REPO, last);
    assert.equal(r, null);
  });

  it('returns the eligible issue when last-started is a different number', () => {
    const last = new Map([[REPO, 2]]);
    const r = pickNextRunnableIssueForRepo([{ number: 5, title: 'Open' }], REPO, last);
    assert.deepEqual(r, { number: 5, title: 'Open' });
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
const REPO_P = 'alexisNorthcoders/Platformer';
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
      readCronPerRepoLastStarted: async () => new Map(),
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
      readCronPerRepoLastStarted: async () => new Map(),
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => ({
        prompt: 'p',
        issueSource: { number: 2, repo: REPO, title: 'Task' },
      }),
      runCursorAgentWithPost: async () => {
        throw 'non-Error rejection';
      },
      writeCronPerRepoLastStartedEntry: async (row) => {
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
      listOpenGithubIssues: async ({ repo }) => {
        if (repo === REPO) return [{ number: 10, title: 'Still open' }];
        if (repo === REPO_P) return [];
        throw new Error(`unexpected list ${repo}`);
      },
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map([[REPO, 10]]),
      resolveWorkspaceFromAlias: async () => '/plat',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => {
        throw new Error('getDefaultWorkspaceRoot should not run when WA is blocked by last-started');
      },
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
    /** @type {Map<string, number>} */
    const persisted = new Map();
    const readLast = async () => new Map(persisted);
    const writeLast = async (/** @type {{ repo: string, number: number }} */ row) => {
      persisted.set(row.repo, row.number);
    };

    const listBoth = async (/** @type {{ repo: string }} */ { repo }) => {
      if (repo === REPO) return [{ number: 7, title: 'Work' }];
      if (repo === REPO_P) return [];
      throw new Error(`unexpected list ${repo}`);
    };

    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: listBoth,
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: readLast,
      writeCronPerRepoLastStartedEntry: writeLast,
      resolveWorkspaceFromAlias: async () => '/plat',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => {
        prepCalls++;
        return { prompt: 'p', issueSource: { number: 7, repo: REPO, title: 'Work' } };
      },
      runCursorAgentWithPost: async () => {},
    });
    assert.equal(prepCalls, 1);
    assert.equal(persisted.get(REPO), 7);

    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: listBoth,
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: readLast,
      writeCronPerRepoLastStartedEntry: writeLast,
      resolveWorkspaceFromAlias: async () => '/plat',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
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

  it('does not list or resolve Platformer when WhatsappBot has an eligible issue', async () => {
    const sock = makeMockSock();
    let listCalls = 0;
    let platRootCalls = 0;
    let prepFor = /** @type {string | null} */ (null);
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async ({ repo }) => {
        listCalls++;
        assert.equal(repo, REPO);
        return [{ number: 1, title: 'WA' }];
      },
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map(),
      resolveWorkspaceFromAlias: () => {
        platRootCalls++;
        return '/plat';
      },
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async (p) => {
        prepFor = p.workspaceRoot;
        return {
          prompt: 'p',
          issueSource: { number: 1, repo: REPO, title: 'WA' },
        };
      },
      runCursorAgentWithPost: async () => {},
    });
    assert.equal(listCalls, 1, 'only WhatsappBot issue list should run');
    assert.equal(platRootCalls, 0);
    assert.equal(prepFor, '/tmp/ws');
  });

  it('uses Platformer when WhatsappBot’s lowest eligible issue is only blocked by last-started', async () => {
    const sock = makeMockSock();
    let prepInfo = /** @type {null | { workspaceRoot: string, issueNumber: number }} */ (null);
    let listCalls = 0;
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async ({ repo }) => {
        listCalls++;
        if (repo === REPO) {
          return [{ number: 9, title: 'WA task' }];
        }
        if (repo === REPO_P) {
          return [{ number: 4, title: 'Plat task' }];
        }
        throw new Error(`unexpected repo list ${repo}`);
      },
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map([[REPO, 9]]),
      resolveWorkspaceFromAlias: async () => '/plat/root',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => {
        throw new Error('getDefaultWorkspaceRoot should not run when WA is blocked by last-started');
      },
      runIssueFetchAndGitPrep: async (p) => {
        prepInfo = { workspaceRoot: p.workspaceRoot, issueNumber: p.issueNumber };
        return { prompt: 'p', issueSource: { number: 4, repo: REPO_P, title: 'Plat task' } };
      },
      runCursorAgentWithPost: async () => {},
    });
    assert.ok(listCalls >= 2, 'WhatsappBot and Platformer issue lists should run');
    assert.ok(prepInfo, 'Platformer path should run prep');
    assert.equal(prepInfo.workspaceRoot, '/plat/root');
    assert.equal(prepInfo.issueNumber, 4);
  });

  it('uses Platformer when WhatsappBot has no eligible issues (e.g. only PRD-titled opens)', async () => {
    const sock = makeMockSock();
    let prepInfo = /** @type {null | { workspaceRoot: string, issueNumber: number, alias: string | null }} */ (
      null
    );
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async ({ repo }) => {
        if (repo === REPO) {
          return [{ number: 5, title: 'PRD: x' }];
        }
        if (repo === REPO_P) {
          return [{ number: 2, title: 'Plat' }];
        }
        throw new Error(`unexpected repo list ${repo}`);
      },
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map(),
      resolveWorkspaceFromAlias: async (alias) => {
        assert.equal(alias, 'platformer');
        return '/plat/root';
      },
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => {
        throw new Error('getDefaultWorkspaceRoot should not run for Platformer-only path');
      },
      runIssueFetchAndGitPrep: async (p) => {
        prepInfo = {
          workspaceRoot: p.workspaceRoot,
          issueNumber: p.issueNumber,
          alias: p.workspaceAlias,
        };
        return { prompt: 'p', issueSource: { number: 2, repo: REPO_P, title: 'Plat' } };
      },
      runCursorAgentWithPost: async () => {},
    });
    assert.ok(prepInfo, 'Platformer path should run prep');
    assert.equal(prepInfo.workspaceRoot, '/plat/root');
    assert.equal(prepInfo.alias, 'platformer');
    assert.equal(prepInfo.issueNumber, 2);
  });

  it('does not start Platformer when every open Platformer issue is PRD-titled', async () => {
    const sock = makeMockSock();
    let prepCalls = 0;
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async ({ repo }) => {
        if (repo === REPO) return [{ number: 1, title: 'PRD: wa' }];
        if (repo === REPO_P) {
          return [
            { number: 2, title: 'PRD: plat doc' },
            { number: 3, title: 'prd-dash' },
          ];
        }
        return [];
      },
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map(),
      resolveWorkspaceFromAlias: async () => '/plat',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => '/w',
      runIssueFetchAndGitPrep: async () => {
        prepCalls++;
        return { prompt: 'p', issueSource: { number: 1, repo: REPO, title: 'x' } };
      },
    });
    assert.equal(prepCalls, 0, 'no repo should run prep when both repos only have PRD-titled opens');
  });

  it('starts work on a different eligible issue when last-started was another number in that repo', async () => {
    const sock = makeMockSock();
    let prepFor = /** @type {number | null} */ (null);
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 20, title: 'New' }],
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map([[REPO, 3]]),
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async (p) => {
        prepFor = p.issueNumber;
        return {
          prompt: 'p',
          issueSource: { number: p.issueNumber, repo: REPO, title: 'New' },
        };
      },
      runCursorAgentWithPost: async () => {},
      writeCronPerRepoLastStartedEntry: async () => {},
    });
    assert.equal(prepFor, 20);
  });

  it('a Platformer last-started entry does not block a different issue number in that repo', async () => {
    const sock = makeMockSock();
    let pLists = 0;
    const last = new Map([
      [REPO, 7],
      [REPO_P, 2],
    ]);
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async ({ repo }) => {
        if (repo === REPO_P) pLists++;
        if (repo === REPO) return [];
        if (repo === REPO_P) {
          return [{ number: 3, title: 'C' }];
        }
        return [];
      },
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => last,
      resolveWorkspaceFromAlias: async () => '/plat',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => '/w',
      runIssueFetchAndGitPrep: async (p) => {
        assert.equal(p.workspaceRoot, '/plat');
        assert.equal(p.issueNumber, 3);
        return { prompt: 'p', issueSource: { number: 3, repo: REPO_P, title: 'C' } };
      },
      runCursorAgentWithPost: async () => {},
    });
    assert.equal(pLists, 1);
  });
});
