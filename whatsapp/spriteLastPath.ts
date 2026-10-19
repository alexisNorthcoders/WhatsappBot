import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, '..', 'assets', 'generated');

const TTL_MS = parseInt(process.env.SPRITE_LAST_PATH_TTL_MS || String(24 * 60 * 60 * 1000), 10);

const store: Map<string, { path: string; at: number }> = new Map();

/** Basenames only: timestamp-style PNGs from saveGeneratedImage. */
const SAFE_BASENAME = /^[a-zA-Z0-9._-]+\.png$/;

/**
 * @param absPath absolute path written under assets/generated
 */
export function setLastSpritePath(jid: string, absPath: string) {
  if (!jid || !absPath) return;
  store.set(jid, { path: absPath, at: Date.now() });
}

/**
 * @returns absolute path or null if missing / expired
 */
export function getLastSpritePath(jid: string): string | null {
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
 * Resolve a user-supplied basename to a real file under assets/generated.
 * @param basename e.g. 2026-03-23T00-08-06-174Z_sprite_32x32_foo.png
 * @returns absolute path
 */
export async function resolveGeneratedPngBasename(basename: string): Promise<string> {
  const base = String(basename || '').trim();
  if (!SAFE_BASENAME.test(base) || base.includes('..') || path.basename(base) !== base) {
    throw new Error('Invalid filename');
  }
  const full = path.join(GENERATED_DIR, base);
  let resolvedFile;
  let resolvedDir;
  try {
    resolvedFile = await fs.realpath(full);
    resolvedDir = await fs.realpath(GENERATED_DIR);
  } catch {
    throw new Error('File not found');
  }
  const sep = path.sep;
  if (!resolvedFile.startsWith(resolvedDir + sep) && resolvedFile !== resolvedDir) {
    throw new Error('Invalid path');
  }
  try {
    await fs.access(resolvedFile);
  } catch {
    throw new Error('File not found');
  }
  return resolvedFile;
}
