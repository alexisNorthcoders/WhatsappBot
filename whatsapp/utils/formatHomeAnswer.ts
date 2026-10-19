const WHATSAPP_MAX_CHARS = 4096;

/**
 * @param {object|string} source
 * @returns {string}
 */
function formatSourceLine(source) {
  if (typeof source === 'string') return `• ${source}`;
  const item = source?.item ?? source?.name ?? '';
  const manual = source?.manual ?? '';
  const page = source?.page;
  let line = '•';
  if (item) line += ` ${item}`;
  if (manual) line += item ? ` — ${manual}` : ` ${manual}`;
  if (page !== undefined && page !== null && page !== '') line += `, p. ${page}`;
  return line === '•' ? '• (unknown source)' : line;
}

/**
 * Format a home-manuals answer plus a short Sources line, capped to the WhatsApp message limit.
 * @param {string} answer
 * @param {Array<object|string>} [sources]
 * @returns {string}
 */
export function formatHomeAnswerReply(answer, sources = []) {
  let message = String(answer || '').trim();
  if (sources.length > 0) {
    const lines = sources.map(formatSourceLine);
    message += `\n\nSources:\n${lines.join('\n')}`;
  }
  if (message.length > WHATSAPP_MAX_CHARS) {
    message = `${message.slice(0, WHATSAPP_MAX_CHARS - 1)}…`;
  }
  return message;
}
