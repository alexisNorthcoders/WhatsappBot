import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sdxlIterateCommand } from '../whatsapp/commands/sdxl.ts';

const JID = '15550001111@s.whatsapp.net';

describe('sdxlIterateCommand (sdxl+)', () => {
  it('sends usage when called with no change request after sdxl+', async () => {
    const texts: string[] = [];
    const sock = {
      sendMessage: async (_jid: string, content: { text?: string }) => {
        if (content?.text != null) texts.push(String(content.text));
      },
    };

    await sdxlIterateCommand(sock, JID, 'sdxl+');
    await sdxlIterateCommand(sock, JID, '  SDXL+  \t ');

    assert.equal(texts.length, 2);
    for (const t of texts) {
      assert.match(t, /SDXL refine/i);
      assert.match(t, /\*sdxl\+\* <what to change>/i);
    }
  });

  it('sends a friendly message when there is no last SDXL image for this chat', async () => {
    const texts: string[] = [];
    const sock = {
      sendMessage: async (_jid: string, content: { text?: string }) => {
        if (content?.text != null) texts.push(String(content.text));
      },
    };

    await sdxlIterateCommand(sock, JID, 'sdxl+ add more contrast');

    assert.equal(texts.length, 1);
    assert.match(texts[0], /No recent SDXL image/i);
    assert.match(texts[0], /sdxl/i);
    assert.match(texts[0], /filename\.png/i);
  });
});
