import { promises as fs } from 'fs';
import { join } from 'path';
import { getCursorCliRepoRoot } from './cursorCliAgent.js';

const FILE = '.pending-cursor-run.json';

function pendingPath() {
  return join(getCursorCliRepoRoot(), 'logs', 'cursor-agent', FILE);
}

/**
 * Mark a Cursor CLI run in progress so we can notify on WhatsApp after an abrupt exit (e.g. pm2 restart).
 * File always lives under the bot repo; payload includes workspaceRoot for the target repo.
 * @param {{ sender: string, logPath: string, runId: string, startedAt: string, workspaceRoot: string }} data
 */
export async function setPendingCursorRun(data) {
  const dir = join(getCursorCliRepoRoot(), 'logs', 'cursor-agent');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(pendingPath(), JSON.stringify(data, null, 2), 'utf8');
}

export async function clearPendingCursorRun() {
  try {
    await fs.unlink(pendingPath());
  } catch {
    /* none */
  }
}

/**
 * @returns {Promise<{ sender: string, logPath: string, runId: string, startedAt: string, workspaceRoot?: string } | null>}
 */
export async function readPendingCursorRun() {
  try {
    const raw = await fs.readFile(pendingPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
