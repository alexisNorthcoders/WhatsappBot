import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';

const CSV_HEADER =
  'timestamp_utc,agent,model,prompt_tokens,completion_tokens,total_tokens,outcome\n';

function csvCell(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialized writes so concurrent WhatsApp messages do not interleave CSV rows. */
let writeQueue = Promise.resolve();

function logPath() {
  const p = process.env.AGENT_USAGE_LOG?.trim();
  return p ? resolve(p) : resolve(process.cwd(), 'logs', 'agent-usage.csv');
}

/**
 * @param {{ agent: string, model: string, promptTokens: number, completionTokens: number, totalTokens: number, outcome: string }} row
 */
export function logAgentInvocation(row) {
  const path = logPath();
  const line =
    [
      new Date().toISOString(),
      row.agent,
      row.model,
      row.promptTokens,
      row.completionTokens,
      row.totalTokens,
      row.outcome,
    ]
      .map(csvCell)
      .join(',') + '\n';

  writeQueue = writeQueue
    .then(async () => {
      await fs.mkdir(dirname(path), { recursive: true });
      let exists = true;
      try {
        await fs.access(path);
      } catch {
        exists = false;
      }
      if (!exists) {
        await fs.writeFile(path, CSV_HEADER + line, 'utf8');
      } else {
        await fs.appendFile(path, line, 'utf8');
      }
    })
    .catch((err) => {
      console.error('agent usage log failed:', err.message);
    });

  return writeQueue;
}

export function addCompletionUsage(usage, bucket) {
  if (!usage) return;
  bucket.prompt += usage.prompt_tokens ?? 0;
  bucket.completion += usage.completion_tokens ?? 0;
  bucket.total += usage.total_tokens ?? 0;
}
