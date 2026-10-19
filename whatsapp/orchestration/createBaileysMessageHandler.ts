import { normalizeBaileysMessage } from './normalizeBaileysMessage.ts';
import { createMessageOrchestrator } from './createMessageOrchestrator.ts';

/**
 * Thin adapter: Baileys upsert → owner check → read receipt → normalize → orchestrator.
 * Messages from anyone but the owner (MY_PHONE / SECOND_PHONE, see whatsAppActorAllowlist.ts)
 * are dropped silently: no read receipt, no reply, so another bot can't start a reply loop.
 * @param {object} opts
 * @param {import('../types.ts').MessageSender} opts.sock
 * @param {() => object} opts.createPorts factory returning full orchestrator ports
 * @param {Record<string, unknown>} opts.commands registry object (for error context only)
 */
export function createBaileysMessageHandler(opts) {
  const { sock, createPorts, commands } = opts;
  const ports = createPorts();
  const { handleInbound } = createMessageOrchestrator(ports);

  return {
    /**
     * @param {{ messages?: import('@whiskeysockets/baileys').WAMessage[]; type?: string }} upsert
     */
    async handleUpsert(upsert) {
      const msg = upsert.messages?.[0];
      if (!msg?.message || msg.key.fromMe) {
        return;
      }

      const inbound = normalizeBaileysMessage(msg);
      if (!ports.access.isAllowedActor(inbound.actorId, inbound.actorAltId)) {
        ports.logger.info({
          messageId: msg.key.id,
          sender: inbound.actorId,
          senderAlt: inbound.actorAltId,
        }, 'Ignoring message from non-owner sender');
        return;
      }

      const messageType = Object.keys(msg.message)[0];
      const text = (
        msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || msg.message.imageMessage?.caption
        || msg.message.videoMessage?.caption
        || msg.message.documentMessage?.caption
        || ''
      ).trim();
      const command = text.split(' ')[0].toLowerCase();

      try {
        try {
          await ports.receipts.markRead(inbound);
          ports.logger.info(`Sent read receipt for message ${msg.key.id}`);
        } catch (err) {
          ports.logger.warn(`Failed to send read receipt: ${err.message}`);
        }

        await handleInbound(inbound);
      } catch (err) {
        ports.logger.error({
          error: err.message,
          stack: err.stack,
          messageId: msg.key.id,
          sender: msg.key.remoteJid,
          type: messageType,
          text,
          command,
          context: {
            isImage: !!msg.message.imageMessage,
            isCommand: !!commands[command],
          },
        }, '❌ Error processing message');

        try {
          const errorMessage = err.message.includes('network')
            ? 'Sorry, there seems to be a connection issue. Please try again in a moment.'
            : 'Sorry, there was an error processing your message. Please try again.';

          await sock.sendMessage(inbound.chatId, { text: errorMessage });
        } catch (notifyErr) {
          ports.logger.error({
            error: notifyErr.message,
            originalError: err.message,
            sender: msg.key.remoteJid,
          }, 'Failed to send error notification');
        }
      }
    },
  };
}
