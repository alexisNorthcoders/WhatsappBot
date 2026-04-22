import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  VERDICT_APPROVE,
  VERDICT_REQUEST_CHANGES,
  autoMergeAllowedByReviewGate,
  pickPrResultAfterGhFlow,
  normalizePrReviewComment,
} from '../whatsapp/agents/cursorPostRunDecisionLogic.js';
import { pollGithubIssueClosedOrTimeout } from '../whatsapp/agents/cursorPostRunIssuePoll.js';
import { runPostReviewAutofixMergeFlow } from '../whatsapp/agents/cursorPostRunReviewFollowUp.js';

describe('cursorPostRun decision logic', () => {
  it('VERDICT: APPROVE with successful review enables auto-merge gate without autofix', () => {
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_APPROVE,
        postReviewAutofix: null,
      }),
      true
    );
  });

  it('VERDICT: REQUEST_CHANGES does not enable auto-merge until autofix succeeds', () => {
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: null,
      }),
      false
    );
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: { ok: false, mergeBlocked: true },
      }),
      false
    );
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: { ok: true, mergeBlocked: false },
      }),
      true
    );
  });

  it('autofix failure / no-op path blocks auto-merge (mergeBlocked implies ok false)', () => {
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: { ok: false, mergeBlocked: true, detail: 'no changes' },
      }),
      false
    );
  });

  it('PR "already exists" still yields a usable PR URL via recovery', () => {
    const picked = pickPrResultAfterGhFlow({
      listedOk: false,
      createOk: false,
      createError: 'GraphQL: A pull request already exists for cursor:branch',
      recoveredUrl: 'https://github.com/o/r/pull/99',
    });
    assert.equal(picked.ok, true);
    assert.equal(picked.url, 'https://github.com/o/r/pull/99');
    assert.equal(picked.prOutcome, 'recovered');
  });

  it('normalizePrReviewComment defaults invalid first lines to REQUEST_CHANGES', () => {
    const n = normalizePrReviewComment('not a verdict\n\nbody');
    assert.equal(n.verdict, VERDICT_REQUEST_CHANGES);
    assert.match(n.fullComment, /VERDICT: REQUEST_CHANGES/);
  });
});

describe('issue close polling (no live GitHub)', () => {
  it('times out without throwing when the issue never closes', async () => {
    let t = 0;
    const now = () => t;
    const sleep = mock.fn(async (ms) => {
      t += ms;
    });
    const fetchState = async () => ({ ok: true, state: 'OPEN' });
    const result = await pollGithubIssueClosedOrTimeout({
      maxWaitMs: 45,
      pollMs: 10,
      fetchState,
      sleep,
      now,
    });
    assert.equal(result.closed, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.waitedMs >= 45);
    assert.ok(sleep.mock.callCount() >= 4);
  });

  it('returns closed when fetchState reports CLOSED before timeout', async () => {
    let n = 0;
    const fetchState = async () => {
      n++;
      return n >= 2 ? { ok: true, state: 'CLOSED' } : { ok: true, state: 'OPEN' };
    };
    const result = await pollGithubIssueClosedOrTimeout({
      maxWaitMs: 500,
      pollMs: 0,
      fetchState,
      sleep: async () => {},
      now: () => 0,
    });
    assert.equal(result.closed, true);
    assert.equal(result.timedOut, false);
  });
});

