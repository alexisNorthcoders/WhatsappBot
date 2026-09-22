#!/usr/bin/env node
import 'dotenv/config';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { getTelemetryDir, readActiveRuns, readRunHistory } from './whatsapp/agents/claudeRunTelemetry.js';
import { collectStatus } from './whatsapp/agents/claudeStatusCollect.js';
import { ansi, plain, renderStatus, renderHistoryLines } from './whatsapp/agents/claudeAgentCliFormat.js';

const c = process.stdout.isTTY && !process.env.NO_COLOR ? ansi() : plain;

function printUsage() {
  console.log(`claudeAgentCli.js — observability for the Claude CLI agent and its cron cycles (think "pm2 status")

Usage:
  node claudeAgentCli.js [status] [--json]      snapshot: cron, running agents, pauses, spend, recent runs
  node claudeAgentCli.js watch [seconds]        live view, refreshed every N seconds (default 2)
  node claudeAgentCli.js history [-n 20] [--json]   finished runs with model, tokens, cost
  node claudeAgentCli.js logs [runId|latest] [-f]   print (or follow) an agent run log

Also available as: npm run claude:status | claude:watch | claude:history | claude:logs`);
}

const collect = () => collectStatus();

async function status({ json }) {
  const data = await collect();
  console.log(json ? JSON.stringify(data, null, 2) : renderStatus(data, c));
}

async function watch(seconds) {
  const intervalMs = Math.max(1, seconds) * 1000;
  for (;;) {
    const frame = renderStatus(await collect(), c);
    process.stdout.write(`\x1b[2J\x1b[H${frame}\n\n${c.dim(`refreshing every ${intervalMs / 1000}s — ctrl+c to exit`)}\n`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function history(args) {
  const nIdx = args.indexOf('-n');
  const limit = nIdx !== -1 ? parseInt(args[nIdx + 1], 10) || 20 : 20;
  const rows = await readRunHistory({ dir: getTelemetryDir(), limit });
  if (args.includes('--json')) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('No finished runs recorded yet.');
  console.log(renderHistoryLines(rows, Date.now(), c).join('\n'));
}

async function logs(args) {
  const follow = args.includes('-f');
  const target = args.find((a) => !a.startsWith('-')) ?? 'latest';
  // Logs live in each run's own workspace, so resolve the path from telemetry rather than a directory scan.
  const dir = getTelemetryDir();
  const runs = [...(await readActiveRuns({ dir })).reverse(), ...(await readRunHistory({ dir }))];
  const run = target === 'latest' ? runs[0] : runs.find((r) => r.runId === target || r.runId.startsWith(target));
  if (!run?.logPath) throw new Error(target === 'latest' ? 'No runs recorded yet.' : `No run matching "${target}".`);
  await fs.access(run.logPath);
  console.error(c.dim(run.logPath));
  if (!follow) return process.stdout.write(await fs.readFile(run.logPath, 'utf8'));
  const tail = spawn('tail', ['-n', '+1', '-f', run.logPath], { stdio: 'inherit' });
  await new Promise((resolve) => tail.on('close', resolve));
}

async function main() {
  const [, , cmd = 'status', ...rest] = process.argv;
  switch (cmd) {
    case 'status':
      return status({ json: rest.includes('--json') });
    case 'watch':
      return watch(parseFloat(rest[0]) || 2);
    case 'history':
      return history(rest);
    case 'logs':
      return logs(rest);
    case '-h':
    case '--help':
    case 'help':
      return printUsage();
    default:
      console.error(`Unknown command "${cmd}".\n`);
      printUsage();
      process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e?.message || String(e));
    process.exitCode = 1;
  })
  // The pause lookup opens a Redis client that would otherwise keep a one-shot command alive.
  .finally(() => {
    if (process.argv[2] !== 'watch') process.exit(process.exitCode ?? 0);
  });
