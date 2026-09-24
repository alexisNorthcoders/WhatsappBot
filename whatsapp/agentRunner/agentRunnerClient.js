/**
 * HTTP client for agent-runner's localhost API (see docs/adr/0001-agent-runner-out-of-process.md):
 *   POST /command {text, replyTo} → {reply}
 *   GET  /status                  → {busy, activeRun, paused}
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/** The runner didn't answer (down, timed out, or something else answered on its port). */
export class AgentRunnerUnreachableError extends Error {
  constructor(cause) {
    super(`agent-runner is not reachable: ${cause?.message || cause}`);
    this.name = 'AgentRunnerUnreachableError';
    this.cause = cause;
  }
}

/**
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number }} p
 */
export function createAgentRunnerClient({ baseUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const root = baseUrl.replace(/\/+$/, '');

  async function call(method, path, body) {
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
    /** @returns {Promise<string>} the runner's reply text */
    async sendCommand({ text, replyTo }) {
      const { reply } = await call('POST', '/command', { text, replyTo });
      if (typeof reply !== 'string') throw new AgentRunnerUnreachableError('response has no reply');
      return reply;
    },

    /** @returns {Promise<{ busy: boolean, activeRun: { runId: string } | null, paused: boolean }>} */
    status() {
      return call('GET', '/status');
    },
  };
}
