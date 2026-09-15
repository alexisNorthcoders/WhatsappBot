import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isClaudeAgentBusy,
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
} from '../whatsapp/agents/claudeAgentBusy.js';

describe('claudeAgentBusy lock', () => {
  beforeEach(() => {
    releaseAgentBusyLock();
  });

  it('isClaudeAgentBusy is false when idle, true when held', () => {
    assert.equal(isClaudeAgentBusy(), false);
    assert.equal(tryAcquireAgentBusyLock(), true);
    assert.equal(isClaudeAgentBusy(), true);
  });

  it('allows one holder and refuses a second', () => {
    assert.equal(tryAcquireAgentBusyLock(), true);
    assert.equal(tryAcquireAgentBusyLock(), false);
  });

  it('releases in finally so a new run can acquire', () => {
    assert.equal(tryAcquireAgentBusyLock(), true);
    try {
      /* simulate work */
    } finally {
      releaseAgentBusyLock();
    }
    assert.equal(tryAcquireAgentBusyLock(), true);
  });
});
