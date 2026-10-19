import { actorAltJid } from '../whatsAppActorAllowlist.ts';
import type { WAMessage } from '@whiskeysockets/baileys';

export type InboundMessage = {
  id: string;
  chatId: string;
  actorId: string | null;
  /** sender's alternate id (PN ↔ LID) from the message key, if any */
  actorAltId: string | null;
  fromMe: boolean;
  text: string;
  features: { hasImage: boolean };
  raw: unknown;
};

/**
 * Map a Baileys WAMessage into a stable inbound shape for the orchestrator.
 */
export function normalizeBaileysMessage(msg: WAMessage): InboundMessage {
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
    actorAltId: actorAltJid(msg),
    fromMe: !!msg.key?.fromMe,
    text,
    features: { hasImage: !!message?.imageMessage },
    raw: msg,
  };
}