describe('runPostReviewAutofixMergeFlow (mocked gh + agent)', () => {
  it('REQUEST_CHANGES triggers exactly one autofix invocation', async () => {
    let autofixCalls = 0;
    const runSinglePostReviewAutofix = async () => {
      autofixCalls++;
      return { ok: true, mergeBlocked: false, detail: 'ok' };
    };
    const tryGhPrMergeAutoSquash = mock.fn(async () => ({ ok: true }));
    const tryGhPrReviewComment = mock.fn(async () => ({ ok: true }));
    const waitForGithubIssueClosed = mock.fn(async () => ({
      closed: false,
      timedOut: true,
      waitedMs: 0,
      polls: 0,
    }));

    await runPostReviewAutofixMergeFlow({
      repo: '/tmp/repo',
      issueNum: 15,
      userPrompt: 'x',
      prResult: { ok: true, url: 'https://github.com/o/r/pull/1' },
      reviewOutcome: 'success',
      reviewVerdict: VERDICT_REQUEST_CHANGES,
      reviewBodyMarkdown: 'fix it',
      postReviewAutofixEnabled: () => true,
      prAutoMergeAfterReviewEnabled: () => true,
      prAfterPushEnabled: () => true,
      commitOk: true,
      pushResultOk: true,
      runSinglePostReviewAutofix,
      tryGhPrReviewComment,
      tryGhPrMergeAutoSquash,
      waitForGithubIssueClosed,
      logPost: () => {},
    });

    assert.equal(autofixCalls, 1);
    assert.equal(tryGhPrMergeAutoSquash.mock.callCount(), 1);
  });

  it('REQUEST_CHANGES with autofix mergeBlocked skips auto-merge', async () => {
    const runSinglePostReviewAutofix = async () => ({
      ok: false,
      mergeBlocked: true,
      detail: 'Autofix finished but **git detected no file changes**',
    });
    const tryGhPrMergeAutoSquash = mock.fn(async () => ({ ok: true }));
    const tryGhPrReviewComment = mock.fn(async () => ({ ok: true }));
    const waitForGithubIssueClosed = mock.fn(async () => ({}));

    await runPostReviewAutofixMergeFlow({
      repo: '/tmp/repo',
      issueNum: 2,
      userPrompt: 'x',
      prResult: { ok: true, url: 'https://github.com/o/r/pull/2' },
      reviewOutcome: 'success',
      reviewVerdict: VERDICT_REQUEST_CHANGES,
      reviewBodyMarkdown: 'x',
      postReviewAutofixEnabled: () => true,
      prAutoMergeAfterReviewEnabled: () => true,
      prAfterPushEnabled: () => true,
      commitOk: true,
      pushResultOk: true,
      runSinglePostReviewAutofix,
      tryGhPrReviewComment,
      tryGhPrMergeAutoSquash,
      waitForGithubIssueClosed,
      logPost: () => {},
    });

    assert.equal(tryGhPrMergeAutoSquash.mock.callCount(), 0);
    assert.ok(tryGhPrReviewComment.mock.callCount() >= 1);
  });

  it('APPROVE runs auto-merge without calling autofix', async () => {
    const runSinglePostReviewAutofix = mock.fn(async () => ({ ok: true, mergeBlocked: false, detail: '' }));
    const tryGhPrMergeAutoSquash = mock.fn(async () => ({ ok: true }));
    const tryGhPrReviewComment = mock.fn(async () => ({ ok: true }));
    const waitForGithubIssueClosed = mock.fn(async () => ({
      closed: false,
      timedOut: true,
      waitedMs: 1,
      polls: 1,
    }));

    await runPostReviewAutofixMergeFlow({
      repo: '/tmp/repo',
      issueNum: 3,
      userPrompt: 'x',
      prResult: { ok: true, url: 'https://github.com/o/r/pull/3' },
      reviewOutcome: 'success',
      reviewVerdict: VERDICT_APPROVE,
      reviewBodyMarkdown: '',
      postReviewAutofixEnabled: () => true,
      prAutoMergeAfterReviewEnabled: () => true,
      prAfterPushEnabled: () => true,
      commitOk: true,
      pushResultOk: true,
      runSinglePostReviewAutofix,
      tryGhPrReviewComment,
      tryGhPrMergeAutoSquash,
      waitForGithubIssueClosed,
      logPost: () => {},
    });

    assert.equal(runSinglePostReviewAutofix.mock.callCount(), 0);
    assert.equal(tryGhPrMergeAutoSquash.mock.callCount(), 1);
  });
});
