import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import helpCommand from '../whatsapp/commands/help.js';
import { SUMMARIZE_USAGE } from '../whatsapp/utils/summarizeArgs.js';

describe('help command text', () => {
  it('includes the summarize usage aligned with SUMMARIZE_USAGE ([extra])', async () => {
    /** @type {string[]} */
    const texts = [];
    const sock = {
      sendMessage: async (/** @type {string} */ _jid, /** @type {{ text?: string }} */ content) => {
        texts.push(String(content?.text ?? ''));
      },
    };

    await helpCommand(sock, '15551234567@s.whatsapp.net');

    assert.equal(texts.length, 1);
    const helpText = texts[0];
    assert.match(
      helpText,
      /\*summarize\*\|\*summarise\* <url> \[extra\]/,
      'help bullet should use [extra] like parse errors',
    );
    assert.match(
      helpText,
      /Optional focus text after the URL/,
      'help should explain what [extra] means',
    );
    assert.match(
      helpText,
      /\*sdxl\+\*/,
      'help should include the SDXL refine command',
    );
    assert.equal(
      SUMMARIZE_USAGE,
      'Usage: *summarize*|*summarise* <url> [extra]',
    );
  });
});
