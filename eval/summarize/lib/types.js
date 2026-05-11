/**
 * @typedef {{ text: string; evidence_quote: string }} SummarizeEvalBullet
 * @typedef {{ bullets: SummarizeEvalBullet[] }} SummarizeEvalOutput
 */

/**
 * @typedef {{
 *   id: string;
 *   metadata?: Record<string, unknown>;
 *   extractedText: string;
 * }} SummarizeEvalFixture
 */

/**
 * @typedef {{
 *   fixtureId: string;
 *   facts: Array<{
 *     id: string;
 *     acceptableEvidenceSubstrings: string[];
 *     mode?: 'any' | 'all';
 *   }>;
 * }} SummarizeEvalGold
 */

export {};
