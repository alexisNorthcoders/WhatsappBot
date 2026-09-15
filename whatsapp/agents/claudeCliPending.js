import { promises as fs } from 'fs';
import { join } from 'path';
import { getClaudeCliRepoRoot } from './claudeCliAgent.js';

const FILE = '.pending-claude-run.json';

function pendingPath() {
  return join(getClaudeCliRepoRoot(), 'logs', 'claude-agent', FILE);
}

/**
 * Mark a Claude CLI run in progress so we can notify on WhatsApp after an abrupt exit (e.g. pm2 restart).
 * File always lives under the bot repo; payload includes workspaceRoot for the target repo.
 * @param {{ sender: string, logPath: string, runId: string, startedAt: string, workspaceRoot: string }} data
 */
export async function setPendingClaudeRun(data) {
  const dir = join(getClaudeCliRepoRoot(), 'logs', 'claude-agent');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(pendingPath(), JSON.stringify(data, null, 2), 'utf8');
}

export async function clearPendingClaudeRun() {
  try {
    await fs.unlink(pendingPath());
  } catch {
    /* none */
  }
}

/**
 * @returns {Promise<{ sender: string, logPath: string, runId: string, startedAt: string, workspaceRoot?: string } | null>}
 */
export async function readPendingClaudeRun() {
  try {
    const raw = await fs.readFile(pendingPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
