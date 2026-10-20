import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const joplinModule = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'joplin', 'index.ts'),
).href;

describe('Joplin client', () => {
  it('runs the CLI from JOPLIN_BIN when joplin is not on PATH', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'joplin-bin-'));
    const fakeCli = path.join(dir, 'fake joplin');
    writeFileSync(fakeCli, '#!/bin/sh\nif [ "$1 $2" = "ls /" ]; then echo Recipes; echo Work; else echo 9; fi\n');
    chmodSync(fakeCli, 0o755);

    const stdout = execFileSync(
      process.execPath,
      [
        '--no-deprecation',
        '--input-type=module',
        '-e',
        `const { default: joplin } = await import(${JSON.stringify(joplinModule)});
         console.log(JSON.stringify(await joplin.getNotebooks()));`,
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        env: { HOME: dir, PATH: '/usr/bin:/bin', JOPLIN_BIN: fakeCli },
      },
    );

    assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)!), [
      { id: 'Recipes', title: 'Recipes' },
      { id: 'Work', title: 'Work' },
    ]);
  });
});
