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
 * @param {{ runSpritePlus(m: InboundMessage): Promise<{ handled: boolean }>; runCommandByFirstToken(m: InboundMessage): Promise<{ handled: boolean }>; runLegacyRoutes(m: InboundMessage): Promise<{ handled: boolean }> }} ports.routes
 * @param {{ tryHandle(m: InboundMessage): Promise<{ handled: boolean; replyText?: string }> }} ports.agents
 * @param {{ info: Function; warn: Function; error: Function }} ports.logger
 * @param {{ labels: string[] }} [ports.buttons]
 */
export function createMessageOrchestrator(ports) {
  const buttonLabels = ports.buttons?.labels ?? DEFAULT_BUTTONS;

  function isButtonLabel(lowerText) {
    return buttonLabels.includes(lowerText);
  }

  /**
   * @param {InboundMessage} m
   */
  async function handleInbound(m) {
    const raw = /** @type {import('@whiskeysockets/baileys').proto.WebMessageInfo} */ (m.raw);
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
