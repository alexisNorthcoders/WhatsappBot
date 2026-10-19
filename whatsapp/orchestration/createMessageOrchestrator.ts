import { lidExtraJidsHint } from '../whatsAppActorAllowlist.ts';
import type { InboundMessage } from './normalizeBaileysMessage.ts';
import type { Logger } from '../types.ts';
import type { WAMessage } from '@whiskeysockets/baileys';

/**
 * @param ports.agentRunner
 *   `claude…` commands go to agent-runner, never the command registry.
 */
export function createMessageOrchestrator(ports: { receipts: { markRead(m: InboundMessage): Promise<void> }; messaging: { sendText(chatId: string, text: string): Promise<void>; sendPoll(chatId: string, poll: { name: string; values: string[]; selectableCount: number }): Promise<void>; sendImage(chatId: string, image: { buffer: Buffer; caption?: string }): Promise<void> }; media: { downloadImageBuffer(m: InboundMessage): Promise<Buffer> }; chatMemory: { get(chatId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>>; append(chatId: string, role: 'user' | 'assistant', content: string): Promise<void>; clear(chatId: string): Promise<number> }; ai: { visionText(b64: string): Promise<string>; visionTextHigh(b64: string): Promise<string>; visionHelp(b64: string): Promise<string>; assistant(userText: string, prior: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string> }; routes: { runSpritePlus(m: InboundMessage): Promise<{ handled: boolean }>; runSdxlPlus(m: InboundMessage): Promise<{ handled: boolean }>; runCommandByFirstToken(m: InboundMessage): Promise<{ handled: boolean }>; runLegacyRoutes(m: InboundMessage): Promise<{ handled: boolean }> }; agents: { tryHandle(m: InboundMessage): Promise<{ handled: boolean; replyText?: string }> }; logger: Logger; access: { isAllowedActor(actorId: string | null, actorAltId?: string | null): boolean }; agentRunner: { sendCommand(req: { text: string; replyTo: string }): Promise<string>; status(): Promise<{ busy: boolean; activeRun: { runId: string } | null }>; missedReport(): Promise<string> } }) {
  /**
   * `claude…` → agent-runner (`claude:missed` is answered from the bot's own outbox cursor).
   */
  async function delegateToAgentRunner(m: InboundMessage, command) {
    if (!ports.access.isAllowedActor(m.actorId, m.actorAltId)) {
      await ports.messaging.sendText(
        m.chatId,
        `Not allowed to run the Claude agent from this identity.${lidExtraJidsHint(m.actorId)}\n\n(Phone chats use MY_PHONE / SECOND_PHONE; @lid chats need CLAUDE_AGENT_EXTRA_JIDS.)`,
      );
      return;
    }
    if (command === 'claude:missed') {
      await ports.messaging.sendText(m.chatId, await ports.agentRunner.missedReport());
      return;
    }
    let reply;
    try {
      reply = await ports.agentRunner.sendCommand({ text: m.text, replyTo: m.chatId });
    } catch (err) {
      ports.logger.warn({ err: err?.message || err }, 'agent-runner command failed');
      reply = err?.timedOut
        ? "Agent runner didn't answer in time. It may still be working on it, check `claude:status`."
        : 'Agent runner is not reachable';
    }
    if (reply) await ports.messaging.sendText(m.chatId, reply);
  }

  /**
   * A bot restart mid-run can load a half-edited checkout, so `!restart` waits for the runner.
   * Unreachable runner → nothing to wait for. Non-allowlisted actors fall through to the denial.
   * @returns true when the restart was refused
   */
  async function refuseRestartWhileRunActive(m: InboundMessage): Promise<boolean> {
    if (!ports.access.isAllowedActor(m.actorId, m.actorAltId)) return false;
    let status;
    try {
      status = await ports.agentRunner.status();
    } catch (err) {
      ports.logger.warn({ err: err?.message || err }, 'agent-runner status failed, restarting anyway');
      return false;
    }
    if (!status?.busy) return false;
    await ports.messaging.sendText(
      m.chatId,
      `Run ${status.activeRun?.runId ?? '?'} in progress, wait or \`claude:stop\`.`,
    );
    return true;
  }

  async function handleInbound(m: InboundMessage) {
    const raw = m.raw as WAMessage;
    const messageType = raw.message ? Object.keys(raw.message)[0] : 'unknown';
    const command = m.text.split(' ')[0].toLowerCase();

    ports.logger.info({
      messageId: m.id,
      type: messageType,
      command,
    }, 'Processing message');

    if (raw.message?.imageMessage) {
      const buffer = await ports.media.downloadImageBuffer(m);
      if (m.text.startsWith('Text high')) {
        const res = await ports.ai.visionTextHigh(buffer.toString('base64'));
        await ports.messaging.sendText(m.chatId, res);
      } else if (m.text.startsWith('Text')) {
        const res = await ports.ai.visionText(buffer.toString('base64'));
        await ports.messaging.sendText(m.chatId, res);
      } else if (m.text.startsWith('Help')) {
        const res = await ports.ai.visionHelp(buffer.toString('base64'));
        await ports.messaging.sendText(m.chatId, res);
      } else if (!m.text) {
        await ports.messaging.sendText(
          m.chatId,
          'Add a caption when sending an image:\n' +
            '• *Text* — extract text\n' +
            '• *Text high* — higher-quality extraction\n' +
            '• *Help* — describe / get help with the image',
        );
      }
      return;
    }

    if (/^\s*sprite\+/i.test(m.text)) {
      const r = await ports.routes.runSpritePlus(m);
      if (r.handled) return;
    }

    if (/^\s*sdxl\+/i.test(m.text)) {
      const r = await ports.routes.runSdxlPlus(m);
      if (r.handled) return;
    }

    if (/^claude(?=$|:)/.test(command)) {
      await delegateToAgentRunner(m, command);
      return;
    }

    // before the command registry, so no registered `!restart` can bypass the runner guard
    if (command === '!restart' && (await refuseRestartWhileRunActive(m))) {
      return;
    }

    {
      const r = await ports.routes.runCommandByFirstToken(m);
      if (r.handled) return;
    }

    {
      const r = await ports.routes.runLegacyRoutes(m);
      if (r.handled) return;
    }

    const agentResult = await ports.agents.tryHandle(m);
    if (agentResult.handled) {
      return;
    }

    const prior = await ports.chatMemory.get(m.chatId);
    const response = await ports.ai.assistant(m.text, prior);
    await ports.messaging.sendText(m.chatId, response);
    await ports.chatMemory.append(m.chatId, 'user', m.text);
    await ports.chatMemory.append(m.chatId, 'assistant', response);
  }

  return { handleInbound };
}
