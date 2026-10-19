import NodeCache from '@cacheable/node-cache';

const MSG_RETRY_TTL_SECONDS = 60 * 60;

/**
 * Decryption retry counts, keyed by message id. Create once per process and reuse across
 * reconnects — Baileys' built-in default is per-socket, so counts would reset on every reconnect
 * and `maxMsgRetryCount` would never be reached.
 */
export function createMsgRetryCounterCache() {
  return new NodeCache({ stdTTL: MSG_RETRY_TTL_SECONDS, useClones: false });
}

/**
 * Cache-related `makeWASocket` options. Deliberately no `userDevicesCache`: Baileys' default
 * TTL cache refreshes a contact's device list, so newly linked devices can decrypt our messages.
 * @param {NodeCache} msgRetryCounterCache
 */
export function socketCacheOptions(msgRetryCounterCache) {
  return {
    maxMsgRetryCount: 3,
    msgRetryCounterCache,
  };
}
