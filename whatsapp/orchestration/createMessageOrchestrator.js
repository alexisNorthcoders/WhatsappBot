import { lidExtraJidsHint } from '../whatsAppActorAllowlist.js';

/** @typedef {import('./normalizeBaileysMessage.js').InboundMessage} InboundMessage */

const DEFAULT_BUTTONS = ['a', 'b', 'up', 'down', 'left', 'right', 'start', 'select'];

/**
 * @param {object} ports
 * @param {{ markRead(m: InboundMessage): Promise<void> }} ports.receipts
 * @param {{ sendText(chatId: string, text: string): Promise<void>; sendPoll(chatId: string, poll: { name: string; values: string[]; selectableCount: number }): Promise<void>; sendImage(chatId: string, image: { buffer: Buffer; caption?: string }): Promise<void> }} ports.messaging
 * @param {{ downloadImageBuffer(m: InboundMessage): Promise<Buffer> }} ports.media
 * @param {{ writeButton(button: string): Promise<void> }} ports.buttonSink
 * @param {{ get(chatId: string): Promise<Array<{ role: 'user'|'assistant'; content: string }>>; append(chatId: string, role: 'user'|'assistant', content: string): Promise<void>; clear(chatId: string): Promise<number> }} ports.chatMemory
 * @param {{ visionText(b64: string): Promise<string>; visionTextHigh(b64: string): Promise<string>; visionHelp(b64: string): Promise<string>; assistant(userText: string, prior: Array<{ role: 'user'|'assistant'; content: string }>): Promise<string> }} ports.ai
 * @param {{ runSpritePlus(m: InboundMessage): Promise<{ handled: boolean }>; runSdxlPlus(m: InboundMessage): Promise<{ handled: boolean }>; runCommandByFirstToken(m: InboundMessage): Promise<{ handled: boolean }>; runLegacyRoutes(m: InboundMessage): Promise<{ handled: boolean }> }} ports.routes
 * @param {{ tryHandle(m: InboundMessage): Promise<{ handled: boolean; replyText?: string }> }} ports.agents
 * @param {{ info: Function; warn: Function; error: Function }} ports.logger
 * @param {{ labels: string[] }} [ports.buttons]
 * @param {{ isAllowedActor(actorId: string | null, actorAltId?: string | null): boolean }} [ports.access] required when `ports.agentRunner` is set
 * @param {{ sendCommand(req: { text: string; replyTo: string }): Promise<string>; status(): Promise<{ busy: boolean; activeRun: { runId: string } | null }>; missedReport(): Promise<string> }} [ports.agentRunner]
 *   Set when `AGENT_RUNNER_URL` is: `claude…` commands go to agent-runner instead of the command registry.
 */
export function createMessageOrchestrator(ports) {
  const buttonLabels = ports.buttons?.labels ?? DEFAULT_BUTTONS;

  function isButtonLabel(lowerText) {
    return buttonLabels.includes(lowerText);
  }

  /**
   * `claude…` → agent-runner (`claude:missed` is answered from the bot's own outbox cursor).
   * @param {InboundMessage} m
   */
  async function delegateToAgentRunner(m, command) {
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
   * @param {InboundMessage} m
   * @returns {Promise<boolean>} true when the restart was refused
   */
  async function refuseRestartWhileRunActive(m) {
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

  /**
   * @param {InboundMessage} m
   */
  async function handleInbound(m) {
    const raw = /** @type {import('@whiskeysockets/baileys').WAMessage} */ (m.raw);
    const messageType = raw.message ? Object.keys(raw.message)[0] : 'unknown';
    const button = m.text.toLowerCase();
    const command = m.text.split(' ')[0].toLowerCase();

    ports.logger.info('Processing message:', {
      messageId: m.id,
      type: messageType,
      command,
      isButton: isButtonLabel(button),
    });

    if (isButtonLabel(button)) {
      await ports.buttonSink.writeButton(button);
      ports.logger.info('Button processed:', button);
    }

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

    if (ports.agentRunner && command.startsWith('claude')) {
      await delegateToAgentRunner(m, command);
      return;
    }

    {
      const r = await ports.routes.runCommandByFirstToken(m);
      if (r.handled) return;
    }

    if (ports.agentRunner && command === '!restart' && (await refuseRestartWhileRunActive(m))) {
      return;
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
