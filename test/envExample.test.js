import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const BOT_SOURCES = ['whatsapp.js', 'whatsapp', 'models', 'hue', 'joplin', 'scripts'];

function envVarsReadByBot() {
  const files = execFileSync('git', ['ls-files', '--', ...BOT_SOURCES], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(m?js|ts)$/.test(f));
  const vars = new Map();
  for (const file of files) {
    for (const [, name] of readFileSync(path.join(root, file), 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
      if (!vars.has(name)) vars.set(name, file);
    }
  }
  return vars;
}

describe('.env.example', () => {
  it('documents every env var the bot reads', () => {
    const documented = new Set(
      [...readFileSync(path.join(root, '.env.example'), 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
    );
    const missing = [...envVarsReadByBot()]
      .filter(([name]) => !documented.has(name))
      .map(([name, file]) => `${name} (read in ${file})`);
    assert.deepEqual(missing, [], 'add a commented `# NAME=default` line with a short description to .env.example');
  });
});
