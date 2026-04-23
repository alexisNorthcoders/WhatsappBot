import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCursorAgentBusy,
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
} from '../whatsapp/agents/cursorAgentBusy.js';

describe('cursorAgentBusy lock', () => {
  beforeEach(() => {
    releaseAgentBusyLock();
  });

  it('isCursorAgentBusy is false when idle, true when held', () => {
    assert.equal(isCursorAgentBusy(), false);
    assert.equal(tryAcquireAgentBusyLock(), true);
    assert.equal(isCursorAgentBusy(), true);
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
