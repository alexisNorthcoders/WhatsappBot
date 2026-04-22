import {
  VERDICT_REQUEST_CHANGES,
  autoMergeAllowedByReviewGate,
} from './cursorPostRunDecisionLogic.js';

/**
 * Post-LLM-review steps: optional single autofix pass, merge-gate PR comment, auto-merge + issue poll.
 * Dependencies are injected so `node:test` can mock `gh`, git-backed helpers, and Cursor CLI.
 */
export async function runPostReviewAutofixMergeFlow({
  repo,
  issueNum,
  userPrompt,
  prResult,
  reviewOutcome,
  reviewVerdict,
  reviewBodyMarkdown,
  postReviewAutofixEnabled,
  prAutoMergeAfterReviewEnabled,
  prAfterPushEnabled,
  commitOk,
  pushResultOk,
  runSinglePostReviewAutofix,
  tryGhPrReviewComment,
  tryGhPrMergeAutoSquash,
  waitForGithubIssueClosed,
  logPost = () => {},
}) {
  let postReviewAutofix = null;
  if (
    postReviewAutofixEnabled() &&
    reviewVerdict === VERDICT_REQUEST_CHANGES &&
    reviewOutcome === 'success'
  ) {
    const shouldAutofix = commitOk && Boolean(pushResultOk) && Boolean(prResult?.ok);
    if (shouldAutofix) {
      postReviewAutofix = await runSinglePostReviewAutofix({
        repo,
        issueNum,
        prUrl: prResult.url,
        bodyMarkdown: reviewBodyMarkdown,
        originalUserPrompt: userPrompt,
      });
      if (postReviewAutofix.mergeBlocked && prResult.ok) {
        const gateBody = [
          '**WhatsApp bot — automated autofix failed**',
          '',
          postReviewAutofix.detail,
          '',
          '**Do not merge** this PR until the review feedback is addressed (manually or with another `cursor issue:…` run).',
        ].join('\n');
        const gateComment = await tryGhPrReviewComment(repo, prResult.url, gateBody);
        logPost('post-review autofix merge-gate PR comment', gateComment);
      }
    } else {
      logPost('post-review autofix skipped (needs successful commit, push, and open PR)', {
        commitOk,
        pushOk: Boolean(pushResultOk),
        prOk: Boolean(prResult?.ok),
      });
    }
  }

  let prAutoMergeResult = null;
  let issueCloseWait = null;
  if (
    prAutoMergeAfterReviewEnabled() &&
    prAfterPushEnabled() &&
    prResult?.ok &&
    autoMergeAllowedByReviewGate({ reviewOutcome, reviewVerdict, postReviewAutofix })
  ) {
    prAutoMergeResult = await tryGhPrMergeAutoSquash(repo, prResult.url);
    logPost('gh pr merge --auto --squash', prAutoMergeResult);
    if (prAutoMergeResult.ok) {
      issueCloseWait = await waitForGithubIssueClosed(repo, issueNum);
      logPost('wait for issue closed', issueCloseWait);
    }
  } else if (prAutoMergeAfterReviewEnabled() && prAfterPushEnabled() && prResult?.ok) {
    logPost('skip auto-merge (review gate)', {
      reviewOutcome,
      reviewVerdict,
      autofixOk: postReviewAutofix?.ok,
    });
  }

  return { postReviewAutofix, prAutoMergeResult, issueCloseWait };
}
