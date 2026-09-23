import { actorAltJid, actorJid, isAllowedActor, lidExtraJidsHint } from '../whatsAppActorAllowlist.js';
import { readIssueRunHistory, getTelemetryDir } from '../agents/claudeRunTelemetry.js';
import { renderIssueHistoryText } from '../agents/claudeAgentCliFormat.js';

export const DEFAULT_HISTORY_COUNT = 10;
export const MAX_HISTORY_COUNT = 30;

/**
 * `claude:history [n]` — recent GitHub issue runs by the Claude agent, from local telemetry.
 * @param {{ readHistory?: typeof readIssueRunHistory, now?: () => number }} [deps]
 */
export default async function claudeHistoryCommand(sock, sender, text, msg, deps = {}) {
  const readHistory = deps.readHistory ?? readIssueRunHistory;
  const now = deps.now ?? Date.now;

  const actor = actorJid(msg, sender);
  if (!isAllowedActor(actor, actorAltJid(msg))) {
    await sock.sendMessage(sender, {
      text: `Not allowed to view Claude agent history from this identity.${lidExtraJidsHint(actor)}`,
    });
    return;
  }

  const arg = text.trim().split(/\s+/)[1];
  let count = DEFAULT_HISTORY_COUNT;
  if (arg !== undefined) {
    if (!/^\d+$/.test(arg) || parseInt(arg, 10) < 1) {
      await sock.sendMessage(sender, { text: 'Usage: claude:history [n]  (n = number of runs, 1-' + MAX_HISTORY_COUNT + ')' });
      return;
    }
    count = Math.min(parseInt(arg, 10), MAX_HISTORY_COUNT);
  }

  const rows = await readHistory({ dir: getTelemetryDir(), limit: count });
  if (!rows.length) {
    await sock.sendMessage(sender, { text: 'No issue runs recorded yet.' });
    return;
  }
  await sock.sendMessage(sender, { text: `Last ${rows.length} issue run${rows.length === 1 ? '' : 's'}:\n${renderIssueHistoryText(rows, now())}` });
}
