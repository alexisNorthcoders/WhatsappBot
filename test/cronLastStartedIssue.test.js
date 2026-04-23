import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFile } from 'fs/promises';
import {
  cronLastStartedIssuePath,
  readCronPerRepoLastStarted,
  writeCronPerRepoLastStartedEntry,
} from '../whatsapp/agents/cronLastStartedIssue.js';

describe('cronLastStartedIssue persistence', () => {
  let prevFile;
  let tmpDir;

  beforeEach(async () => {
    prevFile = process.env.CRON_LAST_STARTED_ISSUE_FILE;
    tmpDir = await mkdtemp(join(tmpdir(), 'wabot-cron-'));
    process.env.CRON_LAST_STARTED_ISSUE_FILE = join(tmpDir, 'state.json');
  });

  afterEach(async () => {
    if (prevFile == null) {
      delete process.env.CRON_LAST_STARTED_ISSUE_FILE;
    } else {
      process.env.CRON_LAST_STARTED_ISSUE_FILE = prevFile;
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('read returns empty map when missing or invalid', async () => {
    assert.equal((await readCronPerRepoLastStarted()).size, 0);
    const path = cronLastStartedIssuePath();
    await writeFile(path, '{"foo":1}', 'utf8');
    assert.equal((await readCronPerRepoLastStarted()).size, 0);
  });

  it('legacy { repo, number } file is kept when merging a new per-repo write', async () => {
    const path = cronLastStartedIssuePath();
    await writeFile(
      path,
      JSON.stringify({ repo: 'legacy/one', number: 99, savedAt: 'x' }, null, 2),
      'utf8'
    );
    const m0 = await readCronPerRepoLastStarted();
    assert.equal(m0.get('legacy/one'), 99);
    await writeCronPerRepoLastStartedEntry({ repo: 'other/m', number: 3 });
    const m1 = await readCronPerRepoLastStarted();
    assert.equal(m1.get('legacy/one'), 99);
    assert.equal(m1.get('other/m'), 3);
  });

  it('merging writes keeps all repos in one file', async () => {
    await writeCronPerRepoLastStartedEntry({ repo: 'a/w', number: 7 });
    await writeCronPerRepoLastStartedEntry({ repo: 'a/p', number: 2 });
    const m = await readCronPerRepoLastStarted();
    assert.equal(m.get('a/w'), 7);
    assert.equal(m.get('a/p'), 2);
  });
});
