import { spawn } from 'child_process';
import { createWriteStream, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { augmentedPathEnv } from '../processPath.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/** Serialized runs so concurrent WhatsApp messages do not interleave repo edits. */
let runQueue = Promise.resolve();

export function getCursorCliRepoRoot() {
  return REPO_ROOT;
}

/**
 * ENOENT usually means `agent` is not on PATH for this process. Prefer explicit
 * CURSOR_AGENT_BIN, then common install locations, then `agent` on augmented PATH.
 */
function resolveAgentBin() {
  const fromEnv = process.env.CURSOR_AGENT_BIN?.trim();
  if (fromEnv) return fromEnv;

  const home = homedir();
  const candidates = [
    join(home, '.local', 'bin', 'agent'),
    join(home, '.cursor', 'bin', 'agent'),
    '/usr/local/bin/agent',
    '/opt/cursor/bin/agent',
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return 'agent';
}

function getAgentBin() {
  return resolveAgentBin();
}

function getTimeoutMs() {
  const n = parseInt(process.env.CURSOR_AGENT_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function appendCapped(buf, chunk, maxBytes) {
  const next = Buffer.concat([buf, chunk]);
  if (next.length <= maxBytes) return next;
  return next.slice(-maxBytes);
}

/** Prepended so the agent does not kill the parent Node process before the bot can send a completion message. */
function buildPromptForAgent(userPrompt) {
  if (process.env.CURSOR_AGENT_SKIP_CONSTRAINTS === '1') return userPrompt;
  return `[Invocation from WhatsApp bot — read carefully]
Never run shell commands that restart or stop the Node.js process that spawned this CLI (the WhatsApp bot under PM2). Forbidden examples: \`pm2 restart\`, \`pm2 reload\`, \`pm2 delete\` for this app, \`killall node\`, or restarting the unit that runs this bot. The parent waits for this process to exit so it can send a completion message on WhatsApp; restarting the bot aborts that. If the app must be restarted, say so in your summary and let the user run PM2 manually after they read the result.

---

${userPrompt}`;
}

function runCursorCliAgentUnqueued(userPrompt, runId, workspaceRoot) {
  return new Promise((resolve) => {
    const cwd = workspaceRoot;
    const bin = getAgentBin();
    const timeoutMs = getTimeoutMs();
    const logPath = join(workspaceRoot, 'logs', 'cursor-agent', `${runId}.log`);
    const fullPrompt = buildPromptForAgent(userPrompt);

    let logStream = null;
    let timer = null;

    const closeLog = () => {
      if (logStream) {
        try {
          logStream.end();
        } catch {
          /* ignore */
        }
        logStream = null;
      }
    };

    const finish = (payload) => {
      if (timer) clearTimeout(timer);
      if (logStream) {
        try {
          logStream.write(
            `\n--- process end ok=${payload.ok} exit=${payload.exitCode ?? 'n/a'} timedOut=${!!payload.timedOut} ---\n`
          );
        } catch {
          /* ignore */
        }
      }
      closeLog();
      resolve({ ...payload, logPath, runId });
    };

    (async () => {
      try {
        await fs.mkdir(join(workspaceRoot, 'logs', 'cursor-agent'), { recursive: true });
        logStream = createWriteStream(logPath, { flags: 'w' });
        logStream.write(
          `runId=${runId}\ncwd=${cwd}\nbin=${bin}\n--- user prompt ---\n${userPrompt}\n--- (PM2 / parent-process constraints prepended for agent) ---\n\n`
        );
      } catch (e) {
        finish({
          ok: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: `Log init failed: ${e.message}`,
          spawnError: `Log init failed: ${e.message}`,
        });
        return;
      }

      const child = spawn(bin, ['-p', '--force', '--workspace', workspaceRoot, fullPrompt], {
        cwd,
        env: { ...process.env, PATH: augmentedPathEnv() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let outBuf = Buffer.alloc(0);
      let errBuf = Buffer.alloc(0);
      let timedOut = false;

      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 5000).unref();
      }, timeoutMs);

      child.stdout.on('data', (d) => {
        outBuf = appendCapped(outBuf, d, MAX_CAPTURE_BYTES);
        if (logStream) {
          logStream.write('[out] ');
          logStream.write(d);
        }
      });
      child.stderr.on('data', (d) => {
        errBuf = appendCapped(errBuf, d, MAX_CAPTURE_BYTES);
        if (logStream) {
          logStream.write('[err] ');
          logStream.write(d);
        }
      });

      child.on('error', (err) => {
        const hint =
          err.code === 'ENOENT'
            ? `${err.message} — bot PATH has no "agent". In a shell where \`agent\` works, run \`which agent\` and set CURSOR_AGENT_BIN in .env to that full path, then restart the bot.`
            : err.message;
        finish({
          ok: false,
          exitCode: null,
          timedOut: false,
          stdout: '',
          stderr: hint,
          spawnError: hint,
        });
      });

      child.on('close', (code, signal) => {
        const stdout = outBuf.toString('utf8');
        const stderr = errBuf.toString('utf8');
        if (timedOut) {
          finish({
            ok: false,
            exitCode: code,
            timedOut: true,
            stdout,
            stderr,
            signal,
          });
          return;
        }
        finish({
          ok: code === 0,
          exitCode: code,
          timedOut: false,
          stdout,
          stderr,
          signal,
        });
      });
    })();
  });
}

/**
 * Run Cursor headless CLI once (queued). Uses same user env as the bot (CLI login).
 * @param {string} prompt
 * @param {{ runId?: string, workspaceRoot?: string }} [options]
 */
export function runCursorCliAgent(prompt, options = {}) {
  const runId =
    options.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const workspaceRoot = options.workspaceRoot ?? REPO_ROOT;
  const next = runQueue.then(
    () => runCursorCliAgentUnqueued(prompt, runId, workspaceRoot),
    () => runCursorCliAgentUnqueued(prompt, runId, workspaceRoot)
  );
  runQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}
