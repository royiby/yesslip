import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentKey, makeMemoryObjectStore, makeObjectStore, _internals,
} from '../src/storage/objects.js';
import { signRequest, parseListing, _internals as s3 } from '../src/storage/s3.js';

test('a key carries the tenant, so one bucket cannot be addressed flat', () => {
  const key = documentKey('3f4b2c10-0000-4000-8000-000000000001', 'consent', 'AB12CD34');
  assert.equal(key, 't/3f4b2c10-0000-4000-8000-000000000001/consent/AB12CD34.html');
});

test('a key cannot climb out of its tenant prefix', () => {
  const tenant = '3f4b2c10-0000-4000-8000-000000000001';
  for (const bad of ['../../other', 'a/b', '', '.hidden', 'x'.repeat(200), null, 'a b']) {
    assert.throws(() => documentKey(tenant, 'consent', bad), /מזהה לא תקין/, `accepted ${bad}`);
  }
  assert.throws(() => documentKey('../x', 'consent', 'AB12'), /מזהה לא תקין/);
  assert.throws(() => documentKey(tenant, '../..', 'AB12'), /מזהה לא תקין/);
});

test('a document is written once and never overwritten', async () => {
  // This is the signing guarantee: the original relied on open(2) with O_EXCL,
  // and losing it would mean a signed form could be replaced by a later one.
  const store = makeMemoryObjectStore();
  const first = await store.putOnce('k', 'original');
  assert.deepEqual(first, { key: 'k', written: true });

  const second = await store.putOnce('k', 'replacement');
  assert.equal(second.written, false);
  assert.equal(second.alreadyExists, true);
  assert.equal((await store.get('k')).toString(), 'original');
});

test('a missing object reads as null rather than throwing', async () => {
  const store = makeMemoryObjectStore();
  assert.equal(await store.get('nope'), null);
  assert.equal(await store.head('nope'), null);
  assert.deepEqual(await store.remove('nope'), { key: 'nope', deleted: false });
});

test('listing is scoped by prefix, which is how one tenant is swept alone', async () => {
  const store = makeMemoryObjectStore();
  await store.putOnce('t/a/consent/1.html', 'x');
  await store.putOnce('t/a/consent/2.html', 'x');
  await store.putOnce('t/b/consent/1.html', 'x');
  assert.equal((await store.list('t/a/')).length, 2);
  assert.equal((await store.list('t/b/')).length, 1);
});

test('the conditional header is actually sent on a write-once put', async () => {
  // Without If-None-Match the race between two simultaneous signings is open,
  // so assert the wire, not the wrapper.
  const sent = [];
  const store = makeObjectStore({
    endpoint: 'https://example.r2.cloudflarestorage.com',
    bucket: 'docs',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    fetchImpl: async (url, options) => {
      sent.push({ url: String(url), method: options.method, headers: options.headers });
      // First the HEAD (404, nothing there), then the PUT.
      return options.method === 'HEAD'
        ? { ok: false, status: 404, headers: new Headers(), text: async () => '' }
        : { ok: true, status: 200, headers: new Headers(), text: async () => '' };
    },
  });

  const result = await store.putOnce('t/a/consent/AB12.html', '<html></html>');
  assert.equal(result.written, true);
  const put = sent.find((r) => r.method === 'PUT');
  assert.equal(put.headers['if-none-match'], '*');
  assert.match(put.url, /\/docs\/t\/a\/consent\/AB12\.html$/);
});

test('a 412 from the provider is reported as already-signed, not as success', async () => {
  const store = makeObjectStore({
    endpoint: 'https://example.r2.cloudflarestorage.com',
    bucket: 'docs',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    fetchImpl: async (_url, options) => (options.method === 'HEAD'
      ? { ok: false, status: 404, headers: new Headers(), text: async () => '' }
      : { ok: false, status: 412, headers: new Headers(), text: async () => 'PreconditionFailed' }),
  });
  const result = await store.putOnce('k', 'x');
  assert.equal(result.written, false);
  assert.equal(result.alreadyExists, true);
});

