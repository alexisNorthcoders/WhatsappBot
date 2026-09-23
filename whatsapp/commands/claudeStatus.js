import { actorAltJid, actorJid, isAllowedActor, lidExtraJidsHint } from '../whatsAppActorAllowlist.js';
import { readIssueRunHistory, getTelemetryDir } from '../agents/claudeRunTelemetry.js';
import { collectStatus } from '../agents/claudeStatusCollect.js';
import { renderStatusText } from '../agents/claudeAgentCliFormat.js';

export const STATUS_RECENT_COUNT = 3;

/**
 * `claude:status` — snapshot of the Claude agent: active run, pauses, last cron tick, last 3 issue runs.
 * @param {{ collect?: typeof collectStatus, readIssueHistory?: typeof readIssueRunHistory }} [deps]
 */
export default async function claudeStatusCommand(sock, sender, text, msg, deps = {}) {
  const collect = deps.collect ?? collectStatus;
  const readIssueHistory = deps.readIssueHistory ?? readIssueRunHistory;

  const actor = actorJid(msg, sender);
  if (!isAllowedActor(actor, actorAltJid(msg))) {
    await sock.sendMessage(sender, {
      text: `Not allowed to view Claude agent status from this identity.${lidExtraJidsHint(actor)}`,
    });
    return;
  }

  const [data, recent] = await Promise.all([
    collect(),
    readIssueHistory({ dir: getTelemetryDir(), limit: STATUS_RECENT_COUNT }),
  ]);
  await sock.sendMessage(sender, { text: renderStatusText(data, recent.slice(0, STATUS_RECENT_COUNT)) });
}
