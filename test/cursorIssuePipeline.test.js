import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessageFromUnknown } from '../whatsapp/agents/cursorIssuePipeline.js';

describe('errorMessageFromUnknown', () => {
  it('uses Error.message', () => {
    assert.equal(errorMessageFromUnknown(new Error('oops')), 'oops');
  });

  it('stringifies non-Error throws', () => {
    assert.equal(errorMessageFromUnknown('boom'), 'boom');
    assert.equal(errorMessageFromUnknown(null), 'null');
  });

  it('reads message from plain object', () => {
    assert.equal(errorMessageFromUnknown({ message: 'from object' }), 'from object');
  });

  it('falls back when message is empty', () => {
    assert.ok(
      String(errorMessageFromUnknown({ message: '' })).length > 0
    );
  });
});
