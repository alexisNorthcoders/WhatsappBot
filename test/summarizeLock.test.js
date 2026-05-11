import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSummarizeLockHeld,
  releaseSummarizeLock,
  resetSummarizeLockState,
  tryAcquireSummarizeLock,
} from '../whatsapp/utils/summarizeLock.js';

describe('summarizeLock', () => {
  let prevTtl;

  beforeEach(() => {
    prevTtl = process.env.SUMMARIZE_LOCK_TTL_MS;
    delete process.env.SUMMARIZE_LOCK_TTL_MS;
    resetSummarizeLockState();
  });

  afterEach(() => {
    resetSummarizeLockState();
    if (prevTtl === undefined) delete process.env.SUMMARIZE_LOCK_TTL_MS;
    else process.env.SUMMARIZE_LOCK_TTL_MS = prevTtl;
  });

  it('isSummarizeLockHeld is false when idle, true when held', () => {
    assert.equal(isSummarizeLockHeld(), false);
    const lease = tryAcquireSummarizeLock();
    assert.ok(lease);
    assert.equal(isSummarizeLockHeld(), true);
  });

  it('allows one holder and refuses a second (contention)', () => {
    const a = tryAcquireSummarizeLock();
    assert.ok(a);
    assert.equal(tryAcquireSummarizeLock(), null);
    releaseSummarizeLock(a.leaseId);
    assert.equal(tryAcquireSummarizeLock()?.leaseId, a.leaseId + 1);
  });

  it('releaseSummarizeLock allows a new acquire (try/finally semantics)', () => {
    const a = tryAcquireSummarizeLock();
    assert.ok(a);
    try {
      /* simulate work */
    } finally {
      releaseSummarizeLock(a.leaseId);
    }
    assert.equal(isSummarizeLockHeld(), false);
    assert.ok(tryAcquireSummarizeLock());
  });

  it('TTL watchdog aborts the lease signal; operator must release to unblock acquire', async () => {
    process.env.SUMMARIZE_LOCK_TTL_MS = '30';
    const lease = tryAcquireSummarizeLock();
    assert.ok(lease);
    assert.equal(isSummarizeLockHeld(), true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(lease.signal.aborted, true);
    assert.equal(isSummarizeLockHeld(), true, 'lock stays tied until summarize finally / releaseSummarizeLock');
    releaseSummarizeLock(lease.leaseId);
    assert.equal(isSummarizeLockHeld(), false);
    assert.ok(tryAcquireSummarizeLock());
  });

  it('TTL expiring during work keeps the lock busy until release (no concurrent leases)', async () => {
    process.env.SUMMARIZE_LOCK_TTL_MS = '30';
    const { leaseId, signal } = /** @type {NonNullable<ReturnType<typeof tryAcquireSummarizeLock>>} */ (
      tryAcquireSummarizeLock()
    );

    async function mockedSummarizePipeline() {
      try {
        await new Promise((_res, rej) => {
          if (signal.aborted) {
            rej(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
            return;
          }
          signal.addEventListener(
            'abort',
            () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
            { once: true },
          );
        });
      } catch {
        /* await settled */
      }
    }

    assert.equal(isSummarizeLockHeld(), true);
    const pip = mockedSummarizePipeline();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(tryAcquireSummarizeLock(), null, 'second acquire denied while lease still bound');
    assert.equal(isSummarizeLockHeld(), true);
    releaseSummarizeLock(leaseId);
    await pip;
    assert.equal(isSummarizeLockHeld(), false);
    const next = tryAcquireSummarizeLock();
    assert.ok(next);
    releaseSummarizeLock(next.leaseId);
  });

  it('a later lease keeps a long TTL after a prior short-TTL lease was released', async () => {
    process.env.SUMMARIZE_LOCK_TTL_MS = '30';
    const first = tryAcquireSummarizeLock();
    assert.ok(first);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(first.signal.aborted, true);
    releaseSummarizeLock(first.leaseId);
    assert.equal(isSummarizeLockHeld(), false);

    delete process.env.SUMMARIZE_LOCK_TTL_MS;
    const second = tryAcquireSummarizeLock();
    assert.ok(second);
    assert.equal(second.leaseId, first.leaseId + 1);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(isSummarizeLockHeld(), true);
    assert.equal(second.signal.aborted, false);
    releaseSummarizeLock(second.leaseId);
    assert.equal(isSummarizeLockHeld(), false);
  });

  it('release with an old leaseId is a no-op when a newer lease is held', () => {
    const a = tryAcquireSummarizeLock();
    assert.ok(a);
    releaseSummarizeLock(a.leaseId);
    const b = tryAcquireSummarizeLock();
    assert.ok(b);
    releaseSummarizeLock(a.leaseId);
    assert.equal(isSummarizeLockHeld(), true);
    releaseSummarizeLock(b.leaseId);
    assert.equal(isSummarizeLockHeld(), false);
  });
});