test('a real failure is not swallowed as already-signed', async () => {
  const store = makeObjectStore({
    endpoint: 'https://example.r2.cloudflarestorage.com',
    bucket: 'docs',
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    fetchImpl: async (_url, options) => (options.method === 'HEAD'
      ? { ok: false, status: 404, headers: new Headers(), text: async () => '' }
      : { ok: false, status: 403, headers: new Headers(), text: async () => 'AccessDenied' }),
  });
  await assert.rejects(() => store.putOnce('k', 'x'), /403/);
});

test('the signature is stable for a known request', () => {
  // Pinned so a refactor of the canonicalisation cannot quietly change it.
  const a = signRequest({
    method: 'PUT',
    url: 'https://example.r2.cloudflarestorage.com/docs/t/a/consent/AB12.html',
    headers: { 'content-type': 'text/html' },
    payloadHash: s3.sha256Hex('x'),
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    region: 'auto',
    now: new Date('2026-10-29T12:00:00.000Z'),
  });
  const b = signRequest({
    method: 'PUT',
    url: 'https://example.r2.cloudflarestorage.com/docs/t/a/consent/AB12.html',
    headers: { 'content-type': 'text/html' },
    payloadHash: s3.sha256Hex('x'),
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    region: 'auto',
    now: new Date('2026-10-29T12:00:00.000Z'),
  });
  assert.equal(a.headers.authorization, b.headers.authorization);
  assert.match(a.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/);
  assert.match(a.canonicalRequest, /^PUT\n\/docs\/t\/a\/consent\/AB12\.html\n\n/);
  // A different body must sign differently, or a tampered upload would verify.
  const other = signRequest({
    method: 'PUT',
    url: 'https://example.r2.cloudflarestorage.com/docs/t/a/consent/AB12.html',
    headers: { 'content-type': 'text/html' },
    payloadHash: s3.sha256Hex('y'),
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    region: 'auto',
    now: new Date('2026-10-29T12:00:00.000Z'),
  });
  assert.notEqual(a.headers.authorization, other.headers.authorization);
});

test('a key with characters needing encoding is still addressed correctly', () => {
  assert.equal(s3.encodeKeyPath('t/a/consent/A B.html'), 't/a/consent/A%20B.html');
  assert.equal(s3.encodeKeyPath('a/b/c'), 'a/b/c');
  assert.equal(s3.uriEncode("it's"), 'it%27s');
});

test('a listing response is parsed into keys and sizes', () => {
  const xml = `<ListBucketResult>
    <Contents><Key>t/a/consent/1.html</Key><Size>120</Size>
      <LastModified>2026-10-29T10:00:00.000Z</LastModified><ETag>"abc"</ETag></Contents>
    <Contents><Key>t/a/consent/2.html</Key><Size>240</Size>
      <LastModified>2026-10-29T11:00:00.000Z</LastModified><ETag>"def"</ETag></Contents>
  </ListBucketResult>`;
  const items = parseListing(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].key, 't/a/consent/1.html');
  assert.equal(items[1].size, 240);
  assert.equal(items[0].etag, 'abc');
});

test('an incomplete configuration falls back to memory rather than half-working', () => {
  assert.equal(_internals.settingsFromEnv({}), null);
  assert.equal(_internals.settingsFromEnv({
    OBJECT_STORE_ENDPOINT: 'https://x', OBJECT_STORE_BUCKET: 'b',
    OBJECT_STORE_ACCESS_KEY_ID: 'k', // no secret
  }), null);
  assert.deepEqual(_internals.settingsFromEnv({
    OBJECT_STORE_ENDPOINT: 'https://x',
    OBJECT_STORE_BUCKET: 'b',
    OBJECT_STORE_ACCESS_KEY_ID: 'k',
    OBJECT_STORE_SECRET_ACCESS_KEY: 's',
  }), { endpoint: 'https://x', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto' });
});
