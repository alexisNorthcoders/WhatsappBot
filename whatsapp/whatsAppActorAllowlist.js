/**
 * Who may run privileged bot actions (Claude agent, !restart, etc.).
 * Matches MY_PHONE / SECOND_PHONE with @c.us vs @s.whatsapp.net, digit match for PN JIDs,
 * and CLAUDE_AGENT_EXTRA_JIDS for @lid / other exact JIDs.
 *
 * Baileys 7.x delivers DMs from @lid identities. The owner is still recognised when either
 * the message key's alternate id (participantAlt / remoteJidAlt) is an allowed phone JID, or
 * the LID was resolved from MY_PHONE / SECOND_PHONE via the socket's LID mapping store at
 * connect (see resolveOwnerLids). Anything malformed or unresolved denies.
 */

/** User parts of owner @lid ids resolved from the LID mapping store; replaced on each connect. */
let ownerLidUsers = new Set();

function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

/** User part before @, strip :device and _agent suffixes (matches Baileys jidDecode user). */
function jidUserPart(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const at = jid.indexOf('@');
  if (at < 0) return '';
  const combined = jid.slice(0, at);
  const userAgent = combined.split(':')[0];
  return userAgent.split('_')[0] || '';
}

/** Phone digits for @s.whatsapp.net / @c.us only (not @lid). */
function phoneDigitsFromPnJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const server = jid.slice(jid.indexOf('@') + 1);
  if (server !== 's.whatsapp.net' && server !== 'c.us') return '';
  return digitsOnly(jidUserPart(jid));
}

/** User part of a well-formed @lid id (digits only), else ''. */
function lidUserPart(jid) {
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@lid')) return '';
  const user = jidUserPart(jid);
  return /^\d+$/.test(user) ? user : '';
}

function allowedPhoneDigitsSet() {
  const set = new Set();
  for (const raw of [process.env.MY_PHONE, process.env.SECOND_PHONE]) {
    const d = digitsOnly(raw);
    if (d) set.add(d);
  }
  return set;
}

function extraAllowedJids() {
  const raw = process.env.CLAUDE_AGENT_EXTRA_JIDS?.trim();
  if (!raw) return [];
  return raw.split(',').map((j) => j.trim()).filter(Boolean);
}

/** Baileys may use @s.whatsapp.net while .env sometimes stores @c.us — allow both for the same user id. */
function jidVariants(envValue) {
  const v = envValue?.trim();
  if (!v) return [];
  if (v.includes('@')) {
    const user = v.split('@')[0];
    if (!user) return [v];
    return [`${user}@s.whatsapp.net`, `${user}@c.us`];
  }
  return [`${v}@s.whatsapp.net`, `${v}@c.us`];
}

function allowedJidsExact() {
  return [...jidVariants(process.env.MY_PHONE), ...jidVariants(process.env.SECOND_PHONE), ...extraAllowedJids()];
}

/**
 * Who sent the message: in groups `remoteJid` is the group; use `participant`.
 * @param {import('@whiskeysockets/baileys').proto.WebMessageInfo} [msg]
 * @param {string} remoteJid
 */
export function actorJid(msg, remoteJid) {
  const p = msg?.key?.participant;
  if (p) return p;
  return remoteJid;
}

/**
 * The sender's alternate id from the message key: `participantAlt` in groups, `remoteJidAlt`
 * in DMs. Baileys 7.x fills it with the PN JID when the primary id is a LID (and vice versa).
 * @param {import('@whiskeysockets/baileys').proto.WebMessageInfo} [msg]
 * @returns {string | null}
 */
export function actorAltJid(msg) {
  const key = /** @type {Record<string, unknown> | undefined} */ (msg?.key);
  const alt = key?.participant ? key?.participantAlt : key?.remoteJidAlt;
  return typeof alt === 'string' && alt ? alt : null;
}

function matchesAllowedJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  const fromPn = phoneDigitsFromPnJid(jid);
  if (fromPn && allowedPhoneDigitsSet().has(fromPn)) return true;
  const lidUser = lidUserPart(jid);
  if (lidUser && ownerLidUsers.has(lidUser)) return true;
  return allowedJidsExact().includes(jid);
}

/**
 * @param {string | null | undefined} actorJid primary sender id
 * @param {string | null | undefined} [altJid] alternate sender id from the message key
 */
export function isAllowedActor(actorJid, altJid) {
  return matchesAllowedJid(actorJid) || matchesAllowedJid(altJid);
}

/**
 * Resolve the owner's LIDs from MY_PHONE / SECOND_PHONE via `sock.signalRepository.lidMapping`
 * (Baileys 7.x only; feature-detected). Replaces any previously resolved set, so a failed or
 * empty lookup leaves the owner LIDs unrecognised (deny). On 6.x the store is absent: no-op.
 * @param {any} sock
 * @param {{ logger?: { warn: Function, info: Function } }} [opts]
 */
export async function resolveOwnerLids(sock, { logger } = {}) {
  ownerLidUsers = new Set();
  const lidMapping = sock?.signalRepository?.lidMapping;
  if (typeof lidMapping?.getLIDForPN !== 'function') return;

  const next = new Set();
  for (const digits of allowedPhoneDigitsSet()) {
    try {
      const lid = await lidMapping.getLIDForPN(`${digits}@s.whatsapp.net`);
      const user = lidUserPart(lid);
      if (user) next.add(user);
      else logger?.warn({ phone: digits }, 'No LID mapping for owner phone');
    } catch (err) {
      logger?.warn({ err, phone: digits }, 'Owner LID lookup failed');
    }
  }
  ownerLidUsers = next;
  if (next.size) logger?.info({ count: next.size }, 'Resolved owner LIDs for the actor allowlist');
}

/** Hint for denied @lid senders (same env as Claude agent). */
export function lidExtraJidsHint(actorJid) {
  return actorJid?.endsWith('@lid')
    ? `\n\nAdd to .env:\nCLAUDE_AGENT_EXTRA_JIDS=${actorJid}`
    : '';
}
