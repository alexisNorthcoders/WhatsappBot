import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  actorAltJid,
  clearOwnerLids,
  isAllowedActor,
  resolveOwnerLids,
} from '../whatsapp/whatsAppActorAllowlist.js';
import { normalizeBaileysMessage } from '../whatsapp/orchestration/normalizeBaileysMessage.js';

const OWNER_PN = '447700900001@s.whatsapp.net';
const OWNER_LID = '123456789012345@lid';
const STRANGER_LID = '999999999999999@lid';

const ENV_KEYS = ['MY_PHONE', 'SECOND_PHONE', 'CLAUDE_AGENT_EXTRA_JIDS'];

/** Fake v7 socket exposing only the LID mapping store. */
function sockWithLidMapping(getLIDForPN) {
  return { signalRepository: { lidMapping: { getLIDForPN } } };
}

const silentLogger = { warn() {}, info() {} };

/** DM from a LID sender, optionally carrying the alternate PN id Baileys fills in. */
function lidDm({ remoteJid = OWNER_LID, remoteJidAlt } = {}) {
  return {
    key: { id: 'm1', remoteJid, fromMe: false, ...(remoteJidAlt ? { remoteJidAlt } : {}) },
    message: { conversation: 'claude hi' },
  };
}

/** Group message from a LID participant, optionally carrying participantAlt. */
function lidGroupMsg({ participant = OWNER_LID, participantAlt } = {}) {
  return {
    key: {
      id: 'g1',
      remoteJid: '120363000000000000@g.us',
      participant,
      fromMe: false,
      ...(participantAlt ? { participantAlt } : {}),
    },
    message: { conversation: '!restart' },
  };
}

