import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  getPostRunReviewDiffText,
  getRepoHeadShaFull,
  maybeCommitReviewEmail,
} from '../whatsapp/agents/cursorPostRun.js';

const execFileAsync = promisify(execFile);

/** @param {string} repo */
async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

async function initBareRepoWithMain() {
  const repo = await mkdtemp(join(tmpdir(), 'wa-postrun-'));
  await execFileAsync('git', ['-C', repo, 'init'], { encoding: 'utf8' });
  await git(repo, ['config', 'user.email', 'test@test.local']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'README.md'), 'v0\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'init']);
  try {
    await git(repo, ['branch', '-M', 'main']);
  } catch {
    /* older git may already use master — rename if needed */
    const b = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (b === 'master') await git(repo, ['branch', '-M', 'main']);
  }
  return repo;
}

describe('getPostRunReviewDiffText', () => {
  it('clean + HEAD moved: aggregates multiple commits vs base (not only git show HEAD)', async () => {
    const repo = await initBareRepoWithMain();
    await git(repo, ['checkout', '-b', 'cursor/issue-35-work']);
    await writeFile(join(repo, 'a.txt'), 'a\n', 'utf8');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-m', 'add a']);
    await writeFile(join(repo, 'b.txt'), 'b\n', 'utf8');
    await git(repo, ['add', 'b.txt']);
    await git(repo, ['commit', '-m', 'add b']);
    const pre = await git(repo, ['rev-parse', 'HEAD~2']);
    const diff = await getPostRunReviewDiffText(
      repo,
      { prBase: 'main', branchName: 'cursor/issue-35-work' },
      { dirty: false, headMoved: true },
      pre,
      true
    );
    assert.match(diff, /a\.txt/);
    assert.match(diff, /b\.txt/);
  });

  it('dirty tree: uses working-tree / staged diff path (delegates to getDiffText)', async () => {
    const repo = await initBareRepoWithMain();
    await writeFile(join(repo, 'README.md'), 'v0\nmodified\n', 'utf8');
    const diff = await getPostRunReviewDiffText(
      repo,
      { prBase: 'main' },
      { dirty: true, headMoved: false },
      null,
      false
    );
    assert.match(diff, /README\.md/);
  });
});

describe('maybeCommitReviewEmail git gating', () => {
  const saved = {};

  beforeEach(() => {
    for (const k of [
      'CURSOR_POST_RUN',
      'CURSOR_POST_RUN_PUSH',
      'CURSOR_POST_RUN_PR',
      'CURSOR_POST_RUN_POLL_MS',
      'CURSOR_POST_RUN_MAX_WAIT_MS',
      'CURSOR_POST_RUN_LOG',
      'OPENAI_API_KEY',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.CURSOR_POST_RUN = '1';
    process.env.CURSOR_POST_RUN_PUSH = '0';
    process.env.CURSOR_POST_RUN_PR = '0';
    process.env.CURSOR_POST_RUN_LOG = '0';
    process.env.CURSOR_POST_RUN_POLL_MS = '0';
    process.env.CURSOR_POST_RUN_MAX_WAIT_MS = '40';
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('clean tree + unchanged HEAD: skips with clean_after_wait', async () => {
    const repo = await initBareRepoWithMain();
    const pre = await getRepoHeadShaFull(repo);
    const post = await maybeCommitReviewEmail({
      repo,
      userPrompt: 'unit test',
      agentRunOk: true,
      issueMode: { number: 35 },
      preAgentHeadSha: pre,
    });
    assert.equal(post.ran, false);
    assert.equal(post.skipReason, 'clean_after_wait');
  });

  it('clean tree + new commit(s): runs post-run without empty_diff (uses pre…HEAD when branch tip equals base)', async () => {
    const repo = await initBareRepoWithMain();
    const pre = await getRepoHeadShaFull(repo);
    await writeFile(join(repo, 'feature.txt'), 'ok\n', 'utf8');
    await git(repo, ['add', 'feature.txt']);
    await git(repo, ['commit', '-m', 'agent commit']);
    const post = await maybeCommitReviewEmail({
      repo,
      userPrompt: 'unit test',
      agentRunOk: true,
      issueMode: { number: 35 },
      preAgentHeadSha: pre,
    });
    assert.equal(post.ran, true);
    assert.notEqual(post.skipReason, 'empty_diff');
    assert.equal(post.commit?.ok, true);
    assert.ok(post.review && post.review.length > 0);
  });

  it('dirty tree: tryCommit then proceeds (no empty_diff)', async () => {
    const repo = await initBareRepoWithMain();
    const pre = await getRepoHeadShaFull(repo);
    await writeFile(join(repo, 'wip.txt'), 'wip\n', 'utf8');
    const post = await maybeCommitReviewEmail({
      repo,
      userPrompt: 'unit test dirty',
      agentRunOk: true,
      issueMode: { number: 36 },
      preAgentHeadSha: pre,
    });
    assert.equal(post.ran, true);
    assert.notEqual(post.skipReason, 'empty_diff');
    assert.equal(post.commit?.ok, true);
    assert.ok(post.review && post.review.length > 0);
  });
});
