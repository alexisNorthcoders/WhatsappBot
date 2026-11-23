import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { getRepoRoot } from '../repoRoot.ts';
import type { BookCatalog, Title } from './bookCatalog.ts';

/**
 * The owner's reading profile: what they've read, loved or didn't finish (their shelf), and what
 * the bot recommended lately. Recommendations leave out everything on the shelf and anything
 * recommended in the last RECENT_DAYS, and open asks start from what they loved. Kept in
 * WhatsappBot's own storage (BOOK_PROFILE_FILE), never in reddit-bot's database.
 */

export type ShelfStatus = 'read' | 'loved' | 'dnf';
export type ShelfEntry = { id: number; title: string; status: ShelfStatus; at: number };
export type RecentPick = { id: number; title: string; at: number };
export type ReadingProfile = { shelf: ShelfEntry[]; recent: RecentPick[] };
export type ReadingProfileStore = { load: () => Promise<ReadingProfile>; save: (p: ReadingProfile) => Promise<void> };

export const RECENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT = 60;

export function readingProfilePath(): string {
  return process.env.BOOK_PROFILE_FILE?.trim() || join(getRepoRoot(), 'logs', 'books', 'profile.json');
}

export function fileReadingProfileStore(filePath = readingProfilePath()): ReadingProfileStore {
  return {
    async load() {
      let raw;
      try {
        raw = await fs.readFile(filePath, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { shelf: [], recent: [] };
        throw e;
      }
      const { shelf, recent } = JSON.parse(raw) ?? {};
      return { shelf: Array.isArray(shelf) ? shelf : [], recent: Array.isArray(recent) ? recent : [] };
    },
    /** Atomic write (tmp + rename) so a crash never leaves a half-written profile. */
    async save(p) {
      await fs.mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, ...p }, null, 2), 'utf8');
      await fs.rename(tmp, filePath);
    },
  };
}

const STATUS_RANK: Record<ShelfStatus, number> = { dnf: 0, read: 1, loved: 2 };

/**
 * The profile with ids that a catalog Merge absorbed pointed at their Survivor, or null when
 * nothing changed. A shelf pair that now shares an id keeps the more advanced status (loved over
 * read over dnf); `recent` keeps the first occurrence, with the newest `at` so the exclusion window isn't cut short. Ids the catalog doesn't know stay as they are.
 */
export function remapMerged(p: ReadingProfile, catalog: Pick<BookCatalog, 'survivorOf' | 'title'>): ReadingProfile | null {
  let changed = false;
  const remap = <T extends { id: number; title: string }>(e: T): T => {
    const survivor = catalog.survivorOf(e.id);
    if (survivor === null || survivor === e.id) return e;
    changed = true;
    return { ...e, id: survivor, title: catalog.title(survivor)?.title ?? e.title };
  };
  const shelf = new Map<number, ShelfEntry>();
  for (const e of p.shelf.map(remap)) {
    const kept = shelf.get(e.id);
    if (!kept || STATUS_RANK[e.status] > STATUS_RANK[kept.status]) shelf.set(e.id, e);
  }
  const latest = new Map<number, RecentPick>();
  for (const r of p.recent.map(remap)) {
    const kept = latest.get(r.id);
    if (!kept) latest.set(r.id, r);
    else if (r.at > kept.at) latest.set(r.id, { ...kept, at: r.at });
  }
  const recent = [...latest.values()];
  if (shelf.size !== p.shelf.length || recent.length !== p.recent.length) changed = true;
  return changed ? { ...p, shelf: [...shelf.values()], recent } : null;
}

/** A store whose `load` remaps Merged ids first and saves the profile only if that changed it. */
export function mergeAwareStore(store: ReadingProfileStore, catalog: Pick<BookCatalog, 'survivorOf' | 'title'>): ReadingProfileStore {
  return {
    ...store,
    async load() {
      const p = await store.load();
      const remapped = remapMerged(p, catalog);
      if (!remapped) return p;
      await store.save(remapped);
      return remapped;
    },
  };
}

/** Title ids a recommendation must leave out: the whole shelf, and recent picks. */
export function excludedIds(p: ReadingProfile, nowMs: number) {
  return [...p.shelf.map((e) => e.id), ...p.recent.filter((r) => nowMs - r.at < RECENT_DAYS * DAY_MS).map((r) => r.id)];
}

export const lovedIds = (p: ReadingProfile) => p.shelf.filter((e) => e.status === 'loved').map((e) => e.id);

export function withPicks(p: ReadingProfile, picks: Title[], nowMs: number): ReadingProfile {
  const fresh = picks.map((t) => ({ id: t.id, title: t.title, at: nowMs }));
  const kept = p.recent.filter((r) => nowMs - r.at < RECENT_DAYS * DAY_MS && !picks.some((t) => t.id === r.id));
  return { ...p, recent: [...kept, ...fresh].slice(-MAX_RECENT) };
}

export type ProfileCommand =
  | { kind: 'shelve'; status: ShelfStatus; names: string[] }
  | { kind: 'forget'; names: string[] }
  | { kind: 'show' }
  | { kind: 'clear' };

