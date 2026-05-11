/** Matches `SUMMARIZE_MAX_INPUT_CHARS` / cap used by the live summarize command. */
export function maxLlmInputChars() {
  const n = parseInt(process.env.SUMMARIZE_MAX_INPUT_CHARS || '24000', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500_000) : 24_000;
}

export function truncateExtractedText(extractedText, cap = maxLlmInputChars()) {
  const s = String(extractedText ?? '');
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n\n[… truncated for model input length …]`;
}
