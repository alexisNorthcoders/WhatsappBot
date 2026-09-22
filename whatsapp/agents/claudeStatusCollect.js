import {
  getTelemetryDir,
  readActiveRuns,
  readCronState,
  readRunHistory,
  pidAlive,
} from './claudeRunTelemetry.js';
import { getAgentPauseForWorkspace } from './claudeAgentPause.js';
import { getWorkspaceAllowlist } from '../claudeWorkspaces.js';

const PAUSE_LOOKUP_TIMEOUT_MS = 1500;

/** Pause flags live in Redis; a down Redis must not make the dashboard hang or fail. Resolves to `null` when unknown. */
export async function readPauses() {
  const lookup = (async () => {
    const { roots } = await getWorkspaceAllowlist();
    const found = [];
    for (const workspaceRoot of roots) {
      const state = await getAgentPauseForWorkspace({ workspaceRoot });
      if (state) found.push({ workspaceRoot, ...state });
    }
    return found;
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PAUSE_LOOKUP_TIMEOUT_MS));
  try {
    return await Promise.race([lookup, timeout]);
  } catch {
    return null;
  }
}

/**
 * Snapshot shared by the terminal `claude:status` and the WhatsApp `claude:status` command.
 * Readers are injectable for tests.
 */
export async function collectStatus(deps = {}) {
  const dir = deps.dir ?? getTelemetryDir();
  const now = deps.now ?? Date.now;
  const [cron, active, history, pauses] = await Promise.all([
    (deps.readCronState ?? readCronState)({ dir }),
    (deps.readActiveRuns ?? readActiveRuns)({ dir }),
    (deps.readRunHistory ?? readRunHistory)({ dir, sinceMs: now() - 7 * 864e5 }),
    (deps.readPauses ?? readPauses)(),
  ]);
  const alive = deps.pidAlive ?? pidAlive;
  return { now: now(), cron, cronAlive: cron ? alive(cron.pid) : false, active, history, pauses };
}
