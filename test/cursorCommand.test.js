import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
  isCursorAgentBusy,
} from '../whatsapp/agents/cursorAgentBusy.js';
import cursorCommand from '../whatsapp/commands/cursor.js';

const SENDER = '15551234567@s.whatsapp.net';

describe('cursor command (manual)', () => {
  beforeEach(() => {
    process.env.MY_PHONE = '15551234567';
    if (isCursorAgentBusy()) {
      releaseAgentBusyLock();
    }
  });

  afterEach(() => {
    if (isCursorAgentBusy()) {
      releaseAgentBusyLock();
    }
  });

  it('rejects with a busy message when the single-agent lock is already held (freeform prompt)', async () => {
    const sent = [];
    const sock = {
      sendMessage: async (/** @type {string} */ jid, /** @type {{ text?: string }} */ content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    assert.equal(tryAcquireAgentBusyLock(), true);
    await cursorCommand(sock, SENDER, 'cursor fix the bug in auth', { key: {} });

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /busy/i);
    assert.equal(isCursorAgentBusy(), true);
  });
});
