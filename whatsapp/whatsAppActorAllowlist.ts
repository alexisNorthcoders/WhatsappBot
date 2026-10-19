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

import type { WAMessage } from '@whiskeysockets/baileys';
import type { Logger } from './types.ts';

/** The part of a Baileys 7.x socket that maps phone JIDs to LIDs; absent on 6.x. */
type LidLookupSocket = {
  signalRepository?: { lidMapping?: { getLIDForPN?: (pn: string) => Promise<unknown> } };
};

/**
 * User parts of owner @lid ids resolved from the LID mapping store, each mapped to the phone
 * digits it was resolved from; replaced on each v7 connect.
 */
let ownerLidUsers: Map<string, string> = new Map();

function digitsOnly(s: string | undefined): string {
  return String(s ?? '').replace(/\D/g, '');
}

/** User part before the `@`, strip :device and _agent suffixes (matches Baileys jidDecode user). */
function jidUserPart(jid: string): string {
  if (!jid || typeof jid !== 'string') return '';
  const at = jid.indexOf('@');
  if (at < 0) return '';
  const combined = jid.slice(0, at);
  const userAgent = combined.split(':')[0];
  return userAgent.split('_')[0] || '';
}

/** Phone digits for @s.whatsapp.net / @c.us only (not @lid). */
function phoneDigitsFromPnJid(jid: string | null | undefined): string {
  if (!jid || typeof jid !== 'string') return '';
  const server = jid.slice(jid.indexOf('@') + 1);
  if (server !== 's.whatsapp.net' && server !== 'c.us') return '';
  return digitsOnly(jidUserPart(jid));
}

/** User part of a well-formed @lid id (digits only), else ''. */
function lidUserPart(jid: unknown): string {
  if (!jid || typeof jid !== 'string' || !jid.endsWith('@lid')) return '';
  const user = jidUserPart(jid);
  return /^\d+$/.test(user) ? user : '';
}

function allowedPhoneDigitsSet() {
  const set = new Set<string>();
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
function jidVariants(envValue: string | undefined): string[] {
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
 */
export function actorJid(msg: WAMessage | undefined, remoteJid: string) {
  const p = msg?.key?.participant;
  if (p) return p;
  return remoteJid;
}

/**
 * The sender's alternate id from the message key: `participantAlt` in groups, `remoteJidAlt`
 * in DMs. Baileys 7.x fills it with the PN JID when the primary id is a LID (and vice versa).
 */
export function actorAltJid(msg?: WAMessage): string | null {
  const key = msg?.key;
  if (!key) return null;
  const { remoteJid, participant } = key;
  // A DM is decided by the chat id, not by `participant` (some DM keys carry it too). The
  // remoteJidAlt only describes the actor when the actor is the chat peer.
  const isDm = typeof remoteJid === 'string' && isDmJid(remoteJid);
  const actorIsPeer = !participant || participant === remoteJid;
  const alt = isDm && actorIsPeer ? key.remoteJidAlt : participant ? key.participantAlt : null;
  return typeof alt === 'string' && alt ? alt : null;
}

/** One-to-one chat ids (phone or LID); groups, broadcasts and newsletters are not DMs. */
function isDmJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@lid');
}

function matchesAllowedJid(jid: string | null | undefined): boolean {
  if (!jid || typeof jid !== 'string') return false;
  const fromPn = phoneDigitsFromPnJid(jid);
  if (fromPn && allowedPhoneDigitsSet().has(fromPn)) return true;
  const lidUser = lidUserPart(jid);
  if (lidUser && ownerLidUsers.has(lidUser)) return true;
  return allowedJidsExact().includes(jid);
}

/**
 * @param actorJid primary sender id
 * @param [altJid] alternate sender id from the message key
 */
export function isAllowedActor(actorJid: string | null | undefined, altJid?: string | null | undefined) {
  return matchesAllowedJid(actorJid) || matchesAllowedJid(altJid);
}

/**
 * Phone digits an actor id stands for: a phone JID's own, or those of the MY_PHONE /
 * SECOND_PHONE number a resolved owner LID maps from. '' when unknown.
 */
function phoneDigitsOf(jid: string | null | undefined) {
  return phoneDigitsFromPnJid(jid) || ownerLidUsers.get(lidUserPart(jid)) || '';
}

/**
 * SECOND_PHONE's phone JID when the actor is SECOND_PHONE (by phone JID, alternate id or a LID
 * resolved from it), else null. The owner (MY_PHONE, its LIDs, CLAUDE_AGENT_EXTRA_JIDS) and
 * strangers are null, as is SECOND_PHONE set to the owner's own number.
 */
export function secondPhoneJid(
  actorJid: string | null | undefined,
  altJid?: string | null | undefined,
): string | null {
  const second = digitsOnly(process.env.SECOND_PHONE);
  if (!second || second === digitsOnly(process.env.MY_PHONE)) return null;
  const isSecond = [actorJid, altJid].some((j) => j && phoneDigitsOf(j) === second);
  return isSecond ? `${second}@s.whatsapp.net` : null;
}

/**
 * Resolve the owner's LIDs from MY_PHONE / SECOND_PHONE via `sock.signalRepository.lidMapping`
 * (Baileys 7.x only; feature-detected). A lookup pass replaces any previously resolved set, so a
 * failed or empty lookup leaves the owner LIDs unrecognised (deny). On 6.x the store is absent:
 * no-op, and any previously resolved set is kept.
 */
export async function resolveOwnerLids(
  sock: LidLookupSocket | null | undefined,
  { logger }: { logger?: Pick<Logger, 'warn' | 'info'> } = {},
) {
  const lidMapping = sock?.signalRepository?.lidMapping;
  if (typeof lidMapping?.getLIDForPN !== 'function') return;

  const next = new Map<string, string>();
  for (const digits of allowedPhoneDigitsSet()) {
    try {
      const lid = await lidMapping.getLIDForPN(`${digits}@s.whatsapp.net`);
      const user = lidUserPart(lid);
      if (user) next.set(user, digits);
      else logger?.warn({ phone: digits }, 'No LID mapping for owner phone');
    } catch (err) {
      logger?.warn({ err, phone: digits }, 'Owner LID lookup failed');
    }
  }
  ownerLidUsers = next;
  if (next.size) logger?.info({ count: next.size }, 'Resolved owner LIDs for the actor allowlist');
}

/** Forget resolved owner LIDs (tests). */
export function clearOwnerLids() {
  ownerLidUsers = new Map();
}

/** Hint for denied @lid senders (same env as Claude agent). */
export function lidExtraJidsHint(actorJid: string | null): string {
  return actorJid?.endsWith('@lid')
    ? `\n\nAdd to .env:\nCLAUDE_AGENT_EXTRA_JIDS=${actorJid}`
    : '';
}
