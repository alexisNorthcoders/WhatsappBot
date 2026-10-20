import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

it('tracks no JavaScript, which tsc -p . would not type-check', () => {
  const js = execFileSync('git', ['ls-files', '--', '*.js', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(js, [], 'write it as .ts');
});
