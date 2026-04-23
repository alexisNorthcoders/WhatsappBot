import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickNextEligibleIssue } from '../whatsapp/agents/cronIssueTracer.js';

describe('pickNextEligibleIssue', () => {
  it('returns null when every issue is PRD-prefixed', () => {
    const r = pickNextEligibleIssue([
      { number: 23, title: 'PRD: some product doc' },
      { number: 99, title: 'prd lowercase' },
    ]);
    assert.equal(r, null);
  });

  it('ignores case and leading whitespace for PRD rule', () => {
    const r = pickNextEligibleIssue([
      { number: 10, title: '  Prd: x' },
      { number: 2, title: 'real task' },
    ]);
    assert.deepEqual(r, { number: 2, title: 'real task' });
  });

  it('picks lowest issue number among eligible', () => {
    const r = pickNextEligibleIssue([
      { number: 30, title: 'Later' },
      { number: 5, title: 'First eligible' },
      { number: 8, title: 'Mid' },
    ]);
    assert.deepEqual(r, { number: 5, title: 'First eligible' });
  });

  it('ignores PRD-prefixed titles that use punctuation after the letters (e.g. PRD-…)', () => {
    const r = pickNextEligibleIssue([{ number: 1, title: 'PRD-foo' }]);
    assert.equal(r, null);
  });
});
