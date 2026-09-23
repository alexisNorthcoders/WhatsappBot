import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildIssueModePrBody } from '../whatsapp/agents/claudePostRun.js';

const workBranch = { branchName: 'claude/issue-7-thing', prBase: 'main' };

describe('buildIssueModePrBody trigger wording', () => {
  it('names the cron issue tracer for cron-triggered runs', () => {
    const body = buildIssueModePrBody(7, workBranch, 'do the thing', 'cron');
    assert.match(body, /^Fixes #7\n/);
    assert.match(
      body,
      /Opened automatically by the cron issue tracer \(`ready-for-agent` label\) from the WhatsApp bot\./
    );
    assert.doesNotMatch(body, /claude issue:/);
  });

  it('names the `claude issue:…` command for manual runs', () => {
    const body = buildIssueModePrBody(7, workBranch, 'do the thing', 'manual');
    assert.match(body, /Opened automatically after a `claude issue:…` run from the WhatsApp bot\./);
    assert.doesNotMatch(body, /cron issue tracer/);
  });

  it('defaults to the manual wording when no trigger is given', () => {
    const body = buildIssueModePrBody(7, workBranch, 'do the thing');
    assert.match(body, /Opened automatically after a `claude issue:…` run from the WhatsApp bot\./);
  });
});
