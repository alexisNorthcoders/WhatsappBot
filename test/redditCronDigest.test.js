import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isStatusFileFresh,
  isDigestReadyForDay,
  parseDigestHeaderDay,
  truncateDigestMessage,
  shouldAttemptDigestSend,
  utcCalendarDay,
  runRedditCronDigestTick,
  readRedditCronDigestLastSentDay,
  readRedditCronDigestState,
  writeRedditCronDigestLastSentDay,
  writeRedditCronDigestState,
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

describe('parseDigestHeaderDay / isDigestReadyForDay', () => {
  it('parses structured digest header day', () => {
    assert.equal(
      parseDigestHeaderDay('reddit-bot cron — 2026-09-05\nCleanup: OK\n'),
      '2026-09-05'
    );
    assert.equal(parseDigestHeaderDay('not a digest'), null);
  });

  it('requires fresh mtime and matching expected day', () => {
    const now = Date.parse('2026-09-05T03:05:00Z');
    const text = 'reddit-bot cron — 2026-09-05\nCleanup: OK — nothing to do\n';
    assert.equal(
      isDigestReadyForDay({
        text,
        mtimeMs: now - 3600_000,
        nowMs: now,
        maxAgeMs: 20 * 3600_000,
        expectedDay: '2026-09-05',
      }),
      true
    );
    assert.equal(
      isDigestReadyForDay({
        text: 'reddit-bot cron — 2026-09-04\nCleanup: OK\n',
        mtimeMs: now - 3600_000,
        nowMs: now,
        maxAgeMs: 20 * 3600_000,
        expectedDay: '2026-09-05',
      }),
      false
    );
    assert.equal(
      isDigestReadyForDay({
        text,
        mtimeMs: now - 21 * 3600_000,
        nowMs: now,
        maxAgeMs: 20 * 3600_000,
        expectedDay: '2026-09-05',
      }),
      false
    );
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
        digestSentToday: false,
      }),
      false
    );
    const after = Date.parse('2026-09-05T03:00:00Z');
    assert.equal(
      shouldAttemptDigestSend({
        nowMs: after,
        hourUtc: 3,
        minuteUtc: 0,
        digestSentToday: false,
      }),
      true
    );
  });

  it('is idempotent once digest was sent today', () => {
    const now = Date.parse('2026-09-05T15:00:00Z');
    assert.equal(
      shouldAttemptDigestSend({
        nowMs: now,
        hourUtc: 3,
        minuteUtc: 0,
        digestSentToday: true,
      }),
      false
    );
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

  const structuredDigest = `reddit-bot cron — 2026-09-05
Cleanup: OK — merges=2 deletes=3 meta=0
Insight: OK — day=2026-09-04 mentions=1142
—
Short insight teaser.
—
Files: cron-cleanup.log / cron-insight.log / book-insight-2026-09-04.md
`;

  it('sends structured digest once and records digestSent', async () => {
    const statusPath = join(tmpDir, 'daily-cron-status.txt');
    await writeFile(statusPath, structuredDigest, 'utf8');
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
    assert.equal(r1.reason, 'sent digest');
    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0].text, /Cleanup: OK/);
    assert.match(sock.sent[0].text, /Insight: OK/);
    assert.equal(await readRedditCronDigestLastSentDay(), '2026-09-05');
    const state = await readRedditCronDigestState();
    assert.equal(state.digestSent, true);
    assert.equal(state.alertSent, false);

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

  it('alerts when status file is missing without locking digest day', async () => {
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
    assert.equal(r.reason, 'sent alert');
    assert.match(sock.sent[0].text, /missing\/stale/);
    assert.equal(await readRedditCronDigestLastSentDay(), null);
    const state = await readRedditCronDigestState();
    assert.equal(state.day, '2026-09-05');
    assert.equal(state.digestSent, false);
    assert.equal(state.alertSent, true);
  });

  it('alerts when status file is stale without locking digest day', async () => {
    const statusPath = join(tmpDir, 'stale.txt');
    await writeFile(
      statusPath,
      'reddit-bot cron — 2026-09-03\nCleanup: OK — nothing to do\n',
      'utf8'
    );
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
    assert.equal(r.reason, 'sent alert');
    assert.match(sock.sent[0].text, /missing\/stale/);
    assert.equal(await readRedditCronDigestLastSentDay(), null);
  });

  it('retries after early alert when today\'s digest arrives late', async () => {
    const statusPath = join(tmpDir, 'daily-cron-status.txt');
    // Yesterday's digest still on disk (wrong header day) but fresh mtime.
    await writeFile(
      statusPath,
      'reddit-bot cron — 2026-09-04\nCleanup: OK — nothing to do\n',
      'utf8'
    );
    const nowEarly = Date.parse('2026-09-05T03:05:00Z');
    await utimes(statusPath, new Date(nowEarly), new Date(nowEarly));
    const sock = mockSock();

    const r1 = await runRedditCronDigestTick({
      getSocket: () => sock,
      getOwnerJid: () => '111@s.whatsapp.net',
      statusFilePath: statusPath,
      nowMs: nowEarly,
      hourUtc: 3,
      minuteUtc: 0,
    });
    assert.equal(r1.reason, 'sent alert');
    assert.equal(sock.sent.length, 1);
    assert.match(sock.sent[0].text, /header day 2026-09-04/);

    const rWait = await runRedditCronDigestTick({
      getSocket: () => sock,
      getOwnerJid: () => '111@s.whatsapp.net',
      statusFilePath: statusPath,
      nowMs: Date.parse('2026-09-05T03:10:00Z'),
      hourUtc: 3,
      minuteUtc: 0,
    });
    assert.equal(rWait.sent, false);
    assert.match(rWait.reason, /waiting for fresh digest/);
    assert.equal(sock.sent.length, 1);

    const nowLate = Date.parse('2026-09-05T03:20:00Z');
    await writeFile(statusPath, structuredDigest, 'utf8');
    await utimes(statusPath, new Date(nowLate), new Date(nowLate));

    const r2 = await runRedditCronDigestTick({
      getSocket: () => sock,
      getOwnerJid: () => '111@s.whatsapp.net',
      statusFilePath: statusPath,
      nowMs: nowLate,
      hourUtc: 3,
      minuteUtc: 0,
    });
    assert.equal(r2.sent, true);
    assert.equal(r2.reason, 'sent digest');
    assert.equal(sock.sent.length, 2);
    assert.match(sock.sent[1].text, /Cleanup: OK — merges=2/);
    const state = await readRedditCronDigestState();
    assert.equal(state.digestSent, true);
    assert.equal(state.alertSent, true);
  });

  it('truncates oversized digest bodies', async () => {
    const statusPath = join(tmpDir, 'big.txt');
    const body =
      'reddit-bot cron — 2026-09-05\n' + 'x'.repeat(5000);
    await writeFile(statusPath, body, 'utf8');
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
    await writeRedditCronDigestState('2026-09-05', {
      digestSent: false,
      alertSent: true,
    });
    assert.equal(await readRedditCronDigestLastSentDay(), null);
    const state = await readRedditCronDigestState();
    assert.equal(state.alertSent, true);
    assert.equal(utcCalendarDay(Date.parse('2026-09-04T23:59:00Z')), '2026-09-04');
  });
});