describe('whatsAppActorAllowlist', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.MY_PHONE = '447700900001';
    clearOwnerLids();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    clearOwnerLids();
  });

  describe('existing behaviour', () => {
    it('allows the owner phone JID in both server forms', () => {
      assert.equal(isAllowedActor(OWNER_PN), true);
      assert.equal(isAllowedActor('447700900001@c.us'), true);
      assert.equal(isAllowedActor('447700900001:3@s.whatsapp.net'), true);
    });

    it('allows a hand-listed @lid from CLAUDE_AGENT_EXTRA_JIDS', () => {
      process.env.CLAUDE_AGENT_EXTRA_JIDS = STRANGER_LID;
      assert.equal(isAllowedActor(STRANGER_LID), true);
    });

    it('denies an unknown phone JID and a null actor', () => {
      assert.equal(isAllowedActor('447700900999@s.whatsapp.net'), false);
      assert.equal(isAllowedActor(null), false);
    });
  });

  describe('alternate id from the message key', () => {
    it('allows an @lid DM sender whose remoteJidAlt is the owner phone JID', () => {
      const m = normalizeBaileysMessage(lidDm({ remoteJidAlt: OWNER_PN }));
      assert.equal(m.actorId, OWNER_LID);
      assert.equal(m.actorAltId, OWNER_PN);
      assert.equal(isAllowedActor(m.actorId, m.actorAltId), true);
    });

    it('allows an @lid group participant whose participantAlt is the owner phone JID', () => {
      const m = normalizeBaileysMessage(lidGroupMsg({ participantAlt: OWNER_PN }));
      assert.equal(m.actorId, OWNER_LID);
      assert.equal(m.actorAltId, OWNER_PN);
      assert.equal(isAllowedActor(m.actorId, m.actorAltId), true);
    });

    it('ignores remoteJidAlt in groups (that is the group, not the sender)', () => {
      const raw = lidGroupMsg();
      raw.key.remoteJidAlt = OWNER_PN;
      const m = normalizeBaileysMessage(raw);
      assert.equal(m.actorAltId, null);
      assert.equal(isAllowedActor(m.actorId, m.actorAltId), false);
    });

    it('denies an @lid sender with no alternate id and no resolved mapping', () => {
      const m = normalizeBaileysMessage(lidDm());
      assert.equal(m.actorAltId, null);
      assert.equal(isAllowedActor(m.actorId, m.actorAltId), false);
    });

    it('denies an @lid sender whose alternate id is someone else', () => {
      const m = normalizeBaileysMessage(lidDm({ remoteJidAlt: '447700900999@s.whatsapp.net' }));
      assert.equal(isAllowedActor(m.actorId, m.actorAltId), false);
    });

    it('denies malformed alternate ids', () => {
      for (const alt of ['447700900001', '@s.whatsapp.net', '447700900001@lid', 'garbage', 42, {}]) {
        assert.equal(isAllowedActor(STRANGER_LID, /** @type {any} */ (alt)), false, String(alt));
      }
    });

    it('actorAltJid reads participantAlt in groups and remoteJidAlt in DMs', () => {
      assert.equal(actorAltJid(lidDm({ remoteJidAlt: OWNER_PN })), OWNER_PN);
      assert.equal(actorAltJid(lidGroupMsg({ participantAlt: OWNER_PN })), OWNER_PN);
      assert.equal(actorAltJid(lidDm()), null);
      assert.equal(actorAltJid(undefined), null);
    });

    it('actorAltJid reads remoteJidAlt for a DM whose key also carries participant', () => {
      const msg = lidDm({ remoteJidAlt: OWNER_PN });
      msg.key.participant = OWNER_LID;
      assert.equal(actorAltJid(msg), OWNER_PN);
    });

    it('actorAltJid ignores remoteJidAlt in groups and when the actor is not the DM peer', () => {
      const group = lidGroupMsg();
      group.key.remoteJidAlt = OWNER_PN;
      assert.equal(actorAltJid(group), null);
      const dm = lidDm({ remoteJidAlt: OWNER_PN });
      dm.key.participant = STRANGER_LID;
      assert.equal(actorAltJid(dm), null);
    });
  });

  describe('owner LIDs resolved from the LID mapping store', () => {
    it('allows a LID the store maps from MY_PHONE', async () => {
      const asked = [];
      await resolveOwnerLids(
        sockWithLidMapping(async (pn) => {
          asked.push(pn);
          return pn === OWNER_PN ? OWNER_LID : null;
        }),
        { logger: silentLogger },
      );
      assert.deepEqual(asked, [OWNER_PN]);
      assert.equal(isAllowedActor(OWNER_LID), true);
      assert.equal(isAllowedActor('123456789012345:2@lid'), true, 'device suffix');
      assert.equal(isAllowedActor(STRANGER_LID), false);
    });

    it('resolves SECOND_PHONE too', async () => {
      process.env.SECOND_PHONE = '447700900002';
      await resolveOwnerLids(
        sockWithLidMapping(async (pn) => (pn === '447700900002@s.whatsapp.net' ? STRANGER_LID : null)),
        { logger: silentLogger },
      );
      assert.equal(isAllowedActor(STRANGER_LID), true);
      assert.equal(isAllowedActor(OWNER_LID), false);
    });

    it('denies when the store lookup throws', async () => {
      await resolveOwnerLids(
        sockWithLidMapping(async () => {
          throw new Error('store unavailable');
        }),
        { logger: silentLogger },
      );
      assert.equal(isAllowedActor(OWNER_LID), false);
    });

    it('denies when the store returns nothing', async () => {
      for (const result of [null, undefined, '']) {
        await resolveOwnerLids(sockWithLidMapping(async () => result), { logger: silentLogger });
        assert.equal(isAllowedActor(OWNER_LID), false, String(result));
      }
    });

    it('ignores store results that are not @lid ids', async () => {
      for (const result of [OWNER_PN, 'abc@lid', '@lid', { lid: OWNER_LID }]) {
        await resolveOwnerLids(sockWithLidMapping(async () => result), { logger: silentLogger });
        assert.equal(isAllowedActor(OWNER_LID), false, JSON.stringify(result));
        assert.equal(isAllowedActor('abc@lid'), false);
      }
    });

    it('a failed re-resolve drops previously resolved LIDs', async () => {
      await resolveOwnerLids(sockWithLidMapping(async () => OWNER_LID), { logger: silentLogger });
      assert.equal(isAllowedActor(OWNER_LID), true);
      await resolveOwnerLids(
        sockWithLidMapping(async () => {
          throw new Error('boom');
        }),
        { logger: silentLogger },
      );
      assert.equal(isAllowedActor(OWNER_LID), false);
    });

    it('is a no-op on a 6.x socket with no LID mapping store', async () => {
      for (const sock of [{}, { signalRepository: {} }, { signalRepository: { lidMapping: {} } }, null]) {
        await resolveOwnerLids(sock, { logger: silentLogger });
        assert.equal(isAllowedActor(OWNER_LID), false);
        assert.equal(isAllowedActor(OWNER_PN), true);
      }
    });

    it('keeps previously resolved LIDs when reconnecting on a socket with no store', async () => {
      await resolveOwnerLids(sockWithLidMapping(async () => OWNER_LID), { logger: silentLogger });
      for (const sock of [{}, { signalRepository: {} }, null]) {
        await resolveOwnerLids(sock, { logger: silentLogger });
        assert.equal(isAllowedActor(OWNER_LID), true);
      }
    });

    it('does not query the store when no owner phone is configured', async () => {
      delete process.env.MY_PHONE;
      let called = false;
      await resolveOwnerLids(
        sockWithLidMapping(async () => {
          called = true;
          return OWNER_LID;
        }),
        { logger: silentLogger },
      );
      assert.equal(called, false);
      assert.equal(isAllowedActor(OWNER_LID), false);
    });
  });
});
