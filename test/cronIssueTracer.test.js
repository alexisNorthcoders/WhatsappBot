import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickNextEligibleIssue,
  pickNextRunnableIssueForRepo,
  runCronIssueTracerTick,
} from '../whatsapp/agents/cronIssueTracer.js';
import { cronShouldPersistLastStarted } from '../whatsapp/agents/claudeIssuePipeline.js';
import {
  isClaudeAgentBusy,
  releaseAgentBusyLock,
} from '../whatsapp/agents/claudeAgentBusy.js';

describe('cronShouldPersistLastStarted', () => {
  it('treats void / null results as persist (legacy successful mocks)', () => {
    assert.equal(cronShouldPersistLastStarted(undefined), true);
    assert.equal(cronShouldPersistLastStarted(null), true);
  });

  it('does not persist empty agent success (clean_after_wait)', () => {
    assert.equal(
      cronShouldPersistLastStarted({
        agentRunOk: true,
        post: { ran: false, skipReason: 'clean_after_wait' },
      }),
      false
    );
  });

  it('does not persist failed agent runs', () => {
    assert.equal(
      cronShouldPersistLastStarted({ agentRunOk: false, post: { skipReason: 'agent_not_ok' } }),
      false
    );
    assert.equal(cronShouldPersistLastStarted({ agentRunOk: false, post: null }), false);
  });

  it('persists when agent ok and post-run made progress', () => {
    assert.equal(
      cronShouldPersistLastStarted({ agentRunOk: true, post: { ran: true } }),
      true
    );
  });
});

describe('pickNextEligibleIssue', () => {
  it('returns null when no issue carries the ready-for-agent label', () => {
    const r = pickNextEligibleIssue([
      { number: 23, title: 'Needs triage', labels: ['needs-triage'] },
      { number: 99, title: 'No labels at all', labels: [] },
    ]);
    assert.equal(r, null);
  });

  it('ignores case and whitespace in the label name', () => {
    const r = pickNextEligibleIssue([
      { number: 10, title: 'x', labels: ['needs-triage'] },
      { number: 2, title: 'real task', labels: [' Ready-For-Agent '] },
    ]);
    assert.deepEqual(r, { number: 2, title: 'real task', labels: [' Ready-For-Agent '] });
  });

  it('picks lowest issue number among ready-for-agent-labeled issues', () => {
    const r = pickNextEligibleIssue([
      { number: 30, title: 'Later', labels: ['ready-for-agent'] },
      { number: 5, title: 'First eligible', labels: ['ready-for-agent'] },
      { number: 8, title: 'Mid', labels: ['ready-for-agent'] },
    ]);
    assert.deepEqual(r, { number: 5, title: 'First eligible', labels: ['ready-for-agent'] });
  });

  it('ignores issues with an unrelated label set', () => {
    const r = pickNextEligibleIssue([{ number: 1, title: 'Doc PRD', labels: ['documentation'] }]);
    assert.equal(r, null);
  });

  it('treats a missing labels array as ineligible', () => {
    const r = pickNextEligibleIssue([
      { number: 1, title: 'no labels field' },
      { number: 2, title: 'bugfix', labels: ['ready-for-agent'] },
    ]);
    assert.deepEqual(r, { number: 2, title: 'bugfix', labels: ['ready-for-agent'] });
  });

  it('does not treat other labels as a match for ready-for-agent', () => {
    const r = pickNextEligibleIssue([
      { number: 9, title: 'Ship feature', labels: ['ready-for-human'] },
    ]);
    assert.equal(r, null);
  });

  it('picks an issue that has ready-for-agent alongside other labels', () => {
    const r = pickNextEligibleIssue([
      { number: 3, title: 'Follow-up', labels: ['enhancement', 'ready-for-agent'] },
    ]);
    assert.deepEqual(r, {
      number: 3,
      title: 'Follow-up',
      labels: ['enhancement', 'ready-for-agent'],
    });
  });
});

