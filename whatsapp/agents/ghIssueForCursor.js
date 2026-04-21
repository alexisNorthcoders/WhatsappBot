import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { homedir } from 'os';
import { join } from 'path';
import { augmentedPathEnv } from '../processPath.js';

const execFileAsync = promisify(execFile);

const DEFAULT_GH_ISSUE_REPO = 'alexisNorthcoders/WhatsappBot';

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
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(fromEnv)) {
      throw new Error(`GH_ISSUE_REPO must look like owner/repo (got "${fromEnv}")`);
    }
    return fromEnv;
  }
  return DEFAULT_GH_ISSUE_REPO;
}

/**
 * @param {number|string} issueNumber
 * @param {{ extraInstructions?: string }} [opts]
 * @returns {Promise<{ markdown: string, repo: string, number: number, title: string }>}
 */
export async function fetchGhIssuePromptText(issueNumber, opts = {}) {
  const n = parseInt(String(issueNumber), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`Invalid issue number: ${issueNumber}`);
  }
  const repo = resolveIssueRepoSlug();
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
