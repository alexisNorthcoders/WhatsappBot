import type { BookCatalog, Candidate, Title } from './bookCatalog.ts';
import type { Logger } from '../types.ts';

export type BookRequest = {
  anchors: string[];
  genre: string | null;
  excludeTitles: string[];
  excludeAuthors: string[];
};

export type Recommendation = { kind: 'not_a_request' } | { kind: 'answer'; text: string };

export type Complete = (prompt: string) => Promise<string>;

const MAX_PICKS = 3;
const SHORTLIST = 20;
/** With fewer candidates than this the picker has no real choice, so say there's not enough data. */
const MIN_CANDIDATES = 3;
const MAX_REASON_CHARS = 300;

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

export function buildParsePrompt(question: string, genres: string[]) {
  return `You read a message from a fantasy reader and decide whether it asks for book recommendations. Reply with one JSON object only, no prose.

If it asks for Books or Series to read (including open asks like "what should I read next?"), reply:
{"anchors": string[], "genre": string | null, "excludeTitles": string[], "excludeAuthors": string[]}
- anchors: Books or Series named as reference points ("like Mistborn" → ["Mistborn"]), else [].
- genre: one of ${genres.join(', ')} when the reader clearly asks for one, else null.
- excludeTitles / excludeAuthors: Books or authors the reader doesn't want (already read, dislikes), else [].

If it doesn't ask for something to read (a statement, a question about a book's plot or author, chit-chat), reply:
{"notRequest": true}

Message: ${JSON.stringify(question)}`;
}

/** Validate the parse reply. Anything malformed counts as not a request, so the chain moves on. */
export function parseRequest(raw: string, genres: string[]): BookRequest | null {
  const j = jsonObject(raw);
  if (!j || j.notRequest === true) return null;
  const genre = typeof j.genre === 'string' ? j.genre.trim().toLowerCase() : null;
  return {
    anchors: strings(j.anchors),
    genre: genre && genres.includes(genre) ? genre : null,
    excludeTitles: strings(j.excludeTitles),
    excludeAuthors: strings(j.excludeAuthors),
  };
}

export function buildPickPrompt(question: string, shortlist: Candidate[]) {
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
    what_redditors_said: c.excerpts,
  }));
  return `You pick book recommendations for a reader from a shortlist built from r/Fantasy discussion. Reply with one JSON object only, no prose:
{"picks": [{"id": number, "reason": string}]}

- Use ONLY candidates from the list, by id. Pick up to ${MAX_PICKS} that best fit the request.
- Prefer candidates with more mentions and a higher positive share, and, for "like X" requests, more shared threads.
- Don't pick both a Series and a Book from it.
- reason: one sentence on why it fits this reader, grounded in what Redditors said.
- If nothing fits, reply {"picks": []}.

Request: ${JSON.stringify(question)}
Candidates: ${JSON.stringify(candidates)}`;
}

/** Validate the pick reply: unknown or repeated ids are dropped, never shown. */
export function parsePicks(raw: string, shortlist: Candidate[]) {
  const byId = new Map(shortlist.map((c) => [c.id, c]));
  const picks: { candidate: Candidate; reason: string }[] = [];
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

export function formatAnswer(picks: { candidate: Candidate; reason: string }[], unknown: string[]) {
  const notes = unknown.map((name) => `I don't have data on ${name}.`);
  if (!picks.length) return [...notes, NOT_ENOUGH_DATA].join('\n\n');
  const body = picks.map(({ candidate: c, reason }, i) => {
    const head = `${i + 1}. *${c.title}*${c.author ? ` by ${c.author}` : ''}${c.kind === 'series' ? ' (series)' : ''}`;
    return [head, reason, statLine(c), c.link].filter(Boolean).join('\n');
  });
  return [...notes, ...body].join('\n\n');
}

/**
 * "Something like Mistborn but darker" → up to three picks from r/Fantasy discussion.
 * Named Books are anchors: candidates are what's discussed alongside them, minus the anchors'
 * own authors (the reader already knows them). Without anchors, the best-liked Titles, in the
 * requested genre when there's enough of it.
 */
export function createBookRecommender({
  catalog,
  complete,
  logger,
}: {
  catalog: BookCatalog;
  complete: Complete;
  logger?: Pick<Logger, 'info'>;
}) {
  return async function recommend(question: string): Promise<Recommendation> {
    const started = Date.now();
    const genres = catalog.genres();
    const request = parseRequest(await complete(buildParsePrompt(question, genres)), genres);
    if (!request) return { kind: 'not_a_request' };

    const anchors: Title[] = [];
    const unknown: string[] = [];
    for (const name of request.anchors) {
      const t = catalog.find(name);
      if (t) anchors.push(t);
      else unknown.push(name);
    }
    const exclude = {
      ids: [
        ...anchors.map((a) => a.id),
        ...request.excludeTitles.flatMap((name) => catalog.find(name)?.id ?? []),
      ],
      authors: [...request.excludeAuthors, ...anchors.flatMap((a) => a.author ?? [])],
    };

    let shortlist = catalog.similarTo(anchors.map((a) => a.id), { exclude, limit: SHORTLIST });
    if (shortlist.length < MIN_CANDIDATES) {
      shortlist = catalog.popular({ genre: request.genre, exclude, limit: SHORTLIST });
    }
    if (shortlist.length < MIN_CANDIDATES && request.genre) {
      shortlist = catalog.popular({ genre: null, exclude, limit: SHORTLIST });
    }

    const picks = shortlist.length >= MIN_CANDIDATES
      ? parsePicks(await complete(buildPickPrompt(question, shortlist)), shortlist)
      : [];
    logger?.info({
      request,
      anchors: anchors.map((a) => a.id),
      shortlist: shortlist.length,
      picks: picks.map((p) => p.candidate.id),
      ms: Date.now() - started,
    }, 'book recommendation');
    return { kind: 'answer', text: formatAnswer(picks, unknown) };
  };
}
