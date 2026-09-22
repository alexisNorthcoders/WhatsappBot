import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessageFromUnknown, buildIssueRunWhatsappMessage } from '../whatsapp/agents/claudeIssuePipeline.js';

describe('errorMessageFromUnknown', () => {
  it('uses Error.message', () => {
    assert.equal(errorMessageFromUnknown(new Error('oops')), 'oops');
  });

  it('stringifies non-Error throws', () => {
    assert.equal(errorMessageFromUnknown('boom'), 'boom');
    assert.equal(errorMessageFromUnknown(null), 'null');
  });

  it('reads message from plain object', () => {
    assert.equal(errorMessageFromUnknown({ message: 'from object' }), 'from object');
  });

  it('falls back when message is empty', () => {
    assert.ok(
      String(errorMessageFromUnknown({ message: '' })).length > 0
    );
  });
});

describe('buildIssueRunWhatsappMessage', () => {
  const issue = { number: 114, title: 'Fix the thing' };
  const okPost = {
    note: 'long narrative with review and changes summary',
    commit: { ok: true },
    pushResult: { ok: true },
    prResult: { ok: true, url: 'https://github.com/o/r/pull/9' },
    prAutoMergeResult: { ok: true, mergedDirectly: true },
    issueCloseWait: { closed: true },
    postCloseChangesEmail: { ok: true },
  };

  it('returns a one-line merged result without the narrative', () => {
    const msg = buildIssueRunWhatsappMessage({ issue, agentRunOk: true, post: okPost });
    assert.equal(msg, '✅ #114 merged — Fix the thing');
    assert.ok(!msg.includes('\n'));
  });

  it('returns PR open with url when no merge was queued', () => {
    const msg = buildIssueRunWhatsappMessage({
      issue,
      agentRunOk: true,
      post: { ...okPost, prAutoMergeResult: null, issueCloseWait: null, postCloseChangesEmail: null },
    });
    assert.equal(msg, '✅ #114 PR open — Fix the thing https://github.com/o/r/pull/9');
  });

  it('flags agent timeout', () => {
    const msg = buildIssueRunWhatsappMessage({
      issue,
      agentRunOk: false,
      result: { timedOut: true, signal: 'SIGTERM' },
      post: { ran: false, note: '', skipReason: 'agent_not_ok' },
    });
    assert.match(msg, /^⚠️ #114/);
    assert.match(msg, /timed out/);
  });

  it('flags a merge blocked by autofix and a failed post-close email', () => {
    assert.match(
      buildIssueRunWhatsappMessage({
        issue,
        agentRunOk: true,
        post: { ...okPost, postReviewAutofix: { mergeBlocked: true, detail: 'x' } },
      }),
      /merge blocked/
    );
    assert.match(
      buildIssueRunWhatsappMessage({
        issue,
        agentRunOk: true,
        post: { ...okPost, postCloseChangesEmail: { ok: false, step: 'smtp' } },
      }),
      /email failed/
    );
  });

  it('flags a post-run exception and PR creation failure', () => {
    assert.match(
      buildIssueRunWhatsappMessage({
        issue,
        agentRunOk: true,
        post: { ran: false, note: '', skipReason: 'post_run_threw' },
        postErrMessage: 'boom',
      }),
      /post-run pipeline failed \(boom\)/
    );
    assert.match(
      buildIssueRunWhatsappMessage({
        issue,
        agentRunOk: true,
        post: { ...okPost, prResult: { ok: false, error: 'gh auth' } },
      }),
      /PR creation failed/
    );
  });

  it('stays silent when the agent changed nothing', () => {
    assert.equal(
      buildIssueRunWhatsappMessage({
        issue,
        agentRunOk: true,
        post: { ran: false, note: '', skipReason: 'clean_after_wait' },
      }),
      null
    );
  });
});
