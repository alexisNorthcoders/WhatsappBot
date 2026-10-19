import { askHomeManuals } from '../homeManualsClient.ts';
import { formatHomeAnswerReply } from '../utils/formatHomeAnswer.ts';
import type { MessageSender } from '../types.ts';

/** Test-only: marks injected `{ askHomeManuals? }` so raw WhatsApp messages are never mistaken for deps. */
const homeInjectedDepsBrand = Symbol.for('WhatsappBot.home.injectedDeps');

/**
 * Wrap test-only `{ askHomeManuals? }`. Production passes the raw Baileys message as the
 * 4th argument; it must not be mistaken for injected deps.
 */
export function homeInjectedDeps(partial: { askHomeManuals?: typeof askHomeManuals }) {
  return { [homeInjectedDepsBrand]: true, ...partial };
}

/**
 * @param fourthArg raw Baileys message in production, or {@link homeInjectedDeps} in tests
 */
function resolveHomeDeps(fourthArg: unknown) {
  if (
    fourthArg != null &&
    typeof fourthArg === 'object' &&
    (fourthArg as Record<symbol, unknown>)[homeInjectedDepsBrand] === true
  ) {
    const { [homeInjectedDepsBrand]: _b, ...rest } = fourthArg as Record<symbol | string, unknown>;
    return rest as { askHomeManuals?: typeof askHomeManuals };
  }
  return {};
}

const USAGE = 'Usage: home <question>, e.g. "home what model is the oven?"';

/**
 * `home <question>` — asks the home-manuals service and replies with the answer + Sources.
 * @param fourthArg raw Baileys message in production, or {@link homeInjectedDeps} in tests
 */
export default async function homeCommand(sock: MessageSender, chatId: string, text: string, fourthArg?: unknown) {
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
