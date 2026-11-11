/**
 * The `books` port: what r/Fantasy says about Books and Series, from reddit-bot's database.
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

/** A Title offered to the picker, with why it was shortlisted and what Redditors said. */
export type Candidate = Title & {
  /** Threads it shares with the reader's anchors; absent for popularity picks. */
  sharedThreads?: number;
  excerpts: string[];
  link: string | null;
};

export type Exclusions = { ids: number[]; authors: string[] };

export type BookCatalog = {
  /** The best-known Title with this name, or null. */
  find: (name: string) => Title | null;
  /** Titles discussed in the same threads as the anchors, relative to how popular each is. */
  similarTo: (anchorIds: number[], opts: { exclude: Exclusions; limit: number }) => Candidate[];
  /** The best-liked Titles overall, or in one genre. */
  popular: (opts: { genre: string | null; exclude: Exclusions; limit: number }) => Candidate[];
  genres: () => string[];
};
