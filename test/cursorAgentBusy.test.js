import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
} from '../whatsapp/agents/cursorAgentBusy.js';

describe('cursorAgentBusy lock', () => {
  beforeEach(() => {
    releaseAgentBusyLock();
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
