import { normalizeBaileysMessage } from './normalizeBaileysMessage.js';
import { createMessageOrchestrator } from './createMessageOrchestrator.js';

/**
 * Thin adapter: Baileys upsert → read receipt → normalize → orchestrator.
 * @param {object} opts
 * @param {import('@whiskeysockets/baileys').WASocket} opts.sock
 * @param {() => object} opts.createPorts factory returning full orchestrator ports
 * @param {Record<string, unknown>} opts.commands registry object (for error context only)
 */
export function createBaileysMessageHandler(opts) {
  const { sock, createPorts, commands } = opts;
  const ports = createPorts();
  const { handleInbound } = createMessageOrchestrator(ports);
  const buttonLabels = ports.buttons?.labels ?? [];

  return {
    /**
     * @param {{ messages?: import('@whiskeysockets/baileys').proto.WebMessageInfo[]; type?: string }} upsert
     */
    async handleUpsert(upsert) {
      const msg = upsert.messages?.[0];
      if (!msg?.message || msg.key.fromMe) {
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
      const button = text.toLowerCase();
      const command = text.split(' ')[0].toLowerCase();

      try {
        try {
          await ports.receipts.markRead(normalizeBaileysMessage(msg));
          ports.logger.info(`Sent read receipt for message ${msg.key.id}`);
        } catch (err) {
          ports.logger.warn(`Failed to send read receipt: ${err.message}`);
        }

        await handleInbound(normalizeBaileysMessage(msg));
      } catch (err) {
        ports.logger.error('❌ Error processing message:', {
          error: err.message,
          stack: err.stack,
          messageId: msg.key.id,
          sender: msg.key.remoteJid,
          type: messageType,
          text,
          command,
          context: {
            isButton: buttonLabels.includes(button),
            isImage: !!msg.message.imageMessage,
            isCommand: !!commands[command],
          },
        });

        try {
          const errorMessage = err.message.includes('network')
            ? 'Sorry, there seems to be a connection issue. Please try again in a moment.'
            : 'Sorry, there was an error processing your message. Please try again.';

          await sock.sendMessage(msg.key.remoteJid, { text: errorMessage });
        } catch (notifyErr) {
          ports.logger.error('Failed to send error notification:', {
            error: notifyErr.message,
            originalError: err.message,
            sender: msg.key.remoteJid,
          });
        }
      }
    },
  };
}
