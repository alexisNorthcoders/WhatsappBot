import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The bot repo's root; default home for local state under `logs/`. */
export function getRepoRoot() {
  return REPO_ROOT;
}
