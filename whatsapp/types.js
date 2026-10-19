/**
 * Pino's call shape: fields first, message second. `logger.info('msg:', fields)` drops `fields`.
 * @typedef {{ (fields: object, msg?: string): void; (msg: string): void }} LogFn
 * @typedef {{ info: LogFn, warn: LogFn, error: LogFn }} Logger
 */

/**
 * The slice of the Baileys socket that only sends messages.
 * @typedef {Pick<import('@whiskeysockets/baileys').WASocket, 'sendMessage'>} MessageSender
 */

/**
 * The slice of `fetch` the HTTP clients use.
 * @typedef {(url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>} FetchLike
 */

export {};
