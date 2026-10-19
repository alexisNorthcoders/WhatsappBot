/** Process-wide: only one WhatsApp *summarize* run at a time; TTL watchdog aborts stuck work via the lease AbortSignal. */

let nextLeaseId = 1;

let currentLeaseId: number | null = null;
let leaseAbortController: AbortController | null = null;
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

function ttlMsFromEnv(): number {
  const n = parseInt(process.env.SUMMARIZE_LOCK_TTL_MS || '600000', 10);
  if (!Number.isFinite(n) || n < 1) return 600_000;
  return Math.min(n, 3_600_000);
}

/**
 * Clears timer + lease state unconditionally (tests / process hygiene).
 * @internal
 */
export function resetSummarizeLockState(): void {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  leaseAbortController?.abort();
  currentLeaseId = null;
  leaseAbortController = null;
}

export function isSummarizeLockHeld(): boolean {
  return currentLeaseId !== null;
}

/** Returns the lease and its abort signal (fired by the TTL watchdog), or null if busy. */
export function tryAcquireSummarizeLock(): { leaseId: number; signal: AbortSignal } | null {
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

  watchdogTimer.unref();

  return { leaseId, signal };
}

/**
 * Releases the summarize lock only if `leaseId` matches the active lease.
 * Stale timeouts and late `finally` paths must not drop a newer holder.
 */
export function releaseSummarizeLock(leaseId: number): void {
  if (currentLeaseId !== leaseId) return;
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  currentLeaseId = null;
  leaseAbortController = null;
}
