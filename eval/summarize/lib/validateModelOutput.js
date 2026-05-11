/**
 * Strip optional ```json ... ``` fences from model output.
 * @param {string} raw
 */
export function stripMarkdownJsonFence(raw) {
  let s = String(raw ?? '').trim();
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i.exec(s);
  if (fence) s = fence[1].trim();
  return s;
}

/**
 * @typedef {{ text: string; evidence_quote: string }} SummarizeEvalBullet
 * @typedef {{ bullets: SummarizeEvalBullet[] }} SummarizeEvalOutput
 */

/**
 * @param {string} rawModelString
 * @param {string} fixtureExtractedText verbatim fixture text (substring checks use raw strings)
 * @returns {{ ok: true; value: SummarizeEvalOutput } | { ok: false; errors: string[] }}
 */
export function validateSummarizeEvalJson(rawModelString, fixtureExtractedText) {
  const errors = [];
  let parsed;
  const stripped = stripMarkdownJsonFence(rawModelString);
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, errors: [`Invalid JSON: ${msg}`] };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['Root JSON value must be a non-null object.'] };
  }

  const bullets = /** @type {unknown} */ (/** @type {Record<string, unknown>} */ (parsed).bullets);
  if (!Array.isArray(bullets)) {
    return { ok: false, errors: ['Missing or invalid "bullets" array.'] };
  }

  const article = String(fixtureExtractedText ?? '');
  /** @type {SummarizeEvalBullet[]} */
  const out = [];

  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      errors.push(`bullets[${i}] must be an object.`);
      continue;
    }
    const rec = /** @type {Record<string, unknown>} */ (b);
    const text = rec.text;
    const evidenceQuote = rec.evidence_quote;
    if (typeof text !== 'string') {
      errors.push(`bullets[${i}].text must be a string.`);
    }
    if (typeof evidenceQuote !== 'string') {
      errors.push(`bullets[${i}].evidence_quote must be a string.`);
    }
    if (typeof evidenceQuote === 'string') {
      if (!article.includes(evidenceQuote)) {
        errors.push(
          `bullets[${i}].evidence_quote is not a substring of the fixture extracted text.`,
        );
      }
    }
    if (typeof text === 'string' && typeof evidenceQuote === 'string' && article.includes(evidenceQuote)) {
      out.push({ text, evidence_quote: evidenceQuote });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: { bullets: out } };
}
