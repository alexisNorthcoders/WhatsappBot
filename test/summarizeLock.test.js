import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSummarizeLockHeld,
  releaseSummarizeLock,
  tryAcquireSummarizeLock,
} from '../whatsapp/utils/summarizeLock.js';

describe('summarizeLock', () => {
  let prevTtl;

  beforeEach(() => {
    prevTtl = process.env.SUMMARIZE_LOCK_TTL_MS;
    delete process.env.SUMMARIZE_LOCK_TTL_MS;
    releaseSummarizeLock();
  });

  afterEach(() => {
    releaseSummarizeLock();
    if (prevTtl === undefined) delete process.env.SUMMARIZE_LOCK_TTL_MS;
    else process.env.SUMMARIZE_LOCK_TTL_MS = prevTtl;
  });

  it('isSummarizeLockHeld is false when idle, true when held', () => {
    assert.equal(isSummarizeLockHeld(), false);
    assert.equal(tryAcquireSummarizeLock(), true);
    assert.equal(isSummarizeLockHeld(), true);
  });

  it('allows one holder and refuses a second (contention)', () => {
    assert.equal(tryAcquireSummarizeLock(), true);
    assert.equal(tryAcquireSummarizeLock(), false);
  });

  it('releaseSummarizeLock allows a new acquire (try/finally semantics)', () => {
    assert.equal(tryAcquireSummarizeLock(), true);
    try {
      /* simulate work */
    } finally {
      releaseSummarizeLock();
    }
    assert.equal(isSummarizeLockHeld(), false);
    assert.equal(tryAcquireSummarizeLock(), true);
  });

  it('auto-releases after TTL when the run never calls release', async () => {
    process.env.SUMMARIZE_LOCK_TTL_MS = '30';
    assert.equal(tryAcquireSummarizeLock(), true);
    assert.equal(isSummarizeLockHeld(), true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(isSummarizeLockHeld(), false);
    assert.equal(tryAcquireSummarizeLock(), true);
  });
});
