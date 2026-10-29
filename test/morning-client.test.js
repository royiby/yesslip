import test from 'node:test';
import assert from 'node:assert/strict';
import { createMorningClient } from '../src/morning/client.js';
import { fakeFetch } from './_helpers.js';

/**
 * The bug this file is about: the single-tenant original kept its Morning
 * access token in a module-level `let`, so in one process serving two
 * businesses, whichever tenant authenticated first supplied the token for
 * every subsequent call. The symptom is one business reading another's
 * invoices, and every response looks valid.
 *
 * These tests assert the property that makes it impossible: a client's token
 * lives in that client's closure, and a client belongs to one tenant.
 */

const isAuth = (url) => url.includes('/idp/v1/oauth/token');

/** Issues a distinct token per client_id, so a mix-up is visible. */
function morningStub({ plugins = [{ id: 'plugin-uuid', name: 'Grow' }], onApi } = {}) {
  return fakeFetch(async ({ url, body }) => {
    if (isAuth(url)) {
      return { status: 200, body: { accessToken: `token-for-${body.client_id}`, expires_in: 3600 } };
    }
    if (onApi) {
      const reply = await onApi({ url, body });
      if (reply) return reply;
    }
    if (url.includes('/businesses/me')) return { status: 200, body: { name: 'עסק' } };
    if (url.includes('/documents/info')) return { status: 200, body: { paymentPlugins: plugins } };
    return { status: 200, body: {} };
  });
}

function client(tenantId, keyId, impl, extra = {}) {
  return createMorningClient({
    tenantId, keyId, keySecret: `${keyId}-secret`, environment: 'sandbox', fetchImpl: impl, ...extra,
  });
}

test('a new client starts with no token', () => {
  const a = client('t-a', 'key-a', morningStub());
  assert.equal(a._tokenState(), null);
});

test('two tenants never share a token', async () => {
  const impl = morningStub();
  const a = client('t-a', 'key-a', impl);
  const b = client('t-b', 'key-b', impl);

  await a.businessInfo();
  await b.businessInfo();

  assert.equal(a._tokenState().accessToken, 'token-for-key-a');
  assert.equal(b._tokenState().accessToken, 'token-for-key-b');

  // And each resource call carried its own tenant's bearer. This is the
  // assertion that would have caught the original bug.
  const bearers = impl.calls
    .filter((c) => !isAuth(c.url))
    .map((c) => c.headers.Authorization);
  assert.deepEqual(bearers, ['Bearer token-for-key-a', 'Bearer token-for-key-b']);
});

test('a second tenant authenticating does not change the first tenant token', async () => {
  const impl = morningStub();
  const a = client('t-a', 'key-a', impl);
  await a.businessInfo();
  const before = a._tokenState().accessToken;

  const b = client('t-b', 'key-b', impl);
  await b.businessInfo();

  assert.equal(a._tokenState().accessToken, before);
  await a.businessInfo();
  const last = impl.calls.at(-1);
  assert.equal(last.headers.Authorization, 'Bearer token-for-key-a');
});

test('a token is reused rather than re-fetched on every call', async () => {
  const impl = morningStub();
  const a = client('t-a', 'key-a', impl);
  await a.businessInfo();
  await a.businessInfo();
  await a.businessInfo();
  assert.equal(impl.calls.filter((c) => isAuth(c.url)).length, 1);
});

test('a 401 clears only the client that saw it', async () => {
  let reject = false;
  const impl = morningStub({
    onApi: ({ url }) => (reject && url.includes('/businesses/me') ? { status: 401, body: 'nope' } : null),
  });
  const a = client('t-a', 'key-a', impl);
  const b = client('t-b', 'key-b', impl);

  await a.businessInfo();
  await b.businessInfo();
  assert.ok(a._tokenState());

  reject = true;
  await assert.rejects(() => a.businessInfo(), /401/);

  assert.equal(a._tokenState(), null, 'the rejected client should drop its token');
  assert.ok(b._tokenState(), 'the other tenant token must be untouched');
});

test('an auth failure names the environment rather than guessing', async () => {
  const impl = fakeFetch(async () => ({ status: 401, body: 'bad key' }));
  const a = client('t-a', 'key-a', impl);
  await assert.rejects(() => a.businessInfo(), /sandbox/);
});

