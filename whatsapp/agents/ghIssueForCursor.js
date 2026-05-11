import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
import { augmentedPathEnv } from '../processPath.js';

const execFileAsync = promisify(execFile);

const DEFAULT_GH_ISSUE_REPO = 'alexisNorthcoders/WhatsappBot';

/** Max `--limit` for `gh issue list` (GitHub caps at 500). Lower via env if GraphQL calls time out (504). */
const GH_ISSUE_LIST_MAX_CAP = 500;

/**
 * @param {string} combinedMessage stderr + message from a failed `gh` invocation
 * @returns {boolean}
 */
export function githubCliErrorLooksTransient(combinedMessage) {
  const m = String(combinedMessage || '').toLowerCase();
  return (
    /\b504\b/.test(m) ||
    /\b502\b/.test(m) ||
    /\b503\b/.test(m) ||
    /\b429\b/.test(m) ||
    m.includes('gateway timeout') ||
    m.includes('bad gateway') ||
    m.includes('service unavailable') ||
    m.includes('econnreset') ||
    m.includes('socket hang up') ||
    m.includes('etimedout') ||
    m.includes('network error') ||
    (m.includes('timeout') && m.includes('http'))
  );
}

function resolveGhIssueListLimit() {
  const raw = process.env.GH_ISSUE_LIST_LIMIT;
  if (raw == null || String(raw).trim() === '') return GH_ISSUE_LIST_MAX_CAP;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return GH_ISSUE_LIST_MAX_CAP;
  return Math.min(GH_ISSUE_LIST_MAX_CAP, n);
}

/**
 * Run `gh` with a few retries when GitHub returns transient gateway / rate-limit errors.
 * @param {string} bin
 * @param {string[]} args
 * @param {import('child_process').ExecFileOptionsWithStringEncoding} execOpts
 */
async function execGhWithRetry(bin, args, execOpts) {
  const backoffMs = [0, 2500, 8000];
  let /** @type {unknown} */ lastErr;
  for (let attempt = 0; attempt < backoffMs.length; attempt++) {
    if (backoffMs[attempt] > 0) {
      await new Promise((r) => setTimeout(r, backoffMs[attempt]));
    }
    try {
      return await execFileAsync(bin, args, execOpts);
    } catch (e) {
      lastErr = e;
      if (e && typeof e === 'object' && /** @type {{ code?: string }} */ (e).code === 'ENOENT') {
        break;
      }
      const stderr = typeof e === 'object' && e && 'stderr' in e && typeof e.stderr === 'string' ? e.stderr : '';
      const msg = `${stderr} ${e instanceof Error ? e.message : String(e)}`;
      if (!githubCliErrorLooksTransient(msg) || attempt === backoffMs.length - 1) {
        break;
      }
    }
  }
  throw lastErr;
}

const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

function parseIssueRepoMap() {
  /** @type {Map<string, string>} */
  const out = new Map();
  const s = String(process.env.CURSOR_ISSUE_REPO_MAP || '').trim();
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

function stripTrailingDotGit(segment) {
  return String(segment || '').replace(/\.git$/i, '');
}

/**
 * @param {string} remoteUrl output of `git remote get-url origin`
 * @returns {string | null} `owner/repo`
 */
export function ownerRepoSlugFromGithubRemote(remoteUrl) {
  const u = String(remoteUrl || '').trim();
  if (!u) return null;
  let m = u.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (m) return `${m[1]}/${stripTrailingDotGit(m[2])}`;
  m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i);
  if (m) return `${m[1]}/${stripTrailingDotGit(m[2])}`;
  return null;
}

async function tryOwnerRepoFromGitOrigin(workspaceRoot) {
  if (!workspaceRoot) return null;
  let stdout;
  try {
    ({ stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: augmentedPathEnv() },
    }));
  } catch {
    return null;
  }
  return ownerRepoSlugFromGithubRemote(stdout.trim());
}

function assertValidRepoSlug(slug, context) {
  if (!REPO_SLUG_RE.test(slug)) {
    throw new Error(
      `${context} must look like owner/repo (got "${slug}")`
    );
  }
  return slug;
}

function resolveGhExecutable() {
  const fromEnv = process.env.GH_BIN?.trim();
  if (fromEnv) return fromEnv;
  const home = homedir();
  const candidates = [join(home, '.local', 'bin', 'gh'), '/usr/bin/gh', '/usr/local/bin/gh'];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return 'gh';
}

/**
 * @returns {string} `owner/repo`
 */
export function resolveIssueRepoSlug() {
  const fromEnv = process.env.GH_ISSUE_REPO?.trim();
  if (fromEnv) {
    return assertValidRepoSlug(fromEnv, 'GH_ISSUE_REPO');
  }
  return DEFAULT_GH_ISSUE_REPO;
}

