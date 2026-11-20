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
  /** The Titles r/Fantasy reads most and likes best, overall or in one genre; same Series rules. */
  popular: (opts: ShortlistOptions & { genre: string | null }) => Candidate[];
  genres: () => string[];
  /** A Title's confident tags (`facet:tag`); empty when untagged or on a DB without tags. */
  tagsOf: (id: number) => string[];
  /** The tags the parser may ask for; empty on a DB without reddit-bot's tags. */
  vocabulary: () => VocabularyTag[];
};
