import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
  isClaudeAgentBusy,
} from '../whatsapp/agents/claudeAgentBusy.js';
import { resolveWorkspaceFromAlias, clearWorkspaceAllowlistCache } from '../whatsapp/claudeWorkspaces.js';
import claudeCommand from '../whatsapp/commands/claude.js';

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

describe('claude command (manual)', () => {
  beforeEach(() => {
    process.env.MY_PHONE = '15551234567';
    if (isClaudeAgentBusy()) {
      releaseAgentBusyLock();
    }
  });

  afterEach(() => {
    if (isClaudeAgentBusy()) {
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
      await claudeCommand(sock, SENDER, 'claude fix the bug in auth', { key: {} });

      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /busy/i);
      assert.equal(isClaudeAgentBusy(), true);
    } finally {
      releaseAgentBusyLock();
    }
  });

  it('rejects busy for claude issue:… shape with production-like msg metadata (before pipeline)', async () => {
    const sent = [];
    const sock = {
      sendMessage: async (/** @type {string} */ jid, /** @type {{ text?: string }} */ content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };

    assert.equal(tryAcquireAgentBusyLock(), true);
    try {
      await claudeCommand(sock, GROUP_JID, 'claude issue:88 add regression coverage', productionLikeGroupMsg());

      assert.equal(sent.length, 1);
      assert.match(sent[0].text, /busy/i);
      assert.equal(isClaudeAgentBusy(), true);
    } finally {
      releaseAgentBusyLock();
    }
  });
});

// Pausing itself is set/cleared with `node claudeAgentPauseCli.js pause|resume` (or raw
// redis-cli) on the Pi, not through WhatsApp — see claudeAgentPauseCli.js. This command only
// needs to *check* the flag and refuse to run against a paused workspace.
describe('claude command (refuses a paused workspace)', () => {
  beforeEach(() => {
    process.env.MY_PHONE = '15551234567';
    if (isClaudeAgentBusy()) {
      releaseAgentBusyLock();
    }
  });

  afterEach(() => {
    if (isClaudeAgentBusy()) {
      releaseAgentBusyLock();
    }
  });

  function makeSock() {
    const sent = [];
    return {
      sent,
      sendMessage: async (jid, content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };
  }

  it('refuses a freeform run when the resolved workspace is paused, without holding the busy lock', async () => {
    const sock = makeSock();
    await claudeCommand(sock, SENDER, 'claude fix the bug in auth', { key: {} }, {
      getAgentPauseForWorkspace: async () => ({
        pausedAt: '2026-01-01T00:00:00Z',
        reason: 'manual git surgery',
        ttlRemainingSeconds: 300,
      }),
    });

    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0].text, /paused/i);
    assert.match(sock.sent[0].text, /manual git surgery/);
    assert.match(sock.sent[0].text, /claudeAgentPauseCli\.js resume/);
    assert.equal(isClaudeAgentBusy(), false, 'a paused refusal must release the busy lock');
  });

  it('respects an alias-resolved workspace when checking the pause flag', async () => {
    const root = process.cwd();
    process.env.CLAUDE_WORKSPACE_MAP = `testalias=${root}`;
    clearWorkspaceAllowlistCache();
    try {
      const sock = makeSock();
      const expectedRoot = await resolveWorkspaceFromAlias('testalias');
      let checkedRoot = null;
      await claudeCommand(sock, SENDER, 'claude testalias: fix the bug', { key: {} }, {
        getAgentPauseForWorkspace: async ({ workspaceRoot }) => {
          checkedRoot = workspaceRoot;
          return { pausedAt: '2026-01-01T00:00:00Z', reason: 'manual git surgery', ttlRemainingSeconds: null };
        },
      });
      assert.equal(checkedRoot, expectedRoot);
      assert.match(sock.sent[0].text, /paused/i);
    } finally {
      delete process.env.CLAUDE_WORKSPACE_MAP;
      clearWorkspaceAllowlistCache();
    }
  });
});
