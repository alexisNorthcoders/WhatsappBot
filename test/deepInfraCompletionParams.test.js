import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeepInfraCompletionCreateArgs,
  DEEPINFRA_DEFAULT_CHAT_MODEL,
} from '../models/models.js';

describe('buildDeepInfraCompletionCreateArgs', () => {
  it('forwards temperature into the completion request body', () => {
    const body = buildDeepInfraCompletionCreateArgs('hello', 'my/model', { temperature: 0.35 });
    assert.equal(body.model, 'my/model');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(body.temperature, 0.35);
  });

  it('omits temperature when option is undefined or null', () => {
    const u = buildDeepInfraCompletionCreateArgs('x', DEEPINFRA_DEFAULT_CHAT_MODEL, {});
    assert.ok(!('temperature' in u));
    const n = buildDeepInfraCompletionCreateArgs('x', DEEPINFRA_DEFAULT_CHAT_MODEL, {
      temperature: null,
    });
    assert.ok(!('temperature' in n));
  });

  it('keeps the AbortSignal out of the request body', () => {
    const ac = new AbortController();
    const body = buildDeepInfraCompletionCreateArgs('x', DEEPINFRA_DEFAULT_CHAT_MODEL, {
      signal: ac.signal,
      temperature: 0,
    });
    assert.ok(!('signal' in body));
    assert.equal(body.temperature, 0);
  });
});
