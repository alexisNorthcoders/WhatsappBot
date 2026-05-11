/** Process-wide: only one WhatsApp *summarize* run at a time; TTL watchdog aborts stuck work via the lease AbortSignal. */

let nextLeaseId = 1;

/** @type {number | null} */
let currentLeaseId = null;

/** @type {AbortController | null} */
let leaseAbortController = null;

/** @type {ReturnType<typeof setTimeout> | null} */
let watchdogTimer = null;

function ttlMsFromEnv() {
  const n = parseInt(process.env.SUMMARIZE_LOCK_TTL_MS || '600000', 10);
  if (!Number.isFinite(n) || n < 1) return 600_000;
  return Math.min(n, 3_600_000);
}

/**
 * Clears timer + lease state unconditionally (tests / process hygiene).
 * @internal
 */
export function resetSummarizeLockState() {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  leaseAbortController?.abort();
  currentLeaseId = null;
  leaseAbortController = null;
}

/**
 * @returns {boolean} whether the summarize lock is currently held
 */
export function isSummarizeLockHeld() {
  return currentLeaseId !== null;
}

/**
 * @returns {{ leaseId: number, signal: AbortSignal } | null} lease + combined abort (TTL watchdog + caller), or null if busy
 */
export function tryAcquireSummarizeLock() {
  if (currentLeaseId !== null) return null;
  const leaseId = nextLeaseId++;
  currentLeaseId = leaseId;
  leaseAbortController = new AbortController();
  const { signal } = leaseAbortController;

  const ttl = ttlMsFromEnv();
  const scheduledLease = leaseId;
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (currentLeaseId !== scheduledLease) return;
    leaseAbortController?.abort();
  }, ttl);

  if (typeof watchdogTimer.unref === 'function') {
    watchdogTimer.unref();
  }

  return { leaseId, signal };
}

/**
 * Releases the summarize lock only if `leaseId` matches the active lease.
 * Stale timeouts and late `finally` paths must not drop a newer holder.
 * @param {number} leaseId from {@link tryAcquireSummarizeLock}
 */
export function releaseSummarizeLock(leaseId) {
  if (currentLeaseId !== leaseId) return;
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  currentLeaseId = null;
  leaseAbortController = null;
}
