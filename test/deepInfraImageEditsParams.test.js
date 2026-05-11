import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeepInfraImageEditsFormFields,
  DEEPINFRA_QWEN_IMAGE_EDIT_MODEL,
} from '../models/models.js';

describe('buildDeepInfraImageEditsFormFields', () => {
  it('fills defaults and omits prompt when not provided', () => {
    const fields = buildDeepInfraImageEditsFormFields({});
    assert.equal(fields.model, DEEPINFRA_QWEN_IMAGE_EDIT_MODEL);
    assert.equal(fields.size, '1024x1024');
    assert.equal(fields.n, 1);
    assert.equal('prompt' in fields, false);
  });

  it('omits prompt for blank or whitespace-only strings', () => {
    assert.equal('prompt' in buildDeepInfraImageEditsFormFields({ prompt: '' }), false);
    assert.equal('prompt' in buildDeepInfraImageEditsFormFields({ prompt: '  \n\t  ' }), false);
  });

  it('forwards explicit model, size, n, and trimmed prompt', () => {
    const fields = buildDeepInfraImageEditsFormFields({
      model: 'other/model',
      size: '512x512',
      n: 2,
      prompt: '  make it warmer  ',
    });
    assert.deepEqual(fields, {
      model: 'other/model',
      size: '512x512',
      n: 2,
      prompt: 'make it warmer',
    });
  });
});