describe('pickNextRunnableIssueForRepo', () => {
  it('returns null when the only eligible issue matches last-started for that repo', () => {
    const last = new Map([[REPO, 3]]);
    const r = pickNextRunnableIssueForRepo(
      [{ number: 3, title: 'Open', labels: ['ready-for-agent'] }],
      REPO,
      last
    );
    assert.equal(r, null);
  });

  it('returns the eligible issue when last-started is a different number', () => {
    const last = new Map([[REPO, 2]]);
    const r = pickNextRunnableIssueForRepo(
      [{ number: 5, title: 'Open', labels: ['ready-for-agent'] }],
      REPO,
      last
    );
    assert.deepEqual(r, { number: 5, title: 'Open', labels: ['ready-for-agent'] });
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
    if (isClaudeAgentBusy()) {
      releaseAgentBusyLock();
    }
  });

  it('returns without listing issues when the agent is already busy', async () => {
    assert.equal(isClaudeAgentBusy(), false);
    const sock = makeMockSock();
    let listCalls = 0;
    let prepCalls = 0;
    let agentCalls = 0;
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      isClaudeAgentBusy: () => true,
      listOpenGithubIssues: async () => {
        listCalls++;
        return [];
      },
      runIssueFetchAndGitPrep: async () => {
        prepCalls++;
        return null;
      },
      runClaudeAgentWithPost: async () => {
        agentCalls++;
      },
    });
    assert.equal(listCalls, 0);
    assert.equal(prepCalls, 0);
    assert.equal(agentCalls, 0);
    assert.equal(sock.sent.length, 0, 'owner should not get cron noise while a manual run holds the lock');
    assert.equal(isClaudeAgentBusy(), false, 'cron early-return must not mutate the real busy lock');
  });

  it('releases the agent busy lock when issue fetch / git prep returns null', async () => {
    const sock = makeMockSock();
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 1, title: 'Task', labels: ['ready-for-agent'] }],
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map(),
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => null,
      runClaudeAgentWithPost: async () => {
        throw new Error('runClaudeAgentWithPost should not run when prep failed');
      },
    });
    assert.equal(isClaudeAgentBusy(), false);
  });

  it('releases the agent busy lock when runClaudeAgentWithPost throws', async () => {
    const sock = makeMockSock();
    /** @type {unknown[]} */
    const writes = [];
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 2, title: 'Task', labels: ['ready-for-agent'] }],
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map(),
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => ({
        prompt: 'p',
        issueSource: { number: 2, repo: REPO, title: 'Task' },
      }),
      runClaudeAgentWithPost: async () => {
        throw 'non-Error rejection';
      },
      writeCronPerRepoLastStartedEntry: async (row) => {
        writes.push(row);
      },
    });
    assert.equal(isClaudeAgentBusy(), false);
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
        if (repo === REPO) return [{ number: 10, title: 'Still open', labels: ['ready-for-agent'] }];
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
      if (repo === REPO) return [{ number: 7, title: 'Work', labels: ['ready-for-agent'] }];
      if (repo === REPO_P) return [];
      throw new Error(`unexpected list ${repo}`);
    };

    const successfulProgress = async () => ({
      agentRunOk: true,
      post: { ran: true },
    });

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
      runClaudeAgentWithPost: successfulProgress,
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
      runClaudeAgentWithPost: async () => {
        throw new Error('should not run again for same issue');
      },
    });
    assert.equal(prepCalls, 1);

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
      runClaudeAgentWithPost: async () => {
        throw new Error('should not run on third tick either');
      },
    });
    assert.equal(prepCalls, 1, 'persisted last-started must block duplicate auto-starts across ticks');
  });

  it('does not persist last-started after an empty agent success so the same issue can retry', async () => {
    const sock = makeMockSock();
    /** @type {unknown[]} */
    const writes = [];
    let prepCalls = 0;
    const listBoth = async (/** @type {{ repo: string }} */ { repo }) => {
      if (repo === REPO) return [{ number: 32, title: 'Still open', labels: ['ready-for-agent'] }];
      if (repo === REPO_P) return [];
      throw new Error(`unexpected list ${repo}`);
    };

    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: listBoth,
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map(),
      writeCronPerRepoLastStartedEntry: async (row) => {
        writes.push(row);
      },
      resolveWorkspaceFromAlias: async () => '/plat',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => {
        prepCalls++;
        return {
          prompt: 'p',
          issueSource: { number: 32, repo: REPO, title: 'Still open' },
        };
      },
      runClaudeAgentWithPost: async () => ({
        agentRunOk: true,
        post: { ran: false, skipReason: 'clean_after_wait' },
      }),
    });
    assert.equal(prepCalls, 1);
    assert.deepEqual(writes, []);
    assert.ok(
      sock.sent.some((m) => m.text.includes('Not recording last-started')),
      'owner should be told the issue remains eligible'
    );

    // Next tick can start the same issue again
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: listBoth,
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map(),
      writeCronPerRepoLastStartedEntry: async (row) => {
        writes.push(row);
      },
      resolveWorkspaceFromAlias: async () => '/plat',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async () => {
        prepCalls++;
        return {
          prompt: 'p',
          issueSource: { number: 32, repo: REPO, title: 'Still open' },
        };
      },
      runClaudeAgentWithPost: async () => ({
        agentRunOk: true,
        post: { ran: true },
      }),
    });
    assert.equal(prepCalls, 2);
    assert.deepEqual(writes, [{ repo: REPO, number: 32 }]);
  });

  it('prefers WhatsappBot over Platformer when both have eligible issues (repo priority)', async () => {
    const sock = makeMockSock();
    let platListed = false;
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async ({ repo }) => {
        if (repo === REPO) {
          return [{ number: 50, title: 'WA task', labels: ['ready-for-agent'] }];
        }
        if (repo === REPO_P) {
          platListed = true;
          return [{ number: 1, title: 'Lower number but secondary repo', labels: ['ready-for-agent'] }];
        }
        throw new Error(`unexpected list ${repo}`);
      },
      resolveIssueRepoSlug: () => REPO,
      readCronPerRepoLastStarted: async () => new Map(),
      resolveWorkspaceFromAlias: async () => '/plat',
      resolveIssueRepoSlugForWorkspace: async () => REPO_P,
      getDefaultWorkspaceRoot: async () => '/tmp/ws',
      runIssueFetchAndGitPrep: async (p) => {
        assert.equal(p.issueNumber, 50);
        assert.equal(p.workspaceRoot, '/tmp/ws');
        return {
          prompt: 'p',
          issueSource: { number: 50, repo: REPO, title: 'WA task' },
        };
      },
      runClaudeAgentWithPost: async () => {},
    });
    assert.equal(platListed, false, 'Platformer must not be consulted when WhatsappBot still has runnable work');
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
        return [{ number: 1, title: 'WA', labels: ['ready-for-agent'] }];
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
      runClaudeAgentWithPost: async () => {},
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
          return [{ number: 9, title: 'WA task', labels: ['ready-for-agent'] }];
        }
        if (repo === REPO_P) {
          return [{ number: 4, title: 'Plat task', labels: ['ready-for-agent'] }];
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
      runClaudeAgentWithPost: async () => {},
    });
    assert.ok(listCalls >= 2, 'WhatsappBot and Platformer issue lists should run');
    assert.ok(prepInfo, 'Platformer path should run prep');
    assert.equal(prepInfo.workspaceRoot, '/plat/root');
    assert.equal(prepInfo.issueNumber, 4);
  });

  it('uses Platformer when WhatsappBot has no eligible issues (e.g. none labeled ready-for-agent)', async () => {
    const sock = makeMockSock();
    let prepInfo = /** @type {null | { workspaceRoot: string, issueNumber: number, alias: string | null }} */ (
      null
    );
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      cronPlatformerAlias: 'platformer',
      listOpenGithubIssues: async ({ repo }) => {
        if (repo === REPO) {
          return [{ number: 5, title: 'x', labels: ['needs-triage'] }];
        }
        if (repo === REPO_P) {
          return [{ number: 2, title: 'Plat', labels: ['ready-for-agent'] }];
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
      runClaudeAgentWithPost: async () => {},
    });
    assert.ok(prepInfo, 'Platformer path should run prep');
    assert.equal(prepInfo.workspaceRoot, '/plat/root');
    assert.equal(prepInfo.alias, 'platformer');
    assert.equal(prepInfo.issueNumber, 2);
  });

  it('does not start Platformer when no open Platformer issue is labeled ready-for-agent', async () => {
    const sock = makeMockSock();
    let prepCalls = 0;
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async ({ repo }) => {
        if (repo === REPO) return [{ number: 1, title: 'wa', labels: ['needs-triage'] }];
        if (repo === REPO_P) {
          return [
            { number: 2, title: 'plat doc', labels: [] },
            { number: 3, title: 'ready-for-human item', labels: ['ready-for-human'] },
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
    assert.equal(
      prepCalls,
      0,
      'no repo should run prep when neither repo has a ready-for-agent-labeled open issue'
    );
  });

  it('starts work on a different eligible issue when last-started was another number in that repo', async () => {
    const sock = makeMockSock();
    let prepFor = /** @type {number | null} */ (null);
    await runCronIssueTracerTick({
      getSocket: () => sock,
      getOwnerJid: () => OWNER,
      listOpenGithubIssues: async () => [{ number: 20, title: 'New', labels: ['ready-for-agent'] }],
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
      runClaudeAgentWithPost: async () => {},
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
          return [{ number: 3, title: 'C', labels: ['ready-for-agent'] }];
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
      runClaudeAgentWithPost: async () => {},
    });
    assert.equal(pLists, 1);
  });
});
