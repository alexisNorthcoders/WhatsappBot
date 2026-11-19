import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type CliReply = { text: string; wallMs: number; apiMs: number | null; costUsd: number | null };

const SYSTEM_PROMPT = 'Follow the user message exactly. Reply with only what it asks for.';

/**
 * One tool-less `claude -p` call: no tools, MCP servers, settings, hooks or saved session, and a
 * one-line system prompt, so it costs and answers like a bare API call. Dev machine only; the bot
 * never spawns `claude`.
 */
export function claudeCli(prompt: string, model: string, { timeoutMs = 300_000 } = {}): Promise<CliReply> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'books-bench-'));
  const args = [
    '-p', '--output-format', 'json', '--model', model, '--tools', '', '--strict-mcp-config',
    '--setting-sources', '', '--no-session-persistence', '--system-prompt', SYSTEM_PROMPT,
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const wallMs = Date.now() - started;
      try {
        const j = JSON.parse(out) as { result?: string; is_error?: boolean; duration_api_ms?: number; total_cost_usd?: number };
        if (j.is_error || typeof j.result !== 'string') throw new Error(j.result ?? 'no result');
        resolve({ text: j.result, wallMs, apiMs: j.duration_api_ms ?? null, costUsd: j.total_cost_usd ?? null });
      } catch (e) {
        reject(new Error(`claude ${model} exit ${code}: ${(e as Error).message} ${err.slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}
