/**
 * The `books` port: what r/Fantasy says about Books and Series, from reddit-bot's recommendation read model.
 * Adapter: `sqliteBookCatalog.ts`; tests run it on a fixture database (`test/helpers/bookDb.ts`).
 */

export type Title = {
  id: number;
  title: string;
  author: string | null;
  kind: 'book' | 'series';
  genre: string | null;
  mentions: number;
  positive: number;
  negative: number;
};

/** reddit-bot's Haiku summary of what Redditors say about a Title (its `rec_dossiers`). */
export type Dossier = { praise: string[]; complaints: string[]; advice: string[]; comparisons: string[] };

/** A Title tag from reddit-bot's fixed vocabulary, written `facet:tag` (e.g. `tone:dark`). */
export type VocabularyTag = { tag: string; description: string };

/** A Title offered to the picker, with why it was shortlisted and what Redditors said. */
export type Candidate = Title & {
  /** Threads it shares with the reader's anchors (summed over them); absent for popularity picks. */
  sharedThreads?: number;
  /** Its confident Title tags (`facet:tag`); empty before reddit-bot tags it. */
  tags: string[];
  /** Null before reddit-bot writes one; the picker then gets `excerpts`. */
  dossier: Dossier | null;
  excerpts: string[];
  link: string | null;
  /** For a Series: its first Book, when reddit-bot knows the Series' Books. */
  startWith: string | null;
  /** Present when past r/Fantasy asks like the reader's recommended it. */
  answered?: CommunityAnswer;
};

/** A request as ask retrieval takes it: Title ids, `facet:tag` tags and the reader's own words. */
export type AskQuery = { likes: number[]; unlikes: number[]; wants: string[]; avoids: string[]; text: string };

/** What r/Fantasy answered a Title with, pooled over the past asks closest to the reader's. */
export type CommunityAnswer = {
  /** Supporting recommendations, summed over the asks (one Redditor may count in several). */
  redditors: number;
  /** Redditors who argued against it in those asks. */
  against: number;
  asks: number;
  /** The ask that backed it most. */
  example: { title: string; link: string | null };
};

export type Exclusions = { ids: number[]; authors: string[] };

/** Wanted Title tags: Titles carrying more of them rank first, and `popular` keeps only those carrying one. */
export type ShortlistOptions = { exclude: Exclusions; limit: number; tags?: string[] };

export type BookCatalog = {
  /** The best-known Title with this name, or null. */
  find: (name: string) => Title | null;
  /**
   * Titles r/Fantasy discusses alongside the anchors, by reddit-bot's book similarity, closest
   * first. A Series and its own Books never both appear, and excluding one excludes the other.
   */
  similarTo: (anchorIds: number[], opts: ShortlistOptions) => Candidate[];
  /**
   * What r/Fantasy answered the past asks closest to this one with, most supported first, with
   * rebuttals demoting a Title; same Series rules. Empty on a DB without reddit-bot's ask index.
   */
  answeredFor: (query: AskQuery, opts: ShortlistOptions) => Candidate[];
  /** The Titles r/Fantasy reads most and likes best, overall or in one genre; same Series rules. */
  popular: (opts: ShortlistOptions & { genre: string | null }) => Candidate[];
  genres: () => string[];
  /** The Title with this id, or null. */
  title: (id: number) => Title | null;
  /** The Title now holding a Merged-away Title's Mentions, or null (not merged, or a DB without `rec_merges`). */
  survivorOf: (id: number) => number | null;
  /** A Title's confident tags (`facet:tag`); empty when untagged or on a DB without tags. */
  tagsOf: (id: number) => string[];
  /** The tags the parser may ask for; empty on a DB without reddit-bot's tags. */
  vocabulary: () => VocabularyTag[];
};
