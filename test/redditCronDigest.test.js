import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isStatusFileFresh,
  truncateDigestMessage,
  shouldAttemptDigestSend,
  utcCalendarDay,
  runRedditCronDigestTick,
  readRedditCronDigestLastSentDay,
  writeRedditCronDigestLastSentDay,
} from '../whatsapp/agents/redditCronDigest.js';

describe('isStatusFileFresh', () => {
  it('accepts mtime within max age', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    assert.equal(isStatusFileFresh(now - 19 * 3600_000, now, 20 * 3600_000), true);
  });

  it('rejects stale mtime and large future skew', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    assert.equal(isStatusFileFresh(now - 21 * 3600_000, now, 20 * 3600_000), false);
    assert.equal(isStatusFileFresh(now + 2 * 3600_000, now, 20 * 3600_000), false);
    assert.equal(isStatusFileFresh(now + 30_000, now, 20 * 3600_000), true);
  });
});

describe('truncateDigestMessage', () => {
  it('leaves short messages unchanged', () => {
    assert.equal(truncateDigestMessage('hello', 10), 'hello');
  });

  it('truncates over the cap', () => {
    const s = 'a'.repeat(20);
    const out = truncateDigestMessage(s, 10);
    assert.equal(out.length, 10);
    assert.ok(out.endsWith('…'));
  });
});

describe('shouldAttemptDigestSend', () => {
  it('waits until scheduled UTC time', () => {
    const before = Date.parse('2026-09-05T02:59:00Z');
    assert.equal(
      shouldAttemptDigestSend({
        nowMs: before,
        hourUtc: 3,
        minuteUtc: 0,
        lastSentYmd: null,
      }),
      false
    );
    const after = Date.parse('2026-09-05T03:00:00Z');
    assert.equal(
      shouldAttemptDigestSend({
        nowMs: after,
        hourUtc: 3,
        minuteUtc: 0,
        lastSentYmd: null,
      }),
      true
    );
  });

  it('is idempotent for the same UTC calendar day', () => {
    const now = Date.parse('2026-09-05T15:00:00Z');
    assert.equal(
      shouldAttemptDigestSend({
        nowMs: now,
        hourUtc: 3,
        minuteUtc: 0,
        lastSentYmd: '2026-09-05',
      }),
      false
    );
  });
});

describe('runRedditCronDigestTick', () => {
  let prevLastSent;
  let tmpDir;

  beforeEach(async () => {
    prevLastSent = process.env.REDDIT_CRON_DIGEST_LAST_SENT_FILE;
    tmpDir = await mkdtemp(join(tmpdir(), 'wabot-digest-'));
    process.env.REDDIT_CRON_DIGEST_LAST_SENT_FILE = join(tmpDir, 'last.json');
  });

  afterEach(async () => {
    if (prevLastSent == null) delete process.env.REDDIT_CRON_DIGEST_LAST_SENT_FILE;
    else process.env.REDDIT_CRON_DIGEST_LAST_SENT_FILE = prevLastSent;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function mockSock() {
    /** @type {{ jid: string, text: string }[]} */
    const sent = [];
    return {
      sent,
      sendMessage: async (jid, content) => {
        sent.push({ jid, text: String(content?.text ?? '') });
      },
    };
  }

  it('sends file contents once and records last-sent day', async () => {
    const statusPath = join(tmpDir, 'daily-cron-status.txt');
    await writeFile(statusPath, 'reddit-bot cron — ok\n', 'utf8');
    const sock = mockSock();
    const nowMs = Date.parse('2026-09-05T03:05:00Z');
    const at = new Date(nowMs);
    await utimes(statusPath, at, at);

    const r1 = await runRedditCronDigestTick({
      getSocket: () => sock,
      getOwnerJid: () => '111@s.whatsapp.net',
      statusFilePath: statusPath,
      nowMs,
      hourUtc: 3,
      minuteUtc: 0,
    });
    assert.equal(r1.sent, true);
    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0].text, /reddit-bot cron/);
    assert.equal(await readRedditCronDigestLastSentDay(), '2026-09-05');

    const r2 = await runRedditCronDigestTick({
      getSocket: () => sock,
      getOwnerJid: () => '111@s.whatsapp.net',
      statusFilePath: statusPath,
      nowMs: Date.parse('2026-09-05T04:00:00Z'),
      hourUtc: 3,
      minuteUtc: 0,
    });
    assert.equal(r2.sent, false);
    assert.equal(sock.sent.length, 1);
  });

  it('alerts when status file is missing', async () => {
    const sock = mockSock();
    const r = await runRedditCronDigestTick({
      getSocket: () => sock,
      getOwnerJid: () => '111@s.whatsapp.net',
      statusFilePath: join(tmpDir, 'nope.txt'),
      nowMs: Date.parse('2026-09-05T03:05:00Z'),
      hourUtc: 3,
      minuteUtc: 0,
    });
    assert.equal(r.sent, true);
    assert.match(sock.sent[0].text, /missing\/stale/);
  });

  it('alerts when status file is stale', async () => {
    const statusPath = join(tmpDir, 'stale.txt');
    await writeFile(statusPath, 'old\n', 'utf8');
    const old = new Date(Date.parse('2026-09-03T01:00:00Z'));
    await utimes(statusPath, old, old);
    const sock = mockSock();
    const r = await runRedditCronDigestTick({
      getSocket: () => sock,
      getOwnerJid: () => '111@s.whatsapp.net',
      statusFilePath: statusPath,
      nowMs: Date.parse('2026-09-05T03:05:00Z'),
      hourUtc: 3,
      minuteUtc: 0,
      maxAgeMs: 20 * 3600_000,
    });
    assert.equal(r.sent, true);
    assert.match(sock.sent[0].text, /missing\/stale/);
  });

  it('truncates oversized digest bodies', async () => {
    const statusPath = join(tmpDir, 'big.txt');
    await writeFile(statusPath, 'x'.repeat(5000), 'utf8');
    const nowMs = Date.parse('2026-09-05T03:05:00Z');
    const at = new Date(nowMs);
    await utimes(statusPath, at, at);
    const sock = mockSock();
    await runRedditCronDigestTick({
      getSocket: () => sock,
      getOwnerJid: () => '111@s.whatsapp.net',
      statusFilePath: statusPath,
      nowMs,
      hourUtc: 3,
      minuteUtc: 0,
    });
    assert.ok(sock.sent[0].text.length <= 3500);
    assert.ok(sock.sent[0].text.endsWith('…'));
  });

  it('write/read last-sent round-trips', async () => {
    await writeRedditCronDigestLastSentDay('2026-09-04');
    assert.equal(await readRedditCronDigestLastSentDay(), '2026-09-04');
    assert.equal(utcCalendarDay(Date.parse('2026-09-04T23:59:00Z')), '2026-09-04');
  });
});
