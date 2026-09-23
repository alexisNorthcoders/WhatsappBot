import { test } from 'node:test';
import assert from 'node:assert/strict';
import NodeCache from '@cacheable/node-cache';
import {
  createMsgRetryCounterCache,
  socketCacheOptions,
} from '../whatsapp/socketCacheOptions.js';

test('msgRetryCounterCache is a TTL-backed node-cache', () => {
  const cache = createMsgRetryCounterCache();
  assert.ok(cache instanceof NodeCache);
  assert.ok(cache.options.stdTTL > 0);
  cache.set('msg-1', 2);
  assert.equal(cache.get('msg-1'), 2);
});

test('socket options pass the retry cache and no custom userDevicesCache', () => {
  const cache = createMsgRetryCounterCache();
  const opts = socketCacheOptions(cache);
  assert.equal(opts.msgRetryCounterCache, cache);
  assert.equal(opts.maxMsgRetryCount, 3);
  assert.ok(!('userDevicesCache' in opts));
});
