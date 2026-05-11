import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeepInfraImageGenerationsBody } from '../models/models.js';

describe('buildDeepInfraImageGenerationsBody', () => {
  it('fills defaults (size, n)', () => {
    const body = buildDeepInfraImageGenerationsBody({
      prompt: 'x',
      model: 'stabilityai/sdxl-turbo',
    });
    assert.equal(body.prompt, 'x');
    assert.equal(body.model, 'stabilityai/sdxl-turbo');
    assert.equal(body.size, '1024x1024');
    assert.equal(body.n, 1);
  });

  it('forwards explicit size and n', () => {
    const body = buildDeepInfraImageGenerationsBody({
      prompt: 'astronaut',
      model: 'stabilityai/sdxl-turbo',
      size: '512x512',
      n: 2,
    });
    assert.deepEqual(body, {
      prompt: 'astronaut',
      model: 'stabilityai/sdxl-turbo',
      size: '512x512',
      n: 2,
    });
  });
});

