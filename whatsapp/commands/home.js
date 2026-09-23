import { askHomeManuals } from '../homeManualsClient.js';
import { formatHomeAnswerReply } from '../utils/formatHomeAnswer.js';

/** Test-only: marks injected `{ askHomeManuals? }` so raw WhatsApp messages are never mistaken for deps. */
const homeInjectedDepsBrand = Symbol.for('WhatsappBot.home.injectedDeps');

/**
 * Wrap test-only `{ askHomeManuals? }`. Production passes the raw Baileys message as the
 * 4th argument; it must not be mistaken for injected deps.
 * @param {{ askHomeManuals?: typeof askHomeManuals }} partial
 */
export function homeInjectedDeps(partial) {
  return { [homeInjectedDepsBrand]: true, ...partial };
}

/**
 * @param {unknown} fourthArg raw Baileys message in production, or {@link homeInjectedDeps} in tests
 */
function resolveHomeDeps(fourthArg) {
  if (
    fourthArg != null &&
    typeof fourthArg === 'object' &&
    /** @type {Record<symbol, unknown>} */ (fourthArg)[homeInjectedDepsBrand] === true
  ) {
    const { [homeInjectedDepsBrand]: _b, ...rest } = /** @type {Record<symbol | string, unknown>} */ (
      fourthArg
    );
    return /** @type {{ askHomeManuals?: typeof askHomeManuals }} */ (rest);
  }
  return {};
}

const USAGE = 'Usage: home <question>, e.g. "home what model is the oven?"';

/**
 * `home <question>` — asks the home-manuals service and replies with the answer + Sources.
 * @param {{ sendMessage: Function }} sock
 * @param {string} chatId
 * @param {string} text
 * @param {unknown} [fourthArg] raw Baileys message in production, or {@link homeInjectedDeps} in tests
 */
export default async function homeCommand(sock, chatId, text, fourthArg) {
  const deps = resolveHomeDeps(fourthArg);
  const ask = deps.askHomeManuals ?? askHomeManuals;

  const question = String(text || '').replace(/^home\s*/i, '').trim();
  if (!question) {
    await sock.sendMessage(chatId, { text: USAGE });
    return;
  }

  const result = await ask(question);

  if (!result.ok) {
    if (result.reason === 'not_configured') {
      await sock.sendMessage(chatId, {
        text: 'The home service is not configured (HOME_MANUALS_URL is unset).',
      });
      return;
    }
    await sock.sendMessage(chatId, {
      text: 'The home service is currently down — try again later.',
    });
    return;
  }

  await sock.sendMessage(chatId, { text: formatHomeAnswerReply(result.answer, result.sources) });
}
