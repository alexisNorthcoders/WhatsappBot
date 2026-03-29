import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve as pathResolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_REPO_ROOT = join(__dirname, '..');

/** @type {{ roots: Set<string>, aliases: Map<string, string> } | null} */
let cachedAllowlist = null;

function parseCompactMap(str) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const s = String(str || '').trim();
  if (!s) return out;
  for (const segment of s.split(',')) {
    const p = segment.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim();
    const val = p.slice(eq + 1).trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || !val) continue;
    out.set(key, val);
  }
  return out;
}

/**
 * @param {string} rawPath
 * @returns {Promise<string>} canonical realpath (directory)
 */
async function canonicalizeConfiguredPath(rawPath) {
  const resolved = pathResolve(rawPath);
  let rp;
  try {
    rp = await fs.realpath(resolved);
  } catch (e) {
    throw new Error(`Path does not exist or is not reachable: ${rawPath} (${e.message || e})`);
  }
  const st = await fs.stat(rp);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${rp}`);
  }
  return rp;
}

async function loadJsonMapFile() {
  const f = process.env.CURSOR_WORKSPACE_MAP_FILE?.trim();
  if (!f) return new Map();
  const resolved = pathResolve(f);
  let raw;
  try {
    raw = await fs.readFile(resolved, 'utf8');
  } catch (e) {
    throw new Error(`CURSOR_WORKSPACE_MAP_FILE: cannot read ${resolved}: ${e.message || e}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`CURSOR_WORKSPACE_MAP_FILE: invalid JSON (${e.message || e})`);
  }
  /** @type {Map<string, string>} */
  const out = new Map();
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.trim() && /^[a-zA-Z0-9_-]+$/.test(k)) {
        out.set(k, v.trim());
      }
    }
  }
  return out;
}

/**
 * Builds allowlisted roots (exact realpaths) and alias → realpath.
 * Always includes the bot checkout root.
 */
export async function getWorkspaceAllowlist() {
  if (cachedAllowlist) return cachedAllowlist;

  const roots = new Set();
  const aliases = new Map();

  const defaultRoot = await canonicalizeConfiguredPath(BOT_REPO_ROOT);
  roots.add(defaultRoot);

  const envMap = parseCompactMap(process.env.CURSOR_WORKSPACE_MAP);
  const fileMap = await loadJsonMapFile();
  const merged = new Map([...envMap, ...fileMap]);

  for (const [alias, raw] of merged) {
    const rp = await canonicalizeConfiguredPath(raw);
    roots.add(rp);
    aliases.set(alias, rp);
  }

  cachedAllowlist = { roots, aliases };
  return cachedAllowlist;
}

/** @param {string} pathStr user-typed absolute path segment */
function rejectParentTraversal(pathStr) {
  if (/\.\.(?:\/|\\)/.test(pathStr) || /\/\.\.$/.test(pathStr) || pathStr === '..') {
    throw new Error('Path must not contain ..');
  }
}

/**
 * @param {string} alias
 * @returns {Promise<string>} workspace root (realpath)
 */
export async function resolveWorkspaceFromAlias(alias) {
  const { aliases } = await getWorkspaceAllowlist();
  const rp = aliases.get(alias);
  if (!rp) {
    const valid = [...aliases.keys()].sort();
    const hint = valid.length ? valid.join(', ') : '(no aliases — set CURSOR_WORKSPACE_MAP)';
    throw new Error(`Unknown workspace alias "${alias}". Valid aliases: ${hint}`);
  }
  return rp;
}

/**
 * @param {string} pathStr absolute path from the user (leading /)
 * @returns {Promise<string>} workspace root (realpath) if allowlisted
 */
export async function resolveWorkspaceFromUserPath(pathStr) {
  rejectParentTraversal(pathStr);
  const resolved = pathResolve(pathStr);
  let rp;
  try {
    rp = await fs.realpath(resolved);
  } catch (e) {
    throw new Error(`Path does not exist or is not reachable: ${pathStr} (${e.message || e})`);
  }
  const st = await fs.stat(rp);
  if (!st.isDirectory()) {
    throw new Error(`Not a directory: ${rp}`);
  }
  const { roots } = await getWorkspaceAllowlist();
  if (!roots.has(rp)) {
    const list = [...roots].sort().join('\n');
    throw new Error(
      `Workspace path is not allowlisted (after resolve/realpath):\n${rp}\n\nAllowlisted roots:\n${list}`
    );
  }
  return rp;
}

/**
 * Default workspace when the user sends no alias/path prefix (existing behavior).
 * @returns {Promise<string>}
 */
export async function getDefaultWorkspaceRoot() {
  await getWorkspaceAllowlist();
  return canonicalizeConfiguredPath(BOT_REPO_ROOT);
}

/** For tests or config reload */
export function clearWorkspaceAllowlistCache() {
  cachedAllowlist = null;
}
