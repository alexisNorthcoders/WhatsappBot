import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  githubPrMergeErrorLooksStaleHead,
  githubPrUpdateBranchErrorLooksNoOp,
} from '../whatsapp/agents/cursorPostRun.js';

describe('PR merge / update-branch error heuristics', () => {
  it('detects stale-head auto-merge errors', () => {
    assert.equal(
      githubPrMergeErrorLooksStaleHead(
        'Head branch is out of date. Review and try the merge again.'
      ),
      true
    );
    assert.equal(githubPrMergeErrorLooksStaleHead('unrelated failure'), false);
  });

  it('treats GitHub update-branch 422 no-op as retryable', () => {
    const msg =
      '{"message":"There are no new commits on the base branch.","status":"422"}gh: There are no new commits on the base branch. (HTTP 422)';
    assert.equal(githubPrUpdateBranchErrorLooksNoOp(msg), true);
    assert.equal(githubPrUpdateBranchErrorLooksNoOp('merge conflict on update-branch'), false);
  });
});
