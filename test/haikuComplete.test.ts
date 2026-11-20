import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bookCompleteFromEnv, haikuComplete, withFallback, BOOK_HAIKU_MODEL } from '../whatsapp/books/haikuComplete.ts';
import type { CreateMessage } from '../whatsapp/books/haikuComplete.ts';

const reply = (content: unknown[], stop_reason = 'end_turn') => (async () => ({ content, stop_reason })) as unknown as CreateMessage;
const minipc = async (prompt: string) => `minipc:${prompt}`;
const quiet = { warn() {}, info() {} };

describe('haikuComplete', () => {
  it('sends the prompt to Haiku 5.5 at low effort and returns the text blocks', async () => {
    const sent: unknown[] = [];
    const create = (async (p: unknown) => (sent.push(p), { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' {"picks":[]} ' }], stop_reason: 'end_turn' })) as unknown as CreateMessage;
    assert.equal(await haikuComplete(create)('pick'), '{"picks":[]}');
    assert.deepEqual(sent, [{ model: BOOK_HAIKU_MODEL, max_tokens: 16000, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'pick' }] }]);
  });

  it('throws on a refusal or an empty reply, so the caller can fall back', async () => {
    await assert.rejects(haikuComplete(reply([{ type: 'text', text: 'no' }], 'refusal'))('p'), /refused/);
    await assert.rejects(haikuComplete(reply([], 'max_tokens'))('p'), /no text/);
  });
});

describe('withFallback', () => {
  it('uses the mini PC when Haiku throws, and Haiku otherwise', async () => {
    const warned: unknown[] = [];
    const failing = async () => {
      throw new Error('529 overloaded');
    };
    assert.equal(await withFallback(failing, minipc, { warn: (o) => warned.push(o) })('p'), 'minipc:p');
    assert.deepEqual(warned, [{ err: '529 overloaded' }]);
    assert.equal(await withFallback(async () => 'haiku', minipc)('p'), 'haiku');
  });
});

describe('bookCompleteFromEnv', () => {
  it('stays on the mini PC unless BOOK_LLM=haiku and a key are both set', () => {
    assert.equal(bookCompleteFromEnv(minipc, quiet, {}), minipc);
    assert.equal(bookCompleteFromEnv(minipc, quiet, { ANTHROPIC_API_KEY: 'k' }), minipc);
    assert.equal(bookCompleteFromEnv(minipc, quiet, { BOOK_LLM: 'haiku' }), minipc);
    assert.notEqual(bookCompleteFromEnv(minipc, quiet, { BOOK_LLM: 'haiku', ANTHROPIC_API_KEY: 'k' }), minipc);
  });
});
