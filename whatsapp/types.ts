import type { WASocket } from '@whiskeysockets/baileys';

/** Pino's call shape: fields first, message second. `logger.info('msg:', fields)` drops `fields`. */
export type LogFn = { (fields: object, msg?: string): void; (msg: string): void };
export type Logger = { info: LogFn; warn: LogFn; error: LogFn };

export type MessageSender = Pick<WASocket, 'sendMessage'>;


/** A sender that only sends text; the Baileys socket is one, and so is a small test fake. */
export type TextSender = { sendMessage: (jid: string, content: { text: string }) => Promise<unknown> };

export type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * A `whatsapp/commands/` handler. `raw` is the Baileys message (or injected deps in tests). A
 * text-only command takes a `TextSender`, and still fits a `Command` slot.
 */
export type Command<S = MessageSender> = (
  sock: S,
  chatId: string,
  text: string,
  raw?: unknown,
) => Promise<unknown>;
