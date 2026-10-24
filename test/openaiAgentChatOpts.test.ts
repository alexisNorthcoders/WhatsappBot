import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openaiAgentChatOpts } from '../models/models.ts';

describe('openaiAgentChatOpts', () => {
  it('caps reasoning effort for reasoning models so the budget leaves room for the answer', () => {
    assert.deepEqual(openaiAgentChatOpts('gpt-5-nano', 1200), {
      max_completion_tokens: 1200,
      reasoning_effort: 'low',
    });
    assert.deepEqual(openaiAgentChatOpts('o4-mini', 800), {
      max_completion_tokens: 800,
      reasoning_effort: 'low',
    });
  });

  it('sends no reasoning_effort to models that reject it', () => {
    assert.deepEqual(openaiAgentChatOpts('gpt-4o-mini', 800), { max_tokens: 800 });
  });
});
