import type { BookCatalog, Candidate, Title, VocabularyTag } from './bookCatalog.ts';
import { excludedIds, lovedIds, withPicks, type ReadingProfileStore } from './readingProfile.ts';
import type { Logger } from '../types.ts';

export type BookRequest = {
  anchors: string[];
  genre: string | null;
  /** Wanted Title tags (`facet:tag`) for modifiers such as "but darker" or "standalone". */
  tags: string[];
  excludeTitles: string[];
  excludeAuthors: string[];
};

export type BookPick = { candidate: Candidate; reason: string };

export type Recommendation = { kind: 'not_a_request' } | { kind: 'answer'; text: string; picks: BookPick[] };

/** Which model answered: the guard against invented tags applies only to the mini PC's parse. */
export type Backend = 'minipc' | 'claude';
export type Completion = { text: string; backend: Backend };
export type Complete = (prompt: string) => Promise<Completion>;

const MAX_PICKS = 3;
const SHORTLIST = 20;
/** With fewer candidates than this the picker has no real choice, so say there's not enough data. */
const MIN_CANDIDATES = 3;
const MAX_REASON_CHARS = 300;
const MAX_TAGS = 4;

export const NOT_ENOUGH_DATA =
  "Not enough data: r/Fantasy hasn't discussed enough books matching that for me to recommend any with confidence.";

/** The JSON object in a model reply, ignoring any reasoning or prose around it. */
function jsonObject(raw: string): Record<string, unknown> | null {
  const match = raw.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[0]);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const strings = (v: unknown) =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());

export function buildParsePrompt(question: string, genres: string[], vocabulary: VocabularyTag[] = []) {
  const tagLine = vocabulary.length
    ? `\n- tags: up to ${MAX_TAGS} of these tags for qualities the reader explicitly asks for in their own words (a mood, tone, trope, format such as standalone, length, romance level or subgenre), else []. Never describe the named books themselves: "like Stormlight" → [], "like Mistborn but darker" → ["tone:dark"], "like First Law but funnier" → ["tone:humorous"], "less romance" → ["romance:none"], "a finished series" → ["status:complete"]. Most "like X" requests have no tags. Tags:${vocabulary.map((v) => `${v.tag} (${v.description})`).join('; ')}`
    : '';
  return `You read a message from a fantasy reader and decide whether it asks for book recommendations. Reply with one JSON object only, no prose.

If it asks for Books or Series to read (including open asks like "what should I read next?"), reply:
{"anchors": string[], "genre": string | null, ${vocabulary.length ? '"tags": string[], ' : ''}"excludeTitles": string[], "excludeAuthors": string[]}
- anchors: Books or Series named as reference points ("like Mistborn" → ["Mistborn"]; "Hobb's books" → ["Realm of the Elderlings"]), else []. Expand abbreviations (WoT → The Wheel of Time, ASOIAF → A Song of Ice and Fire).
- genre: one of ${genres.join(', ')} when the reader clearly asks for one, else null.${tagLine}
- excludeTitles / excludeAuthors: Books or authors the reader doesn't want (already read, dislikes), else [].

If it doesn't ask for something to read (a statement, a question about a book's plot or author, chit-chat), reply:
{"notRequest": true}

Message: ${JSON.stringify(question)}`;
}

/** Validate the parse reply. Anything malformed counts as not a request, so the chain moves on. */
export function parseRequest(raw: string, genres: string[], vocabulary: VocabularyTag[] = []): BookRequest | null {
  const j = jsonObject(raw);
  if (!j || j.notRequest === true) return null;
  const genre = typeof j.genre === 'string' ? j.genre.trim().toLowerCase() : null;
  const known = new Set(vocabulary.map((v) => v.tag));
  return {
    anchors: strings(j.anchors),
    genre: genre && genres.includes(genre) ? genre : null,
    tags: [...new Set(strings(j.tags).map((t) => t.toLowerCase()))].filter((t) => known.has(t)).slice(0, MAX_TAGS),
    excludeTitles: strings(j.excludeTitles),
    excludeAuthors: strings(j.excludeAuthors),
  };
}

/**
 * Some parse models (qwen3-30b-a3b) describe the named Books instead of the reader's wishes:
 * "what should I read after Cradle?" came back as grimdark, dark and bleak. So with resolved
 * anchors, drop the tags an anchor already carries and the genre. The cost: "like First Law but
 * darker" loses `tone:dark` because First Law is dark, and "like Mistborn but sci-fi" loses
 * the genre; the shortlist is then the anchors' neighbours, as for a plain "like X".
 */
