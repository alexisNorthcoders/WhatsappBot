export const VERDICT_APPROVE = 'VERDICT: APPROVE';
export const VERDICT_REQUEST_CHANGES = 'VERDICT: REQUEST_CHANGES';

/**
 * After `gh pr create`, pick URL including recovery when GitHub says a PR already exists.
 * @param {{
 *   listedOk: boolean,
 *   listedUrl?: string,
 *   createOk: boolean,
 *   createUrl?: string,
 *   createError?: string,
 *   recoveredUrl?: string | null,
 * }} p
 * @returns {{ ok: boolean, url?: string, error?: string, prOutcome: 'listed' | 'created' | 'recovered' | null }}
 */
export function pickPrResultAfterGhFlow(p) {
  if (p.listedOk && p.listedUrl) {
    return { ok: true, url: p.listedUrl, prOutcome: 'listed' };
  }
  if (p.createOk && p.createUrl) {
    return { ok: true, url: p.createUrl, prOutcome: 'created' };
  }
  if (ghMessageLooksLikePrAlreadyExists(p.createError) && p.recoveredUrl) {
    return { ok: true, url: p.recoveredUrl, prOutcome: 'recovered' };
  }
  return {
    ok: Boolean(p.createOk),
    url: p.createUrl,
    error: p.createError,
    prOutcome: null,
  };
}

export function ghMessageLooksLikePrAlreadyExists(msg) {
  const s = String(msg || '').toLowerCase();
  return (
    s.includes('already exists') ||
    s.includes('pull request already') ||
    (s.includes('a pull request') && s.includes('already'))
  );
}

/**
 * @param {{ reviewOutcome: string, reviewVerdict: string, postReviewAutofix: { ok?: boolean } | null }} args
 */
export function autoMergeAllowedByReviewGate({ reviewOutcome, reviewVerdict, postReviewAutofix }) {
  if (reviewOutcome !== 'success') return false;
  if (reviewVerdict === VERDICT_APPROVE) return true;
  if (reviewVerdict === VERDICT_REQUEST_CHANGES) {
    return Boolean(postReviewAutofix?.ok);
  }
  return false;
}

/**
 * Ensure the GitHub PR comment starts with an exact verdict line (automation-parseable).
 * @param {string} raw model output
 * @returns {{ verdict: typeof VERDICT_APPROVE | typeof VERDICT_REQUEST_CHANGES, bodyMarkdown: string, fullComment: string }}
 */
export function normalizePrReviewComment(raw) {
  const text = String(raw || '').trim();
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const first = (lines[i] || '').trim();
  const rest = lines.slice(i + 1).join('\n').trim();

  const up = first.toUpperCase();
  if (up === VERDICT_APPROVE.toUpperCase()) {
    const fullComment = rest ? `${VERDICT_APPROVE}\n\n${rest}` : `${VERDICT_APPROVE}\n`;
    return { verdict: VERDICT_APPROVE, bodyMarkdown: rest, fullComment };
  }
  if (up === VERDICT_REQUEST_CHANGES.toUpperCase()) {
    const fullComment = rest
      ? `${VERDICT_REQUEST_CHANGES}\n\n${rest}`
      : `${VERDICT_REQUEST_CHANGES}\n`;
    return { verdict: VERDICT_REQUEST_CHANGES, bodyMarkdown: rest, fullComment };
  }

  const body = text || '_The model returned an empty review._';
  const fallbackBody =
    '_The automated reviewer did not put a valid verdict on the first line; defaulting to REQUEST_CHANGES._\n\n' +
    body;
  const fullComment = `${VERDICT_REQUEST_CHANGES}\n\n${fallbackBody}`;
  return { verdict: VERDICT_REQUEST_CHANGES, bodyMarkdown: fallbackBody, fullComment };
}
