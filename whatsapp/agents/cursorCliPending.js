import { promises as fs } from 'fs';
import { join } from 'path';

const FILE = '.pending-cursor-run.json';

function pendingPath(repoRoot) {
  return join(repoRoot, 'logs', 'cursor-agent', FILE);
}

/**
 * Mark a Cursor CLI run in progress so we can notify on WhatsApp after an abrupt exit (e.g. pm2 restart).
 */
export async function setPendingCursorRun(repoRoot, data) {
  const dir = join(repoRoot, 'logs', 'cursor-agent');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(pendingPath(repoRoot), JSON.stringify(data, null, 2), 'utf8');
}

export async function clearPendingCursorRun(repoRoot) {
  try {
    await fs.unlink(pendingPath(repoRoot));
  } catch {
    /* none */
  }
}

/**
 * @returns {Promise<{ sender: string, logPath: string, runId: string, startedAt: string } | null>}
 */
export async function readPendingCursorRun(repoRoot) {
  try {
    const raw = await fs.readFile(pendingPath(repoRoot), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
