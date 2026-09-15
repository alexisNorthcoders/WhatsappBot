import { homedir } from 'os';
import { join } from 'path';

/** Paths often missing when the bot is not started from an interactive shell (systemd, etc.). */
export function augmentedPathEnv() {
  const home = homedir();
  const prefixes = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    '/usr/local/bin',
  ].filter(Boolean);
  const extra = prefixes.join(':');
  const base = process.env.PATH || '';
  return base ? `${extra}:${base}` : extra;
}
