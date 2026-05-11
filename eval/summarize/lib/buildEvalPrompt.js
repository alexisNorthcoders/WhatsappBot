/**
 * Prompt asking for strict JSON with grounded bullets (same spirit as WhatsApp summarize).
 * @param {string} extractedText (possibly truncated)
 * @param {string} [extraFocus] optional user focus, like summarize “extra” tail
 */
export function buildSummarizeEvalPrompt(extractedText, extraFocus = '') {
  const focus = String(extraFocus || '').trim() || 'None.';
  return [
    'You summarize text extracted from a web page for a short evaluation run.',
    'Rules:',
    '- Be accurate; do not invent facts.',
    '- Output MUST be a single JSON object and nothing else (no markdown fences, no commentary).',
    '- The object MUST have key "bullets" whose value is an array.',
    '- Each bullet MUST be an object with:',
    '  - "text": a short summary point.',
    '  - "evidence_quote": a verbatim substring copied from the extracted article text below (copy-paste, not paraphrased).',
    '- Every evidence_quote MUST appear exactly as a contiguous substring in the extracted article text.',
    '',
    'Optional user focus:',
    focus,
    '',
    'Extracted article text:',
    '---',
    String(extractedText),
    '---',
  ].join('\n');
}
