import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { githubCliErrorLooksTransient } from '../whatsapp/agents/ghIssueForCursor.js';

describe('githubCliErrorLooksTransient', () => {
  it('detects GraphQL gateway timeout from gh', () => {
    assert.equal(
      githubCliErrorLooksTransient(
        'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)'
      ),
      true
    );
  });

  it('detects common HTTP errors', () => {
    assert.equal(githubCliErrorLooksTransient('HTTP 502: bad gateway'), true);
    assert.equal(githubCliErrorLooksTransient('HTTP 503'), true);
    assert.equal(githubCliErrorLooksTransient('HTTP 429: rate limit'), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(githubCliErrorLooksTransient('issue 999 not found'), false);
    assert.equal(githubCliErrorLooksTransient('GraphQL: Could not resolve'), false);
  });
});
