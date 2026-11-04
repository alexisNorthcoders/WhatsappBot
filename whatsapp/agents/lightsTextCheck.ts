/**
 * A code check on the lights fast path: the router's answers drive Hue only when the message
 * itself backs them. Small models answer confidently and wrong ("thanks, the lights are perfect
 * now" → all off), so a confident answer isn't enough. Anything this rejects goes to the GPT
 * lights agent.
 */

type Light = { id: string; name: string; room: string };
type Target = { target: string; members: Light[] };

/** words that don't tell one light or room from another */
const GENERIC = new Set(['room', 'light', 'lights', 'lamp', 'lamps', 'the']);

const ACTION_WORDS: Record<string, RegExp> = {
  on: /\bon\b/,
  off: /\b(off|out|kill)\b/,
  brightness: /\b(dim\w*|bright\w*|full|max\w*|half|low\w*|up|down|level|glow|night|quarters?)\b|\d+\s*(%|percent)/,
  colour: /\b(red|green|blue|yellow|orange|purple|pink|white|warm\w*|cool\w*|cosy|cozy|daylight|colou?r\w*)\b/,
};

const QUESTION = /^\s*(is|are|was|were|have|has|had|did|do|does|which|what|why|how|when|where|who)\b/;

const DELAY =
  /\b(in|after|for)\s+(\S+\s+){0,2}?(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b|\bat\s+\d|\b\d{1,2}(:\d\d)?\s*(am|pm)\b|\b(tonight|tomorrow|later|until|till|when|every|o'?clock)\b/;

const wordsOf = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** "stairs" names the "Staircase"; "bedroom" doesn't name the "Kids bedroom" on its own */
const sameWord = (a: string, b: string) =>
  a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

type Match = { full: boolean; words: Set<string> };

/** How well the message's words name `name`: every distinctive word, or some. */
function match(message: string[], name: string): Match {
  const all = wordsOf(name);
  const distinctive = all.filter((w) => !GENERIC.has(w));
  const want = distinctive.length ? distinctive : all;
  const words = new Set(message.filter((m) => want.some((w) => sameWord(m, w))));
  const found = want.filter((w) => message.some((m) => sameWord(m, w)));
  return { full: want.length > 0 && found.length === want.length, words };
}

function namesOf(target: string, lights: Light[]): string[] {
  if (target.startsWith('room:')) {
    const room = target.slice('room:'.length);
    const members = lights.filter((L) => L.room === room);
    return members.length === 1 ? [room, members[0].name] : [room];
  }
  const L = lights.find((x) => `light:${x.id}` === target);
  if (!L) return [];
  return lights.filter((x) => x.room === L.room).length === 1 ? [L.name, L.room] : [L.name];
}

/** The best of a target's names: a full match beats a partial one, then more words. */
function bestMatch(message: string[], target: string, lights: Light[]): Match {
  const none: Match = { full: false, words: new Set() };
  return namesOf(target, lights)
    .map((n) => match(message, n))
    .reduce((a, b) => (b.full !== a.full ? (b.full ? b : a) : b.words.size > a.words.size ? b : a), none);
}

/** Whether the message names `chosen` and no other light or room it would rather mean. */
export function messageNamesTarget(text: string, chosen: Target, lights: Light[]): boolean {
  const message = wordsOf(text);
  const others = [...new Set(lights.map((L) => `room:${L.room}`)), ...lights.map((L) => `light:${L.id}`)].filter(
    (t) => t !== chosen.target,
  );
  const named = others.map((t) => ({ t, m: bestMatch(message, t, lights) })).filter(({ m }) => m.words.size > 0);

  // "all" only when nothing narrower is named: "everything off except the hall" isn't all
  if (chosen.target === 'all') return named.length === 0;

  const mine = bestMatch(message, chosen.target, lights);
  if (!mine.words.size) return false;
  const ids = new Set(chosen.members.map((L) => L.id));
  // the chosen lights' own room may qualify them: "office desk lamp"
  const rooms = new Set(chosen.members.map((L) => L.room));
  const explained = new Set(mine.words);
  if (rooms.size === 1) for (const w of match(message, [...rooms][0]).words) explained.add(w);
  for (const { t, m } of named) {
    if (!m.full) continue;
    // a fuller or more specific name for something else: "bedroom" is the Bedroom, not the Kids bedroom
    if (!mine.full || m.words.size > mine.words.size) return false;
    // a second, separate target: "the bedroom and the office"
    const extra = [...m.words].some((w) => !explained.has(w));
    if (extra && lights.filter((L) => inTarget(t, L)).every((L) => !ids.has(L.id))) return false;
  }
  return true;
}

function inTarget(target: string, L: Light) {
  return target === `light:${L.id}` || target === `room:${L.room}`;
}

/**
 * Whether a state-changing action is backed: a word for it, no delay, not a question, and not
 * both "on" and "off" ("the desk lamp on and the office light off" is two actions).
 */
export function messageAsksForAction(text: string, action: string): boolean {
  const t = text.toLowerCase();
  const word = ACTION_WORDS[action];
  const onAndOff = ACTION_WORDS.on.test(t) && ACTION_WORDS.off.test(t);
  return Boolean(word?.test(t)) && !QUESTION.test(t) && !DELAY.test(t) && !onAndOff;
}
