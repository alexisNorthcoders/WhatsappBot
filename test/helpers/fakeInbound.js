/** @typedef {import('../../whatsapp/orchestration/normalizeBaileysMessage.js').InboundMessage} InboundMessage */

/**
 * A complete InboundMessage from the owner's DM; override any field.
 * @param {Partial<InboundMessage>} [overrides]
 * @returns {InboundMessage}
 */
export function fakeInbound(overrides = {}) {
  const text = overrides.text ?? 'hello';
  return {
    id: '1',
    chatId: '111@s.whatsapp.net',
    actorId: '111@s.whatsapp.net',
    actorAltId: null,
    fromMe: false,
    text,
    features: { hasImage: false },
    raw: { key: { remoteJid: '111@s.whatsapp.net', id: '1', fromMe: false }, message: { conversation: text } },
    ...overrides,
  };
}
