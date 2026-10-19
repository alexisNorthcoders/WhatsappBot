/**
 * HTTP client for agent-runner's localhost API (see docs/adr/0001-agent-runner-out-of-process.md):
 *   POST /command {text, replyTo} → {reply}
 *   GET  /status                  → {busy, activeRun, paused}
 */

import type { FetchLike } from '../types.ts';

export type RunnerStatus = { busy: boolean; activeRun: { runId: string } | null; paused: boolean };

// `claude issue:<n>` only replies once the issue is fetched and the branch prepared (gh + git pull)
const COMMAND_TIMEOUT_MS = 120_000;
const STATUS_TIMEOUT_MS = 10_000;

/**
 * The runner didn't answer: down, something else answered on its port, or (`timedOut`) no answer
 * in time — in which case it may still be working on the command.
 */
export class AgentRunnerUnreachableError extends Error {
  declare timedOut: boolean;

  constructor(cause: unknown) {
    super(`agent-runner is not reachable: ${(cause as Error)?.message || cause}`);
    this.name = 'AgentRunnerUnreachableError';
    this.cause = cause;
    this.timedOut = (cause as Error)?.name === 'TimeoutError';
  }
}

export function createAgentRunnerClient({
  baseUrl,
  fetchImpl = fetch,
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  statusTimeoutMs = STATUS_TIMEOUT_MS,
}: { baseUrl: string; fetchImpl?: FetchLike; commandTimeoutMs?: number; statusTimeoutMs?: number }) {
  const root = baseUrl.replace(/\/+$/, '');

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body: object | undefined,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    let json;
    try {
      const res = await fetchImpl(`${root}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      json = await res.json();
    } catch (err) {
      throw new AgentRunnerUnreachableError(err);
    }
    if (!json || typeof json !== 'object') throw new AgentRunnerUnreachableError('unexpected response');
    return json;
  }

  return {
    /** @returns the runner's reply text */
    async sendCommand({ text, replyTo }: { text: string; replyTo: string }): Promise<string> {
      const { reply } = await call('POST', '/command', { text, replyTo }, commandTimeoutMs);
      if (typeof reply !== 'string') throw new AgentRunnerUnreachableError('response has no reply');
      return reply;
    },

    status(): Promise<RunnerStatus> {
      return call('GET', '/status', undefined, statusTimeoutMs) as Promise<RunnerStatus>;
    },
  };
}
