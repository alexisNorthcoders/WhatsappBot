import { resolveGeneratedPngBasename } from './spriteLastPath.ts';

const TTL_MS = parseInt(process.env.SDXL_LAST_PATH_TTL_MS || String(24 * 60 * 60 * 1000), 10);

const store: Map<string, { path: string; at: number }> = new Map();

/**
 * @param absPath absolute path written under assets/generated
 */
export function setLastSdxlPath(jid: string, absPath: string) {
  if (!jid || !absPath) return;
  store.set(jid, { path: absPath, at: Date.now() });
}

/**
 * @returns absolute path or null if missing / expired
 */
export function getLastSdxlPath(jid: string): string | null {
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
 * @param basename e.g. 2026-03-23T00-08-06-174Z_sdxl_1024x1024_foo.png
 * @returns absolute path
 */
export async function resolveSdxlGeneratedPngBasename(basename: string): Promise<string> {
  return resolveGeneratedPngBasename(basename);
}
