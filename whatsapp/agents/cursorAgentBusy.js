/** Process-wide: only one manual WhatsApp `cursor` agent run at a time. */

let busy = false;

/**
 * @returns {boolean} true if this call holds the lock; false if another run is in progress
 */
export function tryAcquireAgentBusyLock() {
  if (busy) return false;
  busy = true;
  return true;
}

export function releaseAgentBusyLock() {
  busy = false;
}
