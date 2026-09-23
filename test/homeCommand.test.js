import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import homeCommand, { homeInjectedDeps } from '../whatsapp/commands/home.js';

function fakeSock() {
  const sent = [];
  return {
    sock: {
      sendMessage: async (chatId, content) => {
        sent.push({ chatId, ...content });
      },
    },
    sent,
  };
}

describe('home command', () => {
  it('sends the question to the service and replies with answer + Sources', async () => {
    const { sock, sent } = fakeSock();
    const askHomeManuals = async (question) => {
      assert.equal(question, 'what model is the oven?');
      return {
        ok: true,
        answer: 'It is a Neff slide & hide.',
        sources: [{ item: 'Oven', manual: 'Neff Manual', page: 12 }],
      };
    };

    await homeCommand(
      sock,
      'chat@s.whatsapp.net',
      'home what model is the oven?',
      homeInjectedDeps({ askHomeManuals }),
    );

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /It is a Neff slide & hide\./);
    assert.match(sent[0].text, /Sources:/);
    assert.match(sent[0].text, /Neff Manual, p\. 12/);
  });

  it('replies with a short error when the service is down', async () => {
    const { sock, sent } = fakeSock();
    const askHomeManuals = async () => ({ ok: false, reason: 'error', error: new Error('down') });

    await homeCommand(sock, 'chat@s.whatsapp.net', 'home what boiler do we have?', homeInjectedDeps({ askHomeManuals }));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /down/i);
  });

  it('explains when HOME_MANUALS_URL is not configured', async () => {
    const { sock, sent } = fakeSock();
    const askHomeManuals = async () => ({ ok: false, reason: 'not_configured' });

    await homeCommand(sock, 'chat@s.whatsapp.net', 'home what boiler do we have?', homeInjectedDeps({ askHomeManuals }));

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /not configured/i);
    assert.match(sent[0].text, /HOME_MANUALS_URL/);
  });

  it('shows usage when no question is given', async () => {
    const { sock, sent } = fakeSock();
    await homeCommand(sock, 'chat@s.whatsapp.net', 'home', homeInjectedDeps({}));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Usage: home <question>/);
  });
});