export function guardAgainstAnchors(request: BookRequest, anchors: Title[], catalog: Pick<BookCatalog, 'tagsOf'>): BookRequest {
  if (!anchors.length) return request;
  const own = new Set(anchors.flatMap((a) => catalog.tagsOf(a.id)));
  const tags = request.tags.filter((t) => !own.has(t));
  if (request.genre === null && tags.length === request.tags.length) return request;
  return { ...request, genre: null, tags };
}

/** A loved author may appear in an open ask's answer, but only once: keep their first pick, drop the rest. */
export function atMostOneBy(authors: string[], picks: BookPick[]): BookPick[] {
  const lovedAuthor = (p: BookPick) => !!p.candidate.author && authors.includes(p.candidate.author);
  const first = picks.find(lovedAuthor);
  return picks.filter((p) => p === first || !lovedAuthor(p));
}

export function buildPickPrompt(
  question: string,
  shortlist: Candidate[],
  { tags = [], loved = [] }: { tags?: string[]; loved?: { title: string; author: string | null }[] } = {},
) {
  const candidates = shortlist.map((c) => ({
    id: c.id,
    title: c.title,
    author: c.author,
    kind: c.kind,
    genre: c.genre,
    mentions: c.mentions,
    positive: c.positive,
    negative: c.negative,
    shared_threads_with_named_books: c.sharedThreads,
    tags: c.tags.length ? c.tags : undefined,
    ...(c.dossier ? { what_redditors_say: c.dossier } : { what_redditors_said: c.excerpts }),
  }));
  const wanted = tags.length ? `\n- The reader asked for: ${tags.join(', ')}. Prefer candidates whose tags or dossier show it; never pick one whose tags contradict it.` : '';
  const lovedAuthors = [...new Set(loved.flatMap((l) => l.author ?? []))];
  const lovedLine = loved.length
    ? `\n- The reader loved ${loved.map((l) => l.title).join(', ')}; candidates were drawn from what's discussed alongside those.${lovedAuthors.length ? ` Pick at most one book by ${lovedAuthors.join(' or ')}.` : ''}`
    : '';
  return `You pick book recommendations for a reader from a shortlist built from r/Fantasy discussion. Reply with one JSON object only, no prose:
{"picks": [{"id": number, "reason": string}]}

- Use ONLY candidates from the list, by id. Pick up to ${MAX_PICKS} that best fit the request, including every modifier in it.${wanted}${lovedLine}
- Prefer candidates with more mentions and a higher positive share, and, for "like X" requests, more shared threads.
- Pick three different authors, and never two books of one series.
- reason: one sentence on why it fits this reader. State only what the candidate's dossier, tags or quotes support; don't invent plot, magic or tone.
- If nothing fits, reply {"picks": []}.

Request: ${JSON.stringify(question)}
Candidates: ${JSON.stringify(candidates)}`;
}

/** Validate the pick reply: unknown or repeated ids are dropped, never shown. */
export function parsePicks(raw: string, shortlist: Candidate[]): BookPick[] {
  const byId = new Map(shortlist.map((c) => [c.id, c]));
  const picks: BookPick[] = [];
  const listed = jsonObject(raw)?.picks;
  for (const p of Array.isArray(listed) ? listed : []) {
    const { id, reason } = (p ?? {}) as { id?: unknown; reason?: unknown };
    const candidate = byId.get(Number(id));
    if (!candidate || picks.some((x) => x.candidate === candidate)) continue;
    picks.push({ candidate, reason: typeof reason === 'string' ? reason.trim().slice(0, MAX_REASON_CHARS) : '' });
    if (picks.length === MAX_PICKS) break;
  }
  return picks;
}

export function statLine(t: Title) {
  const pct = t.mentions ? Math.round((100 * t.positive) / t.mentions) : 0;
  return `${t.mentions} mentions on r/Fantasy, ${pct}% positive`;
}

export function formatAnswer(picks: BookPick[], unknown: string[]) {
  const notes = unknown.map((name) => `I don't have data on ${name}.`);
  if (!picks.length) return [...notes, NOT_ENOUGH_DATA].join('\n\n');
  const body = picks.map(({ candidate: c, reason }, i) => {
    const head = `${i + 1}. *${c.title}*${c.author ? ` by ${c.author}` : ''}${c.kind === 'series' ? ' (series)' : ''}`;
    const start = c.startWith && c.startWith !== c.title ? `Start with *${c.startWith}*.` : null;
    return [head, reason, start, statLine(c), c.link].filter(Boolean).join('\n');
  });
  return [...notes, ...body].join('\n\n');
}

