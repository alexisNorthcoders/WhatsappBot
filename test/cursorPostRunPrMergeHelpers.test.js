import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import {
  cursorPostRunExec,
  githubPrMergeErrorLooksStaleHead,
  githubPrUpdateBranchErrorLooksNoOp,
  pickGithubMergeStrategy,
  githubMergeMethodSummaryLabel,
  tryGhRepoMergeCapabilities,
  tryGhPrQueueAutoMerge,
} from '../whatsapp/agents/cursorPostRun.js';

const realExecFile = childProcess.execFile.bind(childProcess);

function restoreExecFile() {
  cursorPostRunExec.execFile = (command, args, options, callback) =>
    realExecFile(command, args, options, callback);
}

describe('PR merge / update-branch error heuristics', () => {
  it('detects stale-head auto-merge errors', () => {
    assert.equal(
      githubPrMergeErrorLooksStaleHead(
        'Head branch is out of date. Review and try the merge again.'
      ),
      true
    );
    assert.equal(githubPrMergeErrorLooksStaleHead('unrelated failure'), false);
  });

  it('treats GitHub update-branch 422 no-op as retryable', () => {
    const msg =
      '{"message":"There are no new commits on the base branch.","status":"422"}gh: There are no new commits on the base branch. (HTTP 422)';
    assert.equal(githubPrUpdateBranchErrorLooksNoOp(msg), true);
    assert.equal(githubPrUpdateBranchErrorLooksNoOp('merge conflict on update-branch'), false);
  });

  it('pickGithubMergeStrategy prefers squash, then merge, then rebase', () => {
    assert.equal(
      pickGithubMergeStrategy({
        allow_squash_merge: true,
        allow_merge_commit: true,
        allow_rebase_merge: true,
      }),
      'squash'
    );
    assert.equal(
      pickGithubMergeStrategy({
        allow_squash_merge: false,
        allow_merge_commit: true,
        allow_rebase_merge: true,
      }),
      'merge'
    );
    assert.equal(
      pickGithubMergeStrategy({
        allow_squash_merge: false,
        allow_merge_commit: false,
        allow_rebase_merge: true,
      }),
      'rebase'
    );
    assert.equal(pickGithubMergeStrategy({}), null);
  });

  it('githubMergeMethodSummaryLabel matches WhatsApp / note wording', () => {
    assert.equal(githubMergeMethodSummaryLabel('squash'), 'squash');
    assert.equal(githubMergeMethodSummaryLabel('merge'), 'merge commit');
    assert.equal(githubMergeMethodSummaryLabel('rebase'), 'rebase');
  });
});

describe('tryGhRepoMergeCapabilities (mocked gh)', () => {
  afterEach(() => {
    restoreExecFile();
  });

  it('rejects non-JSON stdout with a clear error', async () => {
    cursorPostRunExec.execFile = (cmd, args, opts, cb) => {
      assert.equal(cmd, 'gh');
      cb(null, 'NOTICE: extra noise\nnot-json', '');
    };
    const r = await tryGhRepoMergeCapabilities('/repo', 'o', 'r');
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not parse gh api --jq JSON/);
  });

  it('rejects jq output missing a required key', async () => {
    cursorPostRunExec.execFile = (_cmd, _args, _opts, cb) => {
      cb(
        null,
        JSON.stringify({
          allow_squash_merge: true,
          allow_merge_commit: true,
          allow_rebase_merge: true,
        }),
        ''
      );
    };
    const r = await tryGhRepoMergeCapabilities('/repo', 'o', 'r');
    assert.equal(r.ok, false);
    assert.match(r.error, /missing "allow_auto_merge"/);
  });

  it('rejects non-boolean allow_auto_merge (e.g. JSON null)', async () => {
    cursorPostRunExec.execFile = (_cmd, _args, _opts, cb) => {
      cb(
        null,
        JSON.stringify({
          allow_squash_merge: false,
          allow_merge_commit: true,
          allow_rebase_merge: true,
          allow_auto_merge: null,
        }),
        ''
      );
    };
    const r = await tryGhRepoMergeCapabilities('/repo', 'o', 'r');
    assert.equal(r.ok, false);
    assert.match(r.error, /non-boolean allow_auto_merge/);
  });

  it('accepts exact GitHub REST-style boolean shape', async () => {
    cursorPostRunExec.execFile = (cmd, args, opts, cb) => {
      assert.equal(cmd, 'gh');
      assert.deepEqual(args.slice(0, 3), ['api', 'repos/acme/widget', '--jq']);
      cb(
        null,
        JSON.stringify({
          allow_squash_merge: true,
          allow_merge_commit: false,
          allow_rebase_merge: false,
          allow_auto_merge: true,
        }),
        ''
      );
    };
    const r = await tryGhRepoMergeCapabilities('/repo', 'acme', 'widget');
    assert.equal(r.ok, true);
    assert.deepEqual(r, {
      ok: true,
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_auto_merge: true,
    });
  });
});

describe('tryGhPrQueueAutoMerge (mocked gh, issue #47)', () => {
  afterEach(() => {
    restoreExecFile();
  });

  it('falls back to merge commit when squash is disabled but merge + auto-merge are allowed', async () => {
    /** @type {{ cmd: string, args: string[] }[]} */
    const calls = [];
    cursorPostRunExec.execFile = (cmd, args, opts, cb) => {
      calls.push({ cmd, args: [...args] });
      const sub = args[0];
      if (sub === 'api' && String(args[1] || '').startsWith('repos/')) {
        cb(
          null,
          JSON.stringify({
            allow_squash_merge: false,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            allow_auto_merge: true,
          }),
          ''
        );
        return;
      }
      if (sub === 'pr' && args[1] === 'merge') {
        assert.ok(args.includes('--auto'));
        assert.ok(args.includes('--merge'));
        assert.ok(!args.includes('--squash'));
        cb(null, '', '');
        return;
      }
      cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
    };

    const r = await tryGhPrQueueAutoMerge('/tmp/r', 'https://github.com/o/r/pull/47');
    assert.equal(r.ok, true);
    assert.equal(r.mergeMethod, 'merge');
    assert.equal(calls.length, 2);
    assert.match(calls[0].args[1], /^repos\/o\/r$/);
    assert.equal(calls[1].args[0], 'pr');
  });

  it('fails fast when allow_auto_merge is false (repo setting)', async () => {
    cursorPostRunExec.execFile = (_cmd, args, _opts, cb) => {
      if (args[0] === 'api') {
        cb(
          null,
          JSON.stringify({
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            allow_auto_merge: false,
          }),
          ''
        );
        return;
      }
      cb(new Error('gh pr merge must not run when auto-merge is disabled at repo level'));
    };
    const r = await tryGhPrQueueAutoMerge('/tmp/r', 'https://github.com/o/rr/pull/2');
    assert.equal(r.ok, false);
    assert.match(r.error, /Allow auto-merge/);
  });
});
