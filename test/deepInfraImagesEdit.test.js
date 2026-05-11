import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferFromOpenAIImageDataEntry,
  deepInfraImagesEdit,
  DEEPINFRA_IMAGE_EDITS_URL,
  DEEPINFRA_QWEN_IMAGE_EDIT_MODEL,
} from '../models/models.js';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('deepInfraImagesEdit', () => {
  let prevKey;

  beforeEach(() => {
    prevKey = process.env.DEEPINFRA_API_KEY;
    process.env.DEEPINFRA_API_KEY = 'test-deepinfra-key';
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.DEEPINFRA_API_KEY;
    else process.env.DEEPINFRA_API_KEY = prevKey;
  });

  it('throws when DEEPINFRA_API_KEY is missing', async () => {
    delete process.env.DEEPINFRA_API_KEY;
    await assert.rejects(
      () =>
        deepInfraImagesEdit(
          { image: Buffer.from([0]) },
          { fetchFn: async () => new Response('{}') },
        ),
      /DEEPINFRA_API_KEY is not set.*image edits/i,
    );
  });

  it('rejects non-Buffer/non-Uint8Array image payloads before fetch', async () => {
    let invoked = false;
    const fetchFn = async () => {
      invoked = true;
      return new Response('{}');
    };
    await assert.rejects(
      () => deepInfraImagesEdit({ image: 'not-binary' }, { fetchFn }),
      /Image must be a Buffer or Uint8Array/i,
    );
    assert.equal(invoked, false);
  });

  it('POSTs multipart to the edits URL with Bearer auth and expected form fields', async () => {
    const captures = [];

    const fetchFn = async (url, init) => {
      captures.push({ url, init });
      return new Response(
        JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const image = Buffer.from([1, 2, 3, 4]);
    await deepInfraImagesEdit(
      {
        image,
        prompt: '  warm tint  ',
        imageFilename: 'input.png',
        imageMimeType: 'image/png',
        size: '512x512',
        n: 2,
      },
      { fetchFn },
    );

    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, DEEPINFRA_IMAGE_EDITS_URL);
    assert.equal(captures[0].init.method ?? 'GET', 'POST');
    assert.equal(captures[0].init.headers.Authorization, 'Bearer test-deepinfra-key');

    assert.ok(captures[0].init.body instanceof FormData);
    const form = captures[0].init.body;
    const fields = [...form.entries()];

    const get = (k) =>
      fields
        .filter(([name]) => name === k)
        .map(([, v]) => v);

    assert.equal(get('model').join(), DEEPINFRA_QWEN_IMAGE_EDIT_MODEL);
    assert.equal(get('size').join(), '512x512');
    assert.equal(get('n').join(), '2');
    assert.equal(get('prompt').join(), 'warm tint');

    const imageParts = get('image');
    assert.equal(imageParts.length, 1);
    const fileOrBlob = imageParts[0];
    assert.ok(
      fileOrBlob instanceof Blob || (typeof File !== 'undefined' && fileOrBlob instanceof File),
    );

    assert.ok(image.equals(Buffer.from(await fileOrBlob.arrayBuffer())));
  });

  it('parses HTTP 200 JSON with b64_json image entry', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const out = await deepInfraImagesEdit({ image: new Uint8Array([9, 9]) }, { fetchFn });
    assert.equal(Buffer.from(out.data[0].b64_json, 'base64').length > 0, true);
  });

  it('parses HTTP 200 JSON with url-only image entry', async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ data: [{ url: 'https://example.invalid/out.png' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const out = await deepInfraImagesEdit({ image: Buffer.from([0xff]) }, { fetchFn });
    assert.equal(out.data[0].url, 'https://example.invalid/out.png');
  });

  it('works with Uint8Array image input for multipart Blob', async () => {
    const fetchFn = async (_, init) =>
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const u8 = new Uint8Array([10, 20, 30]);
    await deepInfraImagesEdit({ image: u8 }, { fetchFn });
  });
});

describe('bufferFromOpenAIImageDataEntry', () => {
  it('returns buffer from b64_json', async () => {
    const buf = await bufferFromOpenAIImageDataEntry({ b64_json: TINY_PNG_B64 });
    assert.equal(buf.equals(Buffer.from(TINY_PNG_B64, 'base64')), true);
  });

  it('downloads when only url is present', async () => {
    const expected = Buffer.from([0xaa, 0xbb]);

    const fetchFn = async (url) => {
      assert.equal(url, 'https://cdn.example/out.bin');
      return new Response(expected, { status: 200 });
    };

    const buf = await bufferFromOpenAIImageDataEntry(
      { url: 'https://cdn.example/out.bin' },
      { fetchFn },
    );

    assert.equal(buf.equals(expected), true);
  });
});
