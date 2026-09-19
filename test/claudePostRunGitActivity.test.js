import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  claudePostRunExec,
  getPostRunReviewDiffText,
  getRepoHeadShaFull,
  maybeCommitReviewEmail,
  prepareWorkspaceForGithubIssue,
} from '../whatsapp/agents/claudePostRun.js';

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
    await git(repo, ['checkout', '-b', 'claude/issue-35-work']);
    await writeFile(join(repo, 'a.txt'), 'a\n', 'utf8');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-m', 'add a']);
    await writeFile(join(repo, 'b.txt'), 'b\n', 'utf8');
    await git(repo, ['add', 'b.txt']);
    await git(repo, ['commit', '-m', 'add b']);
    const pre = await git(repo, ['rev-parse', 'HEAD~2']);
    const diff = await getPostRunReviewDiffText(
      repo,
      { prBase: 'main', branchName: 'claude/issue-35-work' },
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
      'CLAUDE_POST_RUN',
      'CLAUDE_POST_RUN_PUSH',
      'CLAUDE_POST_RUN_PR',
      'CLAUDE_POST_RUN_POLL_MS',
      'CLAUDE_POST_RUN_MAX_WAIT_MS',
      'CLAUDE_POST_RUN_LOG',
      'OPENAI_API_KEY',
    ]) {
      saved[k] = process.env[k];
    }
    process.env.CLAUDE_POST_RUN = '1';
    process.env.CLAUDE_POST_RUN_PUSH = '0';
    process.env.CLAUDE_POST_RUN_PR = '0';
    process.env.CLAUDE_POST_RUN_LOG = '0';
    process.env.CLAUDE_POST_RUN_POLL_MS = '0';
    process.env.CLAUDE_POST_RUN_MAX_WAIT_MS = '40';
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

  it('clean tree + unchanged HEAD but the branch has an open PR: re-reviews that PR instead of skipping', async () => {
    const repo = await initBareRepoWithMain();
    await git(repo, ['checkout', '-b', 'claude/issue-35-work']);
    await writeFile(join(repo, 'feature.txt'), 'ok\n', 'utf8');
    await git(repo, ['add', 'feature.txt']);
    await git(repo, ['commit', '-m', 'earlier run']);
    const pre = await getRepoHeadShaFull(repo);
    const PR = 'https://github.com/o/r/pull/46';
    /** @type {string[][]} */
    const ghCalls = [];
    const realExecFile = claudePostRunExec.execFile;
    claudePostRunExec.execFile = (command, args, options, callback) => {
      if (command !== 'gh') return realExecFile(command, args, options, callback);
      ghCalls.push(args);
      const out =
        args[0] === 'pr' && args[1] === 'list'
          ? JSON.stringify([{ url: PR }])
          : JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', state: 'OPEN' });
      process.nextTick(() => callback(null, out, ''));
    };
    try {
      const post = await maybeCommitReviewEmail({
        repo,
        userPrompt: 'unit test',
        agentRunOk: true,
        issueMode: { number: 35 },
        preAgentHeadSha: pre,
      });
      assert.notEqual(post.skipReason, 'clean_after_wait');
      assert.equal(post.ran, true);
      assert.match(post.note, /re-reviewed the open PR https:\/\/github\.com\/o\/r\/pull\/46 \(conflict\)/);
      assert.ok(ghCalls.some((a) => a.includes('--head') && a.includes('claude/issue-35-work')));
    } finally {
      claudePostRunExec.execFile = realExecFile;
    }
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

describe('prepareWorkspaceForGithubIssue resume', () => {
  it('fast-forwards the resumed issue branch to what was already pushed, so new commits push cleanly', async () => {
    const repo = await initBareRepoWithMain();
    const origin = await mkdtemp(join(tmpdir(), 'wa-origin-'));
    await execFileAsync('git', ['init', '--bare', origin], { encoding: 'utf8' });
    await git(repo, ['remote', 'add', 'origin', origin]);
    await git(repo, ['checkout', '-b', 'claude/issue-9-thing']);
    await git(repo, ['push', '-u', 'origin', 'claude/issue-9-thing']);

    // Someone else (an earlier run elsewhere, or a manual fix) pushes on top of the branch.
    const other = await mkdtemp(join(tmpdir(), 'wa-clone-'));
    await execFileAsync('git', ['clone', '-q', '-b', 'claude/issue-9-thing', origin, other], { encoding: 'utf8' });
    await git(other, ['config', 'user.email', 'test@test.local']);
    await git(other, ['config', 'user.name', 'test']);
    await writeFile(join(other, 'fix.txt'), 'fix\n', 'utf8');
    await git(other, ['add', 'fix.txt']);
    await git(other, ['commit', '-m', 'pushed fix']);
    await git(other, ['push', '-q']);
    const pushedTip = await git(other, ['rev-parse', 'HEAD']);

    const prep = await prepareWorkspaceForGithubIssue(repo, 9, 'thing');
    assert.equal(prep.resumed, true);
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), pushedTip);
  });
});
