// CDN caching (lib/cache.js): public answers carry s-maxage; anything with a session never does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CACHE, cacheable } from '../lib/cache.js';
import { config } from '../api/public.js';

function fakeRes() {
  const headers = {};
  return {
    headers, statusCode: 200, body: null,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('a plain GET with no session may be cached', () => {
  const res = fakeRes();
  assert.equal(cacheable({ method: 'GET', headers: {} }, res, CACHE.settings), true);
  assert.equal(res.headers['cache-control'], 'public, s-maxage=60, stale-while-revalidate=300');
});

test('never with an Authorization header, a POST, or the local dev account', () => {
  for (const req of [
    { method: 'GET', headers: { authorization: 'Bearer x' } },
    { method: 'POST', headers: {} },
    { method: 'GET', headers: {}, devAccountPhone: '+12045550000' },
  ]) {
    const res = fakeRes();
    assert.equal(cacheable(req, res, CACHE.settings), false);
    assert.equal(res.headers['cache-control'], undefined);
  }
});

test('/api/config is cached for an hour, and not when a session is sent', () => {
  let res = fakeRes();
  config({ method: 'GET', headers: {} }, res);
  assert.equal(res.headers['cache-control'], CACHE.config);
  res = fakeRes();
  config({ method: 'GET', headers: { authorization: 'Bearer x' } }, res);
  assert.equal(res.headers['cache-control'], undefined);
});

test('a day’s availability is never cached; the settings-only answer is', async () => {
  const { availability } = await import('../api/public.js');
  const db = await import('../lib/db.js');
  if (!db.admin()) return;                       // no database configured here: nothing to read
  let res = fakeRes();
  await availability({ method: 'GET', headers: {}, query: { date: '2026-11-07' } }, res);
  assert.equal(res.headers['cache-control'], undefined);
  res = fakeRes();
  await availability({ method: 'GET', headers: {}, query: {} }, res);
  if (res.body && res.body.dbEnabled) assert.equal(res.headers['cache-control'], CACHE.settings);
});
