/** Process-wide: only one WhatsApp *summarize* run at a time; TTL avoids stuck *busy*. */

let held = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let watchdogTimer = null;

function ttlMsFromEnv() {
  const n = parseInt(process.env.SUMMARIZE_LOCK_TTL_MS || '600000', 10);
  if (!Number.isFinite(n) || n < 1) return 600_000;
  return Math.min(n, 3_600_000);
}

/**
 * @returns {boolean} whether the summarize lock is currently held
 */
export function isSummarizeLockHeld() {
  return held;
}

/**
 * @returns {boolean} true if this call acquired the lock; false if another summarize is running
 */
export function tryAcquireSummarizeLock() {
  if (held) return false;
  held = true;
  const ttl = ttlMsFromEnv();
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    held = false;
  }, ttl);
  return true;
}

export function releaseSummarizeLock() {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  held = false;
}
