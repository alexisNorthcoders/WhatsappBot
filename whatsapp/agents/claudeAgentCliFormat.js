import { basename } from 'path';

/**
 * Pure text rendering for the `claudeAgentCli.js` terminal CLI (no I/O, no dependencies).
 * `c` is a colorizer ({ dim, green, red, yellow, bold, cyan }) so tests can pass identity functions.
 */

export const plain = { dim: (s) => s, green: (s) => s, red: (s) => s, yellow: (s) => s, bold: (s) => s, cyan: (s) => s };

export function ansi() {
  const wrap = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
  return { dim: wrap(2), green: wrap(32), red: wrap(31), yellow: wrap(33), bold: wrap(1), cyan: wrap(36) };
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function formatTokens(n) {
  if (n == null) return '-';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function formatCost(usd) {
  return usd == null ? '-' : `$${usd.toFixed(usd < 10 ? 2 : 1)}`;
}

/** `claude-haiku-4-5-20251001` → `haiku-4-5` */
export function shortModel(model) {
  if (!model) return '-';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function totalTokens(t) {
  return t ? (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreate || 0) : 0;
}

function pct(v) {
  return v == null ? '?' : `${Math.round(v * 100)}%`;
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

/** Left-aligned columns sized to their widest cell; `rows` are arrays of strings (uncolored). */
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((cell, i) => pad(cell ?? '', widths[i])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)];
}

/**
 * pm2-style boxed table. `rows` are arrays of plain strings; `colorRow(i)` optionally wraps a whole
 * row's text (after padding, so widths stay correct).
 * @returns {string[]}
 */
export function boxTable(headers, rows, c = plain, colorRow = () => (s) => s) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const rule = (l, m, r) => c.dim(`${l}${widths.map((w) => '─'.repeat(w + 2)).join(m)}${r}`);
  const cells = (row) => row.map((cell, i) => ` ${pad(cell ?? '', widths[i])} `);
  const bar = c.dim('│');
  const line = (row, wrap = (x) => x) => `${bar}${cells(row).map(wrap).join(bar)}${bar}`;
  return [
    rule('┌', '┬', '┐'),
    line(headers, c.bold),
    rule('├', '┼', '┤'),
    ...rows.map((r, i) => line(r, colorRow(i))),
    rule('└', '┴', '┘'),
  ];
}

function repoLabel(run) {
  return run.repo ?? basename(run.workspaceRoot);
}

function issueLabel(run) {
  if (run.issueNumber != null) return `#${run.issueNumber}`;
  return run.kind === 'autofix' ? 'autofix' : run.kind === 'freeform' ? 'freeform' : '-';
}

function describeOutcome(o) {
  if (!o) return 'starting (no tick finished yet)';
  switch (o.kind) {
    case 'busy':
      return 'skipped — an agent was already running';
    case 'no_socket':
      return `skipped — WhatsApp not connected${o.note ? ` (${o.note})` : ''}`;
    case 'no_eligible': {
      const paused = o.pausedWorkspaces?.length ? ` (paused: ${o.pausedWorkspaces.map((p) => basename(p)).join(', ')})` : '';
      return `idle — no eligible issue${paused}`;
    }
    case 'ran': {
      const label = { progress: 'made progress', no_progress: 'no lasting progress', prep_failed: 'git prep failed', failed: 'failed' }[o.result] ?? o.result;
      return `worked ${o.repo}#${o.issue} — ${label}${o.note ? ` (${o.note})` : ''}`;
    }
    case 'error':
      return `error — ${o.note ?? 'unknown'}`;
    default:
      return o.kind;
  }
}

/**
 * @param {{
 *   now: number,
 *   cron: null | { pid: number, intervalMs: number, lastTickStartedAt: string | null, lastTickEndedAt: string | null, outcome: object | null },
 *   cronAlive: boolean,
 *   active: object[],
 *   history: object[],
 *   pauses: { workspaceRoot: string, reason: string, ttlRemainingSeconds: number | null }[] | null,
 * }} d
 * @param {typeof plain} c
 */
export function renderStatus(d, c = plain) {
  const out = [];
  const stamp = new Date(d.now).toISOString().replace('T', ' ').slice(0, 19);
  out.push(`${c.bold('WhatsappBot agents')}  ${c.dim(stamp + ' UTC')}`);
  out.push('');

  // --- cron ---
  if (!d.cron) {
    out.push(`${c.bold('CRON')}    ${c.dim('○ no state file — cron disabled or the bot has not started yet')}`);
  } else {
    const dot = d.cronAlive ? c.green('●') : c.red('●');
    const every = formatDuration(d.cron.intervalMs);
    const health = d.cronAlive ? `bot pid ${d.cron.pid}` : c.red(`bot pid ${d.cron.pid} NOT running`);
    out.push(`${c.bold('CRON')}    ${dot} every ${every} · ${health}`);
    if (d.cron.lastTickEndedAt) {
      const ended = new Date(d.cron.lastTickEndedAt).getTime();
      const next = d.cron.lastTickStartedAt ? new Date(d.cron.lastTickStartedAt).getTime() + d.cron.intervalMs : null;
      const nextIn = next == null ? '' : next > d.now ? ` · next tick in ~${formatDuration(next - d.now)}` : ' · next tick due';
      out.push(`         last tick ${formatDuration(d.now - ended)} ago: ${describeOutcome(d.cron.outcome)}${d.cronAlive ? nextIn : ''}`);
    } else {
      out.push(`         ${describeOutcome(null)}`);
    }
  }
  out.push('');

  // --- active agents ---
  const bad = d.active.filter((r) => r.health !== 'running').length;
  out.push(
    `${c.bold('AGENTS')}  ${d.active.length === 0 ? c.dim('none running') : c.green(`${d.active.length} running`)}${bad ? c.red(`  (${bad} need attention)`) : ''}`
  );
  if (d.active.length) {
    const rows = d.active.map((r) => [
      repoLabel(r),
      issueLabel(r),
      r.trigger ?? '-',
      shortModel(r.model),
      formatDuration(d.now - new Date(r.startedAt).getTime()),
      String(r.turns ?? 0),
      formatTokens(r.outputTokens),
      formatTokens(r.contextTokens),
      String(r.pid ?? '-'),
      r.health,
    ]);
    const healthColor = (i) => (d.active[i].health === 'running' ? c.green : c.red);
    out.push(...boxTable(['repo', 'issue', 'trigger', 'model', 'elapsed', 'turns', 'out', 'ctx', 'pid', 'state'], rows, c, healthColor));
    for (const r of d.active) {
      if (r.health === 'orphaned') out.push(c.red(`  ${r.issueNumber != null ? '#' + r.issueNumber : r.runId}: bot process died but agent pid ${r.pid} is still running — nothing will report its result`));
      else if (r.health === 'stale') out.push(c.yellow(`  ${r.runId}: leftover from a crash (no live process); remove logs/claude-agent/active/${r.runId}.json`));
      else if (r.lastActivity) out.push(c.dim(`  ${issueLabel(r)}: ↳ ${r.lastActivity}`));
    }
  }
  out.push('');

  // --- pause + limits ---
  if (d.pauses == null) {
    out.push(`${c.bold('PAUSED')}  ${c.dim('unknown (Redis unreachable)')}`);
  } else if (d.pauses.length === 0) {
    out.push(`${c.bold('PAUSED')}  ${c.dim('no workspaces')}`);
  } else {
    for (const [i, p] of d.pauses.entries()) {
      const left = p.ttlRemainingSeconds ? ` (resumes in ${formatDuration(p.ttlRemainingSeconds * 1000)})` : '';
      out.push(`${i === 0 ? c.bold('PAUSED') : '      '}  ${c.yellow(basename(p.workspaceRoot))}${p.reason ? ` — ${p.reason}` : ''}${left}`);
    }
  }
  const limits = d.active.find((r) => r.rateLimits)?.rateLimits ?? d.history.find((r) => r.rateLimits)?.rateLimits;
  if (limits) out.push(`${c.bold('LIMITS')}  5h window ${pct(limits.fiveHour)} · 7d window ${pct(limits.sevenDay)}`);
  out.push('');

  // --- totals ---
  const dayStart = new Date(d.now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const totals = (rows) => ({
    n: rows.length,
    cost: rows.reduce((a, r) => a + (r.costUsd || 0), 0),
    tokens: rows.reduce((a, r) => a + totalTokens(r.tokens), 0),
  });
  const today = totals(d.history.filter((r) => new Date(r.endedAt).getTime() >= dayStart.getTime()));
  const week = totals(d.history.filter((r) => new Date(r.endedAt).getTime() >= d.now - 7 * 864e5));
  out.push(
    `${c.bold('SPEND')}   today ${today.n} runs · ${formatCost(today.cost)} · ${formatTokens(today.tokens)} tok    7d ${week.n} runs · ${formatCost(week.cost)} · ${formatTokens(week.tokens)} tok`
  );
  out.push('');

  // --- recent ---
  out.push(c.bold('RECENT'));
  const recent = d.history.slice(0, 8);
  if (!recent.length) out.push(c.dim('  no finished runs recorded yet'));
  else out.push(...renderHistoryLines(recent, d.now, c));
  return out.join('\n');
}

/** @returns {string[]} boxed table, one row per run, newest first */
export function renderHistoryLines(rows, now, c = plain) {
  const body = rows.map((r) => [
    formatAgo(now - new Date(r.endedAt).getTime()),
    repoLabel(r),
    issueLabel(r),
    r.trigger ?? '-',
    r.outcome,
    formatDuration(r.durationMs),
    shortModel(r.model),
    String(r.turns ?? 0),
    formatTokens(r.tokens?.output),
    formatTokens(totalTokens(r.tokens)),
    formatCost(r.costUsd),
    r.runId,
  ]);
  return boxTable(
    ['ended', 'repo', 'issue', 'trigger', 'outcome', 'took', 'model', 'turns', 'out tok', 'total tok', 'cost', 'run'],
    body,
    c,
    (i) => (rows[i].outcome === 'success' ? (x) => x : c.red)
  );
}

function formatAgo(ms) {
  return `${formatDuration(ms)} ago`;
}

const ISSUE_RESULT_LABEL = {
  merged: 'merged',
  pr_open: 'PR open',
  pushed: 'pushed',
  no_changes: 'no changes',
  timeout: 'timeout',
  failed: 'failed',
};

/** Outcome label for an issue run from `readIssueRunHistory` (falls back to the agent exit outcome for old rows). */
function issueRunOutcomeLabel(run) {
  if (run.result) return ISSUE_RESULT_LABEL[run.result] ?? run.result;
  if (run.outcome === 'timeout') return 'timeout';
  return run.outcome === 'success' ? 'unknown' : 'failed';
}

/**
 * Plain-text list (no ANSI, no tables) of issue runs for WhatsApp, one line each:
 * `repo #n title — outcome, 2h05m ago`. Rows recorded before titles existed show `(title unknown)`.
 * @param {object[]} rows newest first
 * @param {number} now
 * @returns {string}
 */
export function renderIssueHistoryText(rows, now) {
  return rows
    .map((r) => {
      const title = r.issueTitle ? r.issueTitle : '(title unknown)';
      const ago = formatAgo(now - new Date(r.endedAt).getTime());
      return `${repoLabel(r)} #${r.issueNumber} ${title} — ${issueRunOutcomeLabel(r)}, ${ago}`;
    })
    .join('\n');
}

/**
 * Short plain-text status for WhatsApp: active run(s), pauses, last cron tick, last 3 issue runs.
 * Uses the same `health` values as the terminal status (`orphaned` / `stale`).
 * @param {Parameters<typeof renderStatus>[0]} d
 * @param {object[]} recentIssueRuns newest first, from `readIssueRunHistory`
 * @returns {string}
 */
export function renderStatusText(d, recentIssueRuns = []) {
  const out = [];
  if (!d.active.length) out.push('Agent: idle');
  for (const r of d.active) {
    const what = r.issueNumber != null ? `#${r.issueNumber} ${r.issueTitle ?? '(title unknown)'}` : issueLabel(r);
    const elapsed = formatDuration(d.now - new Date(r.startedAt).getTime());
    out.push(`Agent: ${what} (${repoLabel(r)}) — ${r.health}, ${elapsed}`);
    if (r.health === 'orphaned') out.push(`⚠ Orphaned: the bot process died but agent pid ${r.pid} is still running; nothing will report its result.`);
    else if (r.health === 'stale') out.push('⚠ Stale: leftover from a crash (no live process).');
    else if (r.lastActivity) out.push(`Phase: ${r.lastActivity}`);
  }

  if (d.pauses == null) out.push('Paused: unknown (Redis unreachable)');
  else if (!d.pauses.length) out.push('Paused: no');
  else {
    const list = d.pauses.map((p) => `${basename(p.workspaceRoot)}${p.reason ? ` (${p.reason})` : ''}`).join(', ');
    out.push(`Paused: ${list}`);
  }

  if (!d.cron) out.push('Cron: no state (disabled or not started yet)');
  else if (!d.cron.lastTickEndedAt) out.push(`Cron: ${describeOutcome(null)}`);
  else {
    const ago = formatAgo(d.now - new Date(d.cron.lastTickEndedAt).getTime());
    out.push(`Cron: last tick ${ago} — ${describeOutcome(d.cron.outcome)}${d.cronAlive ? '' : ' [bot process not running]'}`);
  }

  out.push('');
  out.push('Recent:');
  out.push(recentIssueRuns.length ? renderIssueHistoryText(recentIssueRuns, d.now) : 'no issue runs recorded yet');
  return out.join('\n');
}
