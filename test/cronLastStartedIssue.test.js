import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  cronLastStartedIssuePath,
  readCronLastStartedIssue,
  writeCronLastStartedIssue,
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

  it('read returns null when missing or invalid', async () => {
    assert.equal(await readCronLastStartedIssue(), null);
    const path = cronLastStartedIssuePath();
    const { writeFile } = await import('fs/promises');
    await writeFile(path, '{"foo":1}', 'utf8');
    assert.equal(await readCronLastStartedIssue(), null);
  });

  it('write then read returns repo, number, savedAt', async () => {
    await writeCronLastStartedIssue({ repo: 'o/r', number: 26 });
    const row = await readCronLastStartedIssue();
    assert.equal(row?.repo, 'o/r');
    assert.equal(row?.number, 26);
    assert.ok(String(row?.savedAt || '').length > 0);
  });
});
