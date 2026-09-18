import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * File-based observability for Claude CLI agent runs and cron cycles. The bot process writes;
 * the `agentctl.js` terminal CLI (a separate process) reads. Everything lives under the bot
 * repo's `logs/claude-agent/` regardless of which workspace a run targets, so one place shows all.
 *
 *   active/<runId>.json   one file per in-flight run, rewritten as it progresses, removed at exit
 *   runs.jsonl            append-only history, one line per finished run
 *   cron-state.json       last cron tick outcome + interval
 *
 * Telemetry must never break a run: every write swallows its own errors.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(__dirname, '..', '..', 'logs', 'claude-agent');
const UPDATE_THROTTLE_MS = 1500;

export function getTelemetryDir() {
  return DEFAULT_DIR;
}

async function writeJsonAtomic(path, data) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
  await fs.rename(tmp, path);
}

/**
 * @typedef {{
 *   trigger?: 'cron' | 'manual' | string,
 *   kind?: 'issue' | 'freeform' | 'autofix' | string,
 *   repo?: string | null,
 *   issueNumber?: number | null,
 * }} RunMeta
 */

/**
 * Tracks one agent process: publishes live state while it runs, then a history record.
 * @param {{ runId: string, workspaceRoot: string, logPath: string, meta?: RunMeta, dir?: string, now?: () => number }} p
 */
