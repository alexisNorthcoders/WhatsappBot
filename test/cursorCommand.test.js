import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
  isCursorAgentBusy,
} from '../whatsapp/agents/cursorAgentBusy.js';
import cursorCommand from '../whatsapp/commands/cursor.js';

const SENDER = '15551234567@s.whatsapp.net';

const GROUP_JID = '120363123456@g.us';

/** Mimics Baileys `msg` shape for a group relay (`sender` is the group; participant is the actor). */
function productionLikeGroupMsg() {
  return {
    key: {
      remoteJid: GROUP_JID,
      fromMe: false,
      participant: '15551234567@s.whatsapp.net',
      id: 'ABC123',
    },
    messageStubParameters: [],
  };
}

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
    try {
      await cursorCommand(sock, SENDER, 'cursor fix the bug in auth', { key: {} });

      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /busy/i);
      assert.equal(isCursorAgentBusy(), true);
    } finally {
      releaseAgentBusyLock();
    }
  });

  it('rejects busy for cursor issue:… shape with production-like msg metadata (before pipeline)', async () => {
    const sent = [];
    const sock = {
      sendMessage: async (/** @type {string} */ jid, /** @type {{ text?: string }} */ content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    assert.equal(tryAcquireAgentBusyLock(), true);
    try {
      await cursorCommand(sock, GROUP_JID, 'cursor issue:88 add regression coverage', productionLikeGroupMsg());

      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /busy/i);
      assert.equal(isCursorAgentBusy(), true);
    } finally {
      releaseAgentBusyLock();
    }
  });
});
