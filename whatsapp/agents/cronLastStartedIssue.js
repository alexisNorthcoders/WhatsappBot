import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getCursorCliRepoRoot } from './cursorCliAgent.js';

const FILE = 'cron-last-started-issue.json';

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
 * @returns {Promise<{ repo: string, number: number, savedAt: string } | null>}
 */
export async function readCronLastStartedIssue() {
  const path = cronLastStartedIssuePath();
  try {
    const raw = await fs.readFile(path, 'utf8');
    const data = JSON.parse(raw);
    if (
      !data ||
      typeof data.repo !== 'string' ||
      !Number.isFinite(data.number) ||
      data.number < 1
    ) {
      return null;
    }
    return {
      repo: data.repo,
      number: data.number,
      savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * @param {{ repo: string, number: number }} row
 */
export async function writeCronLastStartedIssue(row) {
  const path = cronLastStartedIssuePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const payload = {
    repo: row.repo,
    number: row.number,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(path, JSON.stringify(payload, null, 2), 'utf8');
}
