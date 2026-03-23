/**
 * Who may run privileged bot actions (Cursor agent, !restart, etc.).
 * Matches MY_PHONE / SECOND_PHONE with @c.us vs @s.whatsapp.net, digit match for PN JIDs,
 * and CURSOR_AGENT_EXTRA_JIDS for @lid / other exact JIDs.
 */

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

function allowedPhoneDigitsSet() {
  const set = new Set();
  for (const raw of [process.env.MY_PHONE, process.env.SECOND_PHONE]) {
    const d = digitsOnly(raw);
    if (d) set.add(d);
  }
  return set;
}

function extraAllowedJids() {
  const raw = process.env.CURSOR_AGENT_EXTRA_JIDS?.trim();
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

export function isAllowedActor(actorJid) {
  const phones = allowedPhoneDigitsSet();
  const fromPn = phoneDigitsFromPnJid(actorJid);
  if (fromPn && phones.has(fromPn)) return true;
  return allowedJidsExact().includes(actorJid);
}

/** Hint for denied @lid senders (same env as Cursor agent). */
export function lidExtraJidsHint(actorJid) {
  return actorJid?.endsWith('@lid')
    ? `\n\nAdd to .env:\nCURSOR_AGENT_EXTRA_JIDS=${actorJid}`
    : '';
}
