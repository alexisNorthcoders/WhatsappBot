import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getCursorCliRepoRoot } from './cursorCliAgent.js';

const FILE = 'cron-last-started-issue.json';

const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/**
 * @returns {string} absolute path to the persisted state file
 */
export function cronLastStartedIssuePath() {
  const fromEnv = process.env.CRON_LAST_STARTED_ISSUE_FILE?.trim();
  if (fromEnv) return fromEnv;
  return join(
    getCursorCliRepoRoot(),
    'logs',
    'cursor-agent',
    FILE
  );
}

/**
 * Migrated from a single { repo, number } record to per-repo entries so the cron runner can
 * track last-started for WhatsappBot and secondary repos (e.g. Platformer) independently.
 *
 * @returns {Promise<Map<string, number>>} repo slug → last started issue number
 */
export async function readCronPerRepoLastStarted() {
  const path = cronLastStartedIssuePath();
  /** @type {Map<string, number>} */
  const map = new Map();
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return map;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!data || typeof data !== 'object') {
    return map;
  }
  if (data.perRepo && typeof data.perRepo === 'object' && !Array.isArray(data.perRepo)) {
    for (const [k, v] of Object.entries(data.perRepo)) {
      if (typeof k !== 'string' || !REPO_SLUG_RE.test(k)) continue;
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      if (Number.isFinite(n) && n >= 1) {
        map.set(k, n);
      }
    }
  }
  if (
    typeof data.repo === 'string' &&
    REPO_SLUG_RE.test(data.repo) &&
    Number.isFinite(data.number) &&
    data.number >= 1
  ) {
    if (!map.has(data.repo)) {
      map.set(data.repo, data.number);
    }
  }
  return map;
}

/**
 * Merges one repo’s last-started issue into the persisted file (new per-repo format).
 * @param {{ repo: string, number: number }} row
 */
export async function writeCronPerRepoLastStartedEntry(row) {
  const path = cronLastStartedIssuePath();
  const map = await readCronPerRepoLastStarted();
  map.set(row.repo, row.number);
  const perRepo = Object.fromEntries(
    [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  );
  const payload = {
    perRepo,
    savedAt: new Date().toISOString(),
  };
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
}