export function createRunTracker({ runId, workspaceRoot, logPath, meta = {}, dir = DEFAULT_DIR, now = Date.now }) {
  const activePath = join(dir, 'active', `${runId}.json`);
  const startedAt = new Date(now()).toISOString();
  let childPid = null;
  let lastWrite = 0;
  let pendingSnap = null;
  let trailingTimer = null;
  let chain = Promise.resolve();

  const enqueue = (fn) => {
    chain = chain.then(fn).catch(() => {});
    return chain;
  };

  const record = (snap) => ({
    runId,
    ownerPid: process.pid,
    pid: childPid,
    workspaceRoot,
    logPath,
    trigger: meta.trigger ?? null,
    kind: meta.kind ?? 'freeform',
    repo: meta.repo ?? null,
    issueNumber: meta.issueNumber ?? null,
    startedAt,
    updatedAt: new Date(now()).toISOString(),
    model: snap?.model ?? null,
    turns: snap?.turns ?? 0,
    outputTokens: snap?.outputTokens ?? 0,
    contextTokens: snap?.contextTokens ?? 0,
    lastActivity: snap?.lastActivity ?? null,
    rateLimits: snap?.rateLimits ?? null,
  });

  return {
    /** Publish the run as active (call right after spawn). */
    start(pid) {
      childPid = pid ?? null;
      lastWrite = now();
      return enqueue(() => writeJsonAtomic(activePath, record(null)));
    },
    /** Throttled live update; a write skipped by the throttle is flushed shortly after (trailing edge). */
    update(snap) {
      pendingSnap = snap;
      const wait = UPDATE_THROTTLE_MS - (now() - lastWrite);
      if (wait > 0) {
        if (!trailingTimer) {
          trailingTimer = setTimeout(() => {
            trailingTimer = null;
            void this.update(pendingSnap);
          }, wait);
          trailingTimer.unref();
        }
        return chain;
      }
      lastWrite = now();
      return enqueue(() => writeJsonAtomic(activePath, record(snap)));
    },
    /**
     * Append the history record and remove the active file.
     * @param {{ outcome: string, exitCode: number | null, snapshot: import('./claudeStreamParser.js').StreamSnapshot }} r
     */
    finish({ outcome, exitCode, snapshot }) {
      if (trailingTimer) clearTimeout(trailingTimer);
      trailingTimer = null;
      const res = snapshot?.result;
      const endedAt = new Date(now());
      const entry = {
        runId,
        startedAt,
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - new Date(startedAt).getTime(),
        workspaceRoot,
        logPath,
        trigger: meta.trigger ?? null,
        kind: meta.kind ?? 'freeform',
        repo: meta.repo ?? null,
        issueNumber: meta.issueNumber ?? null,
        outcome,
        exitCode,
        model: snapshot?.model ?? null,
        sessionId: snapshot?.sessionId ?? null,
        turns: res?.turns ?? snapshot?.turns ?? 0,
        costUsd: res?.costUsd ?? null,
        tokens: res?.tokens ?? {
          input: snapshot?.contextTokens ?? 0,
          output: snapshot?.outputTokens ?? 0,
          cacheRead: 0,
          cacheCreate: 0,
        },
        rateLimits: snapshot?.rateLimits ?? null,
      };
      return enqueue(async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.appendFile(join(dir, 'runs.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
        await fs.unlink(activePath).catch(() => {});
      });
    },
  };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * In-flight runs. `health` distinguishes a normal run from the scary cases:
 *  - `running`  bot process and agent process both alive
 *  - `orphaned` bot died but the agent process is still running (nobody will report its result)
 *  - `stale`    both gone; the active file is a leftover from a crash
 * @param {{ dir?: string, isAlive?: (pid: number) => boolean }} [opts]
 */
export async function readActiveRuns({ dir = DEFAULT_DIR, isAlive = pidAlive } = {}) {
  let names;
  try {
    names = await fs.readdir(join(dir, 'active'));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const run = JSON.parse(await fs.readFile(join(dir, 'active', name), 'utf8'));
      const ownerUp = isAlive(run.ownerPid);
      const childUp = isAlive(run.pid);
      runs.push({ ...run, health: ownerUp ? 'running' : childUp ? 'orphaned' : 'stale' });
    } catch {
      /* mid-write or corrupt: skip */
    }
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Finished runs, newest first.
 * @param {{ dir?: string, limit?: number, sinceMs?: number }} [opts]
 */
export async function readRunHistory({ dir = DEFAULT_DIR, limit = Infinity, sinceMs } = {}) {
  let raw;
  try {
    raw = await fs.readFile(join(dir, 'runs.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip torn line */
    }
  }
  rows.reverse();
  const filtered = sinceMs == null ? rows : rows.filter((r) => new Date(r.endedAt).getTime() >= sinceMs);
  return filtered.slice(0, limit);
}

/**
 * @typedef {{
 *   kind: 'busy' | 'no_socket' | 'no_eligible' | 'ran' | 'error',
 *   repo?: string, issue?: number,
 *   result?: 'progress' | 'no_progress' | 'prep_failed' | 'failed',
 *   note?: string,
 *   pausedWorkspaces?: string[],
 * }} CronTickOutcome
 */

/**
 * Record a finished cron tick (`intervalMs` lets the CLI compute the next tick).
 * @param {{ outcome: CronTickOutcome, intervalMs: number, startedAt: number, dir?: string, now?: () => number }} p
 */
export async function writeCronTick({ outcome, intervalMs, startedAt, dir = DEFAULT_DIR, now = Date.now }) {
  try {
    await writeJsonAtomic(join(dir, 'cron-state.json'), {
      pid: process.pid,
      intervalMs,
      lastTickStartedAt: new Date(startedAt).toISOString(),
      lastTickEndedAt: new Date(now()).toISOString(),
      outcome,
    });
  } catch {
    /* telemetry only */
  }
}

/** Mark cron as enabled before its first tick finishes (so the CLI can tell "starting" from "off"). */
export async function writeCronStarted({ intervalMs, dir = DEFAULT_DIR, now = Date.now }) {
  try {
    await writeJsonAtomic(join(dir, 'cron-state.json'), {
      pid: process.pid,
      intervalMs,
      startedAt: new Date(now()).toISOString(),
      lastTickStartedAt: null,
      lastTickEndedAt: null,
      outcome: null,
    });
  } catch {
    /* telemetry only */
  }
}

export async function readCronState({ dir = DEFAULT_DIR } = {}) {
  try {
    return JSON.parse(await fs.readFile(join(dir, 'cron-state.json'), 'utf8'));
  } catch {
    return null;
  }
}

export { pidAlive };