test('verifyConnection reports a missing clearing instead of failing later', async () => {
  // The expensive failure is a tenant who finishes onboarding, sends the link
  // to forty parents, and only then finds out nobody can pay.
  const impl = morningStub({ plugins: [] });
  const result = await client('t-a', 'key-a', impl).verifyConnection();
  assert.equal(result.ok, false);
  assert.match(result.problem, /Grow/);
  assert.equal(result.pluginId, null);
});

test('verifyConnection discovers the clearing id so the tenant never sees a UUID', async () => {
  const result = await client('t-a', 'key-a', morningStub()).verifyConnection();
  assert.equal(result.ok, true);
  assert.equal(result.pluginId, 'plugin-uuid');
  assert.equal(result.problem, null);
});

test('a payment form is refused when no clearing is configured', async () => {
  const a = client('t-a', 'key-a', morningStub());
  await assert.rejects(
    () => a.createPaymentForm({ description: 'הרשמה', amount: 100 }),
    /אין סליקה מוגדרת/,
  );
});

test('a payment form carries this tenant own notifyUrl, plugin and correlation', async () => {
  const impl = morningStub({
    onApi: ({ url }) => (url.includes('/payments/form')
      ? { status: 200, body: { url: 'https://pay.example/abc', id: 'link-1' } }
      : null),
  });
  const a = client('t-a', 'key-a', impl, { pluginId: 'plugin-a' });

  const result = await a.createPaymentForm({
    description: 'הרשמה',
    amount: 250,
    notifyUrl: 'https://app.example/api/morning/webhook/tenant-a?secret=aaa',
    custom: 'order-123',
  });

  assert.equal(result.url, 'https://pay.example/abc');
  const sent = impl.calls.find((c) => c.url.includes('/payments/form')).body;
  // notifyUrl is per request, not per account. That is what lets many tenants
  // share one process and still each get their own webhook and secret.
  assert.equal(sent.notifyUrl, 'https://app.example/api/morning/webhook/tenant-a?secret=aaa');
  assert.equal(sent.pluginId, 'plugin-a');
  assert.equal(sent.custom, 'order-123');
});

test('a standing order sends documentVatType 0, not the line item vatType', async () => {
  // Feeding a line-item vatType of 1 into this field could mark a year of a
  // parent monthly invoices VAT-exempt. Pinned by a test so a future tidy-up
  // cannot quietly unify the two fields.
  const impl = morningStub({
    onApi: ({ url }) => (url.includes('/payments/recurrings')
      ? { status: 200, body: { id: 'rec-1' } } : null),
  });
  const a = client('t-a', 'key-a', impl, { pluginId: 'plugin-a' });

  await a.createRecurringPayment({
    tokenId: 'tok-1', amount: 500, description: 'צהרון', startDate: '2026-09-01',
    dayOfMonth: 5, cycles: 10,
  });

  const sent = impl.calls.find((c) => c.url.includes('/payments/recurrings')).body;
  assert.equal(sent.data.documentVatType, 0);
  assert.equal(sent.data.pluginId, 'plugin-a');
  assert.equal(sent.cycles, 10);
});

test('failed standing-order charges report what Morning withheld', async () => {
  // Morning answers total:1 with items:[] on a real account. An empty list is
  // indistinguishable from "nothing failed", so the discrepancy is returned
  // instead of being logged and dropped.
  const impl = morningStub({
    onApi: ({ url }) => (url.includes('/jobs/failed')
      ? { status: 200, body: { items: [], total: 3 } } : null),
  });
  const a = client('t-a', 'key-a', impl);
  const { items, withheld } = await a.failedRecurringJobs();
  assert.deepEqual(items, []);
  assert.equal(withheld, 3);
});

test('a client refuses to exist without credentials or with a bad environment', () => {
  assert.throws(() => createMorningClient({ keyId: 'a' }), /key id and secret/);
  assert.throws(
    () => createMorningClient({ keyId: 'a', keySecret: 'b', environment: 'staging' }),
    /unknown Morning environment/,
  );
});
