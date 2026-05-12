import { resolveGeneratedPngBasename } from './spriteLastPath.js';

const TTL_MS = parseInt(process.env.SDXL_LAST_PATH_TTL_MS || String(24 * 60 * 60 * 1000), 10);

/** @type {Map<string, { path: string, at: number }>} */
const store = new Map();

/**
 * @param {string} jid
 * @param {string} absPath absolute path written under assets/generated
 */
export function setLastSdxlPath(jid, absPath) {
  if (!jid || !absPath) return;
  store.set(jid, { path: absPath, at: Date.now() });
}

/**
 * @param {string} jid
 * @returns {string | null} absolute path or null if missing / expired
 */
export function getLastSdxlPath(jid) {
  if (!jid) return null;
  const row = store.get(jid);
  if (!row) return null;
  if (Date.now() - row.at > TTL_MS) {
    store.delete(jid);
    return null;
  }
  return row.path;
}

/**
 * Resolve a user-supplied basename to a real file under assets/generated (branch from an older step).
 * @param {string} basename e.g. 2026-03-23T00-08-06-174Z_sdxl_1024x1024_foo.png
 * @returns {Promise<string>} absolute path
 */
export async function resolveSdxlGeneratedPngBasename(basename) {
  return resolveGeneratedPngBasename(basename);
}