const SHELF = String.raw`(?:reading\s+profile|reading\s+history|bookshelf|book\s+shelf|shelf)`;
const SHOW = new RegExp(String.raw`^(?:(?:show|list|see)\s+)?(?:me\s+)?my\s+${SHELF}$|^what(?:\s+books)?\s+have\s+i\s+(?:read|told\s+you\s+i(?:'ve|’ve|\s+have)\s+read)$`, 'i');
const CLEAR = new RegExp(String.raw`^(?:clear|reset|wipe|empty)\s+my\s+${SHELF}$`, 'i');
const FORGET = new RegExp(String.raw`^(?:forget|remove)\s+(.+?)\s+from\s+my\s+${SHELF}$`, 'i');
const SHELVE = new RegExp(String.raw`^(${[
  String.raw`i\s*(?:'ve|’ve|\s+have)\s+(?:already\s+|just\s+)?(?:read|finished)`,
  String.raw`i\s+(?:already|just)\s+(?:read|finished)`,
  String.raw`already\s+read`,
  String.raw`(?:i\s+)?finished`,
  String.raw`(?:i\s+(?:really\s+)?)?loved`,
  String.raw`(?:i\s+)?dnf(?:'?d|ed)?`,
  String.raw`(?:i\s+)?did\s*n[o'’]?t\s+finish`,
  String.raw`(?:i\s+)?gave\s+up\s+on`,
].join('|')})\s+(.+)$`, 'i');
/** A message asking for something is a request, even if it starts like a shelf statement. */
const ASKING = /\?|\b(?:recommend|suggest|what|something|anything|similar|next|should)\b/i;

function statusOf(verb: string): ShelfStatus {
  const v = verb.toLowerCase();
  if (/\blov/.test(v)) return 'loved';
  if (/\b(?:dnf|did|gave)/.test(v)) return 'dnf';
  return 'read';
}

/** "Mistborn, Piranesi and Earthsea" → three names; a lone "Shadow and Bone" stays whole (see resolveNames). */
function splitNames(list: string) {
  return list.replace(/[.!]+$/, '').split(/\s*[,;]\s*|\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
}

export function parseProfileCommand(text: string): ProfileCommand | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (SHOW.test(t.replace(/[?.!]+$/, ''))) return { kind: 'show' };
  if (CLEAR.test(t.replace(/[.!]+$/, ''))) return { kind: 'clear' };
  const forget = t.replace(/[.!]+$/, '').match(FORGET);
  if (forget) return { kind: 'forget', names: splitNames(forget[1]!) };
  if (ASKING.test(t)) return null;
  const shelve = t.match(SHELVE);
  return shelve ? { kind: 'shelve', status: statusOf(shelve[1]!), names: splitNames(shelve[2]!) } : null;
}

/** Each name's Title; a name that doesn't resolve but holds " and " is tried as two names. */
function resolveNames(names: string[], catalog: Pick<BookCatalog, 'find'>) {
  const found: Title[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const whole = catalog.find(name);
    if (whole) {
      found.push(whole);
      continue;
    }
    const parts = name.split(/\s+(?:and|&)\s+/i);
    const each = parts.length > 1 ? parts.map((p) => catalog.find(p)) : [null];
    if (each.every((x) => x)) found.push(...(each as Title[]));
    else unknown.push(name);
  }
  return { found, unknown };
}

const LABEL: Record<ShelfStatus, string> = { loved: 'Loved', read: 'Read', dnf: "Didn't finish" };

export function formatProfile(p: ReadingProfile) {
  if (!p.shelf.length) return 'Your reading profile is empty. Tell me "I\'ve read X", "loved X" or "DNF X".';
  const groups = (['loved', 'read', 'dnf'] as const)
    .map((s) => [s, p.shelf.filter((e) => e.status === s)] as const)
    .filter(([, es]) => es.length)
    .map(([s, es]) => `*${LABEL[s]}:* ${es.map((e) => e.title).join(', ')}`);
  const recent = p.recent.length ? [`I've recommended ${p.recent.length} titles in the last ${RECENT_DAYS} days and won't repeat them.`] : [];
  return [...groups, ...recent].join('\n');
}

/**
 * Handles reading-profile messages. Returns the reply, or null when the message isn't one (or
 * names nothing in the catalog, as in "I read your message"), so the recommender gets it.
 */
export function createReadingProfile({ store, catalog, now = Date.now }: {
  store: ReadingProfileStore;
  catalog: Pick<BookCatalog, 'find'>;
  now?: () => number;
}) {
  return async function handle(text: string): Promise<string | null> {
    const cmd = parseProfileCommand(text);
    if (!cmd) return null;
    const p = await store.load();
    if (cmd.kind === 'show') return formatProfile(p);
    if (cmd.kind === 'clear') {
      await store.save({ shelf: [], recent: [] });
      return 'Cleared your reading profile and the list of recent recommendations.';
    }
    const { found, unknown } = resolveNames(cmd.names, catalog);
    const notes = unknown.map((n) => `I don't have data on ${n}.`);
    if (cmd.kind === 'forget') {
      const ids = new Set(found.map((t) => t.id));
      const removed = p.shelf.filter((e) => ids.has(e.id));
      await store.save({ ...p, shelf: p.shelf.filter((e) => !ids.has(e.id)) });
      return [...notes, removed.length ? `Removed ${removed.map((e) => e.title).join(', ')}.` : 'None of those were on your reading profile.'].join('\n');
    }
    if (!found.length) return null;
    const ids = new Set(found.map((t) => t.id));
    const added = found.map((t) => ({ id: t.id, title: t.title, status: cmd.status, at: now() }));
    await store.save({ ...p, shelf: [...p.shelf.filter((e) => !ids.has(e.id)), ...added] });
    const verb = { loved: 'loved', read: 'read', dnf: "didn't finish" }[cmd.status];
    return [...notes, `Noted: you ${verb} ${found.map((t) => `*${t.title}*`).join(', ')}. I won't recommend ${found.length > 1 ? 'them' : 'it'}${cmd.status === 'loved' ? ', and open asks will start from it' : ''}.`].join('\n');
  };
}