/**
 * Resolve which GitHub repo to read for `gh issue view`, in order:
 * 1. `CURSOR_ISSUE_REPO_MAP` entry for `workspaceAlias` (when alias is set)
 * 2. `git remote get-url origin` under `workspaceRoot` (GitHub URLs only)
 * 3. `GH_ISSUE_REPO` or default `alexisNorthcoders/WhatsappBot`
 *
 * @param {string | undefined} workspaceRoot
 * @param {string | null | undefined} workspaceAlias allowlisted alias, if any
 * @returns {Promise<string>}
 */
export async function resolveIssueRepoSlugForWorkspace(workspaceRoot, workspaceAlias) {
  const map = parseIssueRepoMap();
  const alias = workspaceAlias?.trim() || null;
  if (alias && map.has(alias)) {
    const v = map.get(alias).trim();
    return assertValidRepoSlug(v, `CURSOR_ISSUE_REPO_MAP entry for "${alias}"`);
  }

  const fromGit = await tryOwnerRepoFromGitOrigin(workspaceRoot);
  if (fromGit && REPO_SLUG_RE.test(fromGit)) return fromGit;

  return resolveIssueRepoSlug();
}

/**
 * @param {number|string} issueNumber
 * @param {{
 *   extraInstructions?: string,
 *   repo?: string,
 *   workspaceRoot?: string,
 *   workspaceAlias?: string | null,
 * }} [opts]
 * @returns {Promise<{ markdown: string, repo: string, number: number, title: string }>}
 */
export async function fetchGhIssuePromptText(issueNumber, opts = {}) {
  const n = parseInt(String(issueNumber), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }
  let repo;
  const explicit = (opts.repo || '').trim();
  if (explicit) {
    repo = assertValidRepoSlug(explicit, 'repo override');
  } else {
    repo = await resolveIssueRepoSlugForWorkspace(opts.workspaceRoot, opts.workspaceAlias ?? null);
  }
  const extra = (opts.extraInstructions || '').trim();
  const bin = resolveGhExecutable();

  const args = [
    'issue',
    'view',
    String(n),
    '--repo',
    repo,
    '--json',
    'title,body,number,state,url,labels',
  ];

  let stdout;
  try {
    ({ stdout } = await execGhWithRetry(bin, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: augmentedPathEnv() },
    }));
  } catch (e) {
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    const hint =
      e.code === 'ENOENT'
        ? `Executable not found (${bin}). Install GitHub CLI or set GH_BIN to the full path to gh.`
        : stderr || e.message || String(e);
    throw new Error(hint);
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch (parseErr) {
    throw new Error(`gh returned invalid JSON: ${parseErr.message}`);
  }

  const title = data.title ?? '';
  const body = (data.body || '').trim();
  const state = data.state ?? '';
  const url = data.url ?? '';
  const labels = Array.isArray(data.labels)
    ? data.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
    : [];

  const lines = [];
  lines.push(`# GitHub issue #${data.number ?? n}`);
  lines.push('');
  lines.push(`**Repository:** ${repo}`);
  lines.push(`**URL:** ${url}`);
  lines.push(`**State:** ${state}`);
  if (labels.length) lines.push(`**Labels:** ${labels.join(', ')}`);
  lines.push(`**Title:** ${title}`);
  lines.push('');
  lines.push('## Body');
  lines.push(body || '_(empty)_');
  if (extra) {
    lines.push('');
    lines.push('## Additional instructions (from WhatsApp)');
    lines.push(extra);
  }

  return {
    markdown: lines.join('\n'),
    repo,
    number: typeof data.number === 'number' ? data.number : n,
    title,
  };
}

/**
 * Open issues in the given repo (GitHub), via `gh issue list`.
 * @param {{ repo?: string }} [opts]
 * @returns {Promise<{ number: number, title: string }[]>}
 */
export async function listOpenGithubIssues(opts = {}) {
  const repo = opts.repo?.trim()
    ? assertValidRepoSlug(opts.repo, 'repo')
    : resolveIssueRepoSlug();
  const bin = resolveGhExecutable();
  const limit = resolveGhIssueListLimit();
  const args = [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--json',
    'number,title',
    '--limit',
    String(limit),
  ];
  let stdout;
  try {
    ({ stdout } = await execGhWithRetry(bin, args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PATH: augmentedPathEnv() },
    }));
  } catch (e) {
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    const hint =
      e.code === 'ENOENT'
        ? `Executable not found (${bin}). Install GitHub CLI or set GH_BIN to the full path to gh.`
        : stderr || e.message || String(e);
    throw new Error(hint);
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (parseErr) {
    throw new Error(`gh issue list returned invalid JSON: ${parseErr.message}`);
  }
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => ({
      number: typeof row.number === 'number' ? row.number : parseInt(String(row.number), 10),
      title: String(row.title ?? ''),
    }))
    .filter((row) => Number.isFinite(row.number) && row.number > 0);
}