/**
 * "Something like Mistborn but darker" → up to three picks from r/Fantasy discussion.
 * Named Books are anchors: candidates are what's discussed alongside them, minus the anchors'
 * own authors (the reader already knows them). Without anchors, what the reader loved is the
 * anchor; without that, the most-read, best-liked Titles, in the requested genre when there's
 * enough of it. Modifiers become Title tags that rank matching candidates first. The reading
 * profile's shelf and recent picks are left out, and each answer's picks join the recent ones.
 */
export function createBookRecommender({
  catalog,
  complete,
  profile,
  now = Date.now,
  logger,
}: {
  catalog: BookCatalog;
  complete: Complete;
  profile?: ReadingProfileStore;
  now?: () => number;
  logger?: Pick<Logger, 'info'>;
}) {
  return async function recommend(question: string): Promise<Recommendation> {
    const started = Date.now();
    const genres = catalog.genres();
    const vocabulary = catalog.vocabulary();
    const parseReply = await complete(buildParsePrompt(question, genres, vocabulary));
    const parsed = parseRequest(parseReply.text, genres, vocabulary);
    if (!parsed) return { kind: 'not_a_request' };

    const reading = profile ? await profile.load() : null;
    const anchors: Title[] = [];
    const unknown: string[] = [];
    for (const name of parsed.anchors) {
      const t = catalog.find(name);
      if (t) anchors.push(t);
      else unknown.push(name);
    }
    const request = parseReply.backend === 'minipc' ? guardAgainstAnchors(parsed, anchors, catalog) : parsed;
    const exclude = {
      ids: [
        ...anchors.map((a) => a.id),
        ...request.excludeTitles.flatMap((name) => catalog.find(name)?.id ?? []),
        ...(reading ? excludedIds(reading, now()) : []),
      ],
      authors: [...request.excludeAuthors, ...anchors.flatMap((a) => a.author ?? [])],
    };
    const opts = { exclude, limit: SHORTLIST, tags: request.tags };

    const loved = !anchors.length && !request.genre && reading ? lovedIds(reading) : [];
    let shortlist = catalog.similarTo(anchors.length ? anchors.map((a) => a.id) : loved, opts);
    const fromLoved = !anchors.length && shortlist.length >= MIN_CANDIDATES;
    const carriesTag = (c: Candidate) => c.tags.some((t) => request.tags.includes(t));
    if (shortlist.length && request.tags.length && shortlist.filter(carriesTag).length < MIN_CANDIDATES) {
      // "Like WoT but standalone": few neighbours carry the tag, so add the best-liked Titles that do.
      const extra = catalog.popular({ ...opts, limit: SHORTLIST / 2, genre: null, exclude: { ...exclude, ids: [...exclude.ids, ...shortlist.map((c) => c.id)] } });
      shortlist = [...shortlist, ...extra];
    }
    if (shortlist.length < MIN_CANDIDATES) shortlist = catalog.popular({ ...opts, genre: request.genre });
    if (shortlist.length < MIN_CANDIDATES && request.genre) shortlist = catalog.popular({ ...opts, genre: null });
    if (shortlist.length < MIN_CANDIDATES && request.tags.length) shortlist = catalog.popular({ ...opts, tags: [], genre: request.genre });

    const lovedTitles = fromLoved ? loved.flatMap((id) => catalog.title(id) ?? []) : [];
    const lovedAuthors = lovedTitles.flatMap((t) => t.author ?? []);
    const prompt = buildPickPrompt(question, shortlist, { tags: request.tags, loved: lovedTitles.map(({ title, author }) => ({ title, author })) });
    const picks = shortlist.length >= MIN_CANDIDATES
      ? atMostOneBy(lovedAuthors, parsePicks((await complete(prompt)).text, shortlist))
      : [];
    if (profile && reading && picks.length) await profile.save(withPicks(reading, picks.map((p) => p.candidate), now()));
    logger?.info({
      request,
      parsedBy: parseReply.backend,
      ...(request !== parsed ? { parsed: { genre: parsed.genre, tags: parsed.tags } } : {}),
      anchors: anchors.map((a) => a.id),
      loved: fromLoved ? loved : [],
      shortlist: shortlist.length,
      picks: picks.map((p) => p.candidate.id),
      ms: Date.now() - started,
    }, 'book recommendation');
    return { kind: 'answer', text: formatAnswer(picks, unknown), picks };
  };
}
