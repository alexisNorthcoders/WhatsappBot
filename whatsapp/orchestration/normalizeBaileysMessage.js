/**
 * @typedef {object} InboundMessage
 * @property {string} id
 * @property {string} chatId
 * @property {string | null} actorId
 * @property {boolean} fromMe
 * @property {string} text
 * @property {{ hasImage: boolean }} features
 * @property {unknown} raw
 */

/**
 * Map a Baileys WebMessageInfo into a stable inbound shape for the orchestrator.
 * @param {import('@whiskeysockets/baileys').proto.WebMessageInfo} msg
 * @returns {InboundMessage}
 */
export function normalizeBaileysMessage(msg) {
  const message = msg.message;
  const text = (
    message?.conversation
    || message?.extendedTextMessage?.text
    || message?.imageMessage?.caption
    || message?.videoMessage?.caption
    || message?.documentMessage?.caption
    || ''
  ).trim();

  const participant = msg.key?.participant;
  const remoteJid = msg.key?.remoteJid;

  return {
    id: String(msg.key?.id ?? ''),
    chatId: String(remoteJid ?? ''),
    actorId: participant ? String(participant) : remoteJid != null ? String(remoteJid) : null,
    fromMe: !!msg.key?.fromMe,
    text,
    features: { hasImage: !!message?.imageMessage },
    raw: msg,
  };
}
