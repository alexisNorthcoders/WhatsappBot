import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backupAuthDirOnce } from '../whatsapp/baileysAuthBackup.js';

async function withTmp(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'auth-backup-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('copies the auth folder (including nested files) when no backup exists', async () => {
  await withTmp(async (root) => {
    const authDir = path.join(root, 'baileys');
    const backupDir = path.join(root, 'baileys-pre-v7-backup');
    await mkdir(path.join(authDir, 'nested'), { recursive: true });
    await writeFile(path.join(authDir, 'creds.json'), '{"me":1}');
    await writeFile(path.join(authDir, 'nested', 'session-1.json'), 'sess');

    const result = await backupAuthDirOnce({ authDir, backupDir });

    assert.equal(result.status, 'created');
    assert.equal(await readFile(path.join(backupDir, 'creds.json'), 'utf8'), '{"me":1}');
    assert.equal(await readFile(path.join(backupDir, 'nested', 'session-1.json'), 'utf8'), 'sess');
  });
});

test('never overwrites an existing backup', async () => {
  await withTmp(async (root) => {
    const authDir = path.join(root, 'baileys');
    const backupDir = path.join(root, 'baileys-pre-v7-backup');
    await mkdir(authDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    await writeFile(path.join(authDir, 'creds.json'), 'migrated');
    await writeFile(path.join(backupDir, 'creds.json'), 'original');

    const result = await backupAuthDirOnce({ authDir, backupDir });

    assert.equal(result.status, 'exists');
    assert.equal(await readFile(path.join(backupDir, 'creds.json'), 'utf8'), 'original');
  });
});

test('second call is a no-op after the first creates the backup', async () => {
  await withTmp(async (root) => {
    const authDir = path.join(root, 'baileys');
    const backupDir = path.join(root, 'baileys-pre-v7-backup');
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, 'creds.json'), 'v6');

    assert.equal((await backupAuthDirOnce({ authDir, backupDir })).status, 'created');
    await writeFile(path.join(authDir, 'creds.json'), 'v7');
    assert.equal((await backupAuthDirOnce({ authDir, backupDir })).status, 'exists');
    assert.equal(await readFile(path.join(backupDir, 'creds.json'), 'utf8'), 'v6');
  });
});

test('skips when there is no auth folder yet (fresh pairing)', async () => {
  await withTmp(async (root) => {
    const authDir = path.join(root, 'baileys');
    const backupDir = path.join(root, 'baileys-pre-v7-backup');

    const result = await backupAuthDirOnce({ authDir, backupDir });

    assert.equal(result.status, 'no-auth');
    assert.deepEqual(await readdir(root), []);
  });
});

test('refuses a backup location inside the live auth folder', async () => {
  await withTmp(async (root) => {
    const authDir = path.join(root, 'baileys');
    await mkdir(authDir, { recursive: true });
    await assert.rejects(
      backupAuthDirOnce({ authDir, backupDir: path.join(authDir, 'backup') }),
      /outside/,
    );
  });
});

test('a leftover partial copy from an interrupted run is not mistaken for a backup', async () => {
  await withTmp(async (root) => {
    const authDir = path.join(root, 'baileys');
    const backupDir = path.join(root, 'baileys-pre-v7-backup');
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, 'creds.json'), 'v6');
    // Simulates a crash mid-copy: staging dir left behind, final backup never renamed into place.
    await mkdir(`${backupDir}.partial`, { recursive: true });
    await writeFile(path.join(`${backupDir}.partial`, 'half.json'), 'x');

    const result = await backupAuthDirOnce({ authDir, backupDir });

    assert.equal(result.status, 'created');
    assert.deepEqual(await readdir(backupDir), ['creds.json']);
    assert.deepEqual((await readdir(root)).sort(), ['baileys', 'baileys-pre-v7-backup']);
  });
});
