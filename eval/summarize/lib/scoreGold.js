/**
 * A fact is covered if some bullet's evidence_quote satisfies the gold entry.
 *
 * - mode `any` (default): at least one string in acceptableEvidenceSubstrings appears as a substring of some evidence_quote.
 * - mode `all`: every string in acceptableEvidenceSubstrings appears as a substring of the same evidence_quote.
 *
 * @param {import('./types.js').SummarizeEvalOutput} output
 * @param {import('./types.js').SummarizeEvalGold} gold
 */
export function scoreGoldAgainstOutput(output, gold) {
  const bullets = Array.isArray(output.bullets) ? output.bullets : [];
  /** @type {Array<{ id: string; covered: boolean; detail: string }>} */
  const facts = [];

  for (const f of gold.facts || []) {
    const mode = f.mode === 'all' ? 'all' : 'any';
    const subs = Array.isArray(f.acceptableEvidenceSubstrings)
      ? f.acceptableEvidenceSubstrings.map((s) => String(s))
      : [];

    if (subs.length === 0) {
      facts.push({
        id: f.id,
        covered: false,
        detail: 'no acceptableEvidenceSubstrings defined',
      });
      continue;
    }

    let covered = false;
    let detail = '';

    if (mode === 'any') {
      for (const sub of subs) {
        for (const b of bullets) {
          if (typeof b.evidence_quote === 'string' && b.evidence_quote.includes(sub)) {
            covered = true;
            detail = `matched substring for "${f.id}" in evidence_quote`;
            break;
          }
        }
        if (covered) break;
      }
      if (!covered) {
        detail = 'no acceptable substring found in any evidence_quote';
      }
    } else {
      for (const b of bullets) {
        const q = b.evidence_quote;
        if (typeof q !== 'string') continue;
        const ok = subs.every((sub) => q.includes(sub));
        if (ok) {
          covered = true;
          detail = `all required substrings found in one evidence_quote`;
          break;
        }
      }
      if (!covered) {
        detail = 'no single evidence_quote contains all required substrings';
      }
    }

    facts.push({ id: f.id, covered, detail });
  }

  const totalFacts = facts.length;
  const coveredFacts = facts.filter((x) => x.covered).length;
  const percent = totalFacts === 0 ? 100 : (coveredFacts / totalFacts) * 100;

  return {
    facts,
    totalFacts,
    coveredFacts,
    percent,
  };
}
