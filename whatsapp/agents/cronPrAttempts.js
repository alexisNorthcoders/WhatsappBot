import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getClaudeCliRepoRoot } from './claudeCliAgent.js';

const FILE = 'cron-pr-attempts.json';

/**
 * The state of an open agent PR that a cron attempt has already worked on: its head commit and
 * its base branch's tip. The cron retries a PR only once per distinct state, so a PR that stays
 * blocked is not re-run every tick, but gets another go when either side moves.
 * @param {{ headSha: string }} pr
 * @param {string} baseSha
 */
export function prAttemptStateKey(pr, baseSha) {
  return `${pr.headSha}:${baseSha}`;
}

/** @returns {string} absolute path to the persisted state file */
export function cronPrAttemptsPath() {
  const fromEnv = process.env.CRON_PR_ATTEMPTS_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(getClaudeCliRepoRoot(), 'logs', 'claude-agent', FILE);
}

/**
 * @returns {Promise<Map<string, string>>} `owner/name#issue` → state key last attempted
 */
export async function readCronPrAttempts() {
  /** @type {Map<string, string>} */
  const map = new Map();
  let data;
  try {
    data = JSON.parse(await fs.readFile(cronPrAttemptsPath(), 'utf8'));
  } catch {
    return map;
  }
  const byIssue = data?.byIssue;
  if (!byIssue || typeof byIssue !== 'object' || Array.isArray(byIssue)) return map;
  for (const [k, v] of Object.entries(byIssue)) {
    if (typeof v === 'string' && /^[\w.-]+\/[\w.-]+#\d+$/.test(k)) map.set(k, v);
  }
  return map;
}

/**
 * @param {{ repo: string, number: number, stateKey: string }} row
 */
export async function writeCronPrAttempt({ repo, number, stateKey }) {
  const map = await readCronPrAttempts();
  map.set(`${repo}#${number}`, stateKey);
  const path = cronPrAttemptsPath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(
    path,
    JSON.stringify({ byIssue: Object.fromEntries(map), savedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}
