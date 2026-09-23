import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatHomeAnswerReply } from '../whatsapp/utils/formatHomeAnswer.js';

describe('formatHomeAnswerReply', () => {
  it('returns the answer alone when there are no sources', () => {
    const out = formatHomeAnswerReply('It is a Worcester Bosch Greenstar.', []);
    assert.equal(out, 'It is a Worcester Bosch Greenstar.');
  });

  it('appends a Sources section with item, manual and page', () => {
    const out = formatHomeAnswerReply('It is a Worcester Bosch Greenstar.', [
      { item: 'Boiler', manual: 'Worcester Bosch Manual', page: 4 },
    ]);
    assert.equal(
      out,
      'It is a Worcester Bosch Greenstar.\n\nSources:\n• Boiler — Worcester Bosch Manual, p. 4',
    );
  });

  it('formats a source without a page', () => {
    const out = formatHomeAnswerReply('answer', [{ item: 'Oven', manual: 'Oven Manual' }]);
    assert.match(out, /• Oven — Oven Manual$/);
  });

  it('formats multiple sources, one per line', () => {
    const out = formatHomeAnswerReply('answer', [
      { item: 'Boiler', manual: 'Boiler Manual', page: 1 },
      { item: 'Thermostat', manual: 'Thermostat Manual', page: 2 },
    ]);
    assert.equal(
      out,
      'answer\n\nSources:\n• Boiler — Boiler Manual, p. 1\n• Thermostat — Thermostat Manual, p. 2',
    );
  });

  it('truncates to the WhatsApp message limit', () => {
    const longAnswer = 'x'.repeat(5000);
    const out = formatHomeAnswerReply(longAnswer, []);
    assert.equal(out.length, 4096);
    assert.ok(out.endsWith('…'));
  });
});
