import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPostCloseChangesEmail } from '../whatsapp/agents/claudePostRun.js';

const base = {
  subjectPrefix: 'WhatsappBot',
  issueNumber: 104,
  title: 'Match sent messages across JIDs',
  issueUrl: 'https://github.com/o/r/issues/104',
  prUrl: 'https://github.com/o/r/pull/109',
  summary: 'The LLM summary.\n\n- point one',
};

describe('buildPostCloseChangesEmail', () => {
  it('puts the issue number and title in the subject', () => {
    const { subject } = buildPostCloseChangesEmail(base);
    assert.equal(subject, '[WhatsappBot] Issue #104 closed: Match sent messages across JIDs');
  });

  it('truncates very long titles in the subject', () => {
    const { subject } = buildPostCloseChangesEmail({ ...base, title: 'x'.repeat(300) });
    assert.ok(subject.length <= 120, `subject too long: ${subject.length}`);
    assert.match(subject, /^\[WhatsappBot\] Issue #104 closed: x+…$/);
  });

  it('collapses newlines/whitespace in the title for the subject', () => {
    const { subject } = buildPostCloseChangesEmail({ ...base, title: '  Fix\n  the   thing ' });
    assert.equal(subject, '[WhatsappBot] Issue #104 closed: Fix the thing');
  });

  it('starts the text body with a deterministic header, then the summary unchanged', () => {
    const { text } = buildPostCloseChangesEmail(base);
    assert.equal(
      text,
      [
        'Issue #104: Match sent messages across JIDs',
        'Issue: https://github.com/o/r/issues/104',
        'Pull request: https://github.com/o/r/pull/109',
        '',
        '---',
        '',
        'The LLM summary.\n\n- point one',
      ].join('\n')
    );
  });

  it('omits the PR line when there is no PR', () => {
    const { text, html } = buildPostCloseChangesEmail({ ...base, prUrl: null });
    assert.doesNotMatch(text, /Pull request:/);
    assert.doesNotMatch(html, /Pull request/);
    assert.match(text, /^Issue #104: Match sent messages across JIDs\nIssue: https:\/\/github\.com\/o\/r\/issues\/104\n\n---\n\n/);
  });

  it('falls back gracefully when the title is missing', () => {
    for (const title of ['', '   ', undefined, null]) {
      const { subject, text, html } = buildPostCloseChangesEmail({ ...base, title });
      assert.equal(subject, '[WhatsappBot] Issue #104 closed — changes summary');
      assert.match(text, /^Issue #104\nIssue: /);
      assert.match(html, /Issue #104<\/h2>/);
      assert.doesNotMatch(html, /undefined|null/);
    }
  });

  it('starts the HTML body with an escaped header and links, then the summary', () => {
    const { html } = buildPostCloseChangesEmail({ ...base, title: 'Use <b> & "quotes"', summary: 'a < b' });
    const headerIdx = html.indexOf('Issue #104: Use &lt;b&gt; &amp; &quot;quotes&quot;');
    const summaryIdx = html.indexOf('<pre class="summary">a &lt; b</pre>');
    assert.ok(headerIdx > 0, 'header present');
    assert.ok(summaryIdx > headerIdx, 'summary follows header');
    assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/issues\/104">https:\/\/github\.com\/o\/r\/issues\/104<\/a>/);
    assert.match(html, /<a href="https:\/\/github\.com\/o\/r\/pull\/109">/);
  });
});
