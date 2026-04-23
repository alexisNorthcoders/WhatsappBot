import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
import { augmentedPathEnv } from '../processPath.js';

const execFileAsync = promisify(execFile);

const DEFAULT_GH_ISSUE_REPO = 'alexisNorthcoders/WhatsappBot';

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
    ({ stdout } = await execFileAsync(bin, args, {
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

const GH_ISSUE_LIST_MAX = 500;

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
    String(GH_ISSUE_LIST_MAX),
  ];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(bin, args, {
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
