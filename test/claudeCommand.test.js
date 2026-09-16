import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  tryAcquireAgentBusyLock,
  releaseAgentBusyLock,
  isClaudeAgentBusy,
} from '../whatsapp/agents/claudeAgentBusy.js';
import { getDefaultWorkspaceRoot, clearWorkspaceAllowlistCache } from '../whatsapp/claudeWorkspaces.js';
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

describe('claude command (pause / resume)', () => {
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

  it('pause with no args uses the default TTL/reason and does not touch the busy lock', async () => {
    const sock = makeSock();
    let pauseCall = null;
    await claudeCommand(sock, SENDER, 'claude pause', { key: {} }, {
      pauseAgentForWorkspace: async (opts) => {
        pauseCall = opts;
        return { pausedAt: '2026-01-01T00:00:00Z', reason: 'manual work in progress', ttlSeconds: 7200 };
      },
    });

    const expectedRoot = await getDefaultWorkspaceRoot();
    assert.equal(pauseCall.workspaceRoot, expectedRoot);
    assert.equal(pauseCall.reason, '');
    assert.equal(pauseCall.ttlSeconds, 7200);
    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0].text, /paused/i);
    assert.match(sock.sent[0].text, /2h/);
    assert.match(sock.sent[0].text, /claude resume/);
    assert.equal(isClaudeAgentBusy(), false, 'pause/resume must not touch the single-flight busy lock');
  });

  it('pause parses a leading duration token and treats the rest as the reason', async () => {
    const sock = makeSock();
    let pauseCall = null;
    await claudeCommand(sock, SENDER, 'claude pause 3h working on issue 90 by hand', { key: {} }, {
      pauseAgentForWorkspace: async (opts) => {
        pauseCall = opts;
        return { pausedAt: '2026-01-01T00:00:00Z', reason: opts.reason, ttlSeconds: opts.ttlSeconds };
      },
    });

    assert.equal(pauseCall.ttlSeconds, 10800);
    assert.equal(pauseCall.reason, 'working on issue 90 by hand');
    assert.match(sock.sent[0].text, /3h/);
    assert.match(sock.sent[0].text, /working on issue 90 by hand/);
  });

  it('resume clears the pause and confirms', async () => {
    const sock = makeSock();
    let resumeCall = null;
    await claudeCommand(sock, SENDER, 'claude resume', { key: {} }, {
      resumeAgentForWorkspace: async (opts) => {
        resumeCall = opts;
        return true;
      },
    });

    const expectedRoot = await getDefaultWorkspaceRoot();
    assert.equal(resumeCall.workspaceRoot, expectedRoot);
    assert.match(sock.sent[0].text, /resumed/i);
  });

  it('resume reports when there was nothing to clear', async () => {
    const sock = makeSock();
    await claudeCommand(sock, SENDER, 'claude resume', { key: {} }, {
      resumeAgentForWorkspace: async () => false,
    });
    assert.match(sock.sent[0].text, /no active pause/i);
  });

  it('refuses a freeform run when the resolved workspace is paused, without acquiring the busy lock', async () => {
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
    assert.match(sock.sent[0].text, /claude resume/);
    assert.equal(isClaudeAgentBusy(), false, 'a paused refusal must release the busy lock');
  });

  it('pause/resume compose with an alias workspace prefix', async () => {
    const root = process.cwd();
    process.env.CLAUDE_WORKSPACE_MAP = `testalias=${root}`;
    clearWorkspaceAllowlistCache();
    try {
      const sock = makeSock();
      let pauseCall = null;
      await claudeCommand(sock, SENDER, 'claude testalias: pause 30m', { key: {} }, {
        pauseAgentForWorkspace: async (opts) => {
          pauseCall = opts;
          return { pausedAt: '2026-01-01T00:00:00Z', reason: '', ttlSeconds: opts.ttlSeconds };
        },
      });
      assert.equal(pauseCall.ttlSeconds, 1800);
      assert.match(sock.sent[0].text, /claude testalias: resume/);
    } finally {
      delete process.env.CLAUDE_WORKSPACE_MAP;
      clearWorkspaceAllowlistCache();
    }
  });
});
