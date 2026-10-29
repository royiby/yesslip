import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../src/index.js';
import { closePool } from '../src/db/index.js';
import { saveProgramConfig } from '../src/programs/store.js';
import {
  saveMorningConnection, markMorningVerified, revealWebhookSecret,
} from '../src/tenants/store.js';
import { invalidateAll } from '../src/morning/index.js';
import { getOrder, getConsent, STATUS } from '../src/store/registrations.js';
import { setObjectStore, resetObjectStore, makeMemoryObjectStore } from '../src/storage/objects.js';
import { _internals } from '../src/booking/routes.js';
import {
  makeTenant, dropTenant, sampleCamp, longSignature, uniqueSlug,
} from './_helpers.js';

process.env.PUBLIC_BASE_URL = 'https://yesslip.test';

/** Start an app on an ephemeral port; returns a fetch bound to its origin. */
async function serve(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => realFetch(`${base}${path}`, { redirect: 'manual', ...options });
  call.close = () => new Promise((resolve) => server.close(resolve));
  return call;
}

const realFetch = globalThis.fetch;

/**
 * Morning, stubbed at the network boundary rather than by swapping a module.
 * Everything that is not Morning goes to the real fetch, including the test's
 * own calls into the server under test.
 */
const morningCalls = [];
function stubMorning() {
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (!href.includes('morning.co') && !href.includes('greeninvoice.co.il')) {
      return realFetch(url, options);
    }
    const body = options.body ? JSON.parse(options.body) : null;
    morningCalls.push({ href, body });

    if (href.endsWith('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (href.endsWith('/payments/form')) {
      return new Response(JSON.stringify({
        url: `https://pay.morning.test/${body.custom}`, errorCode: 0,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ errorCode: 0 }), { status: 200 });
  };
}

let tenant;
let suspended;
let call;

const parent = {
  name: 'דנה כהן',
  idNumber: '123456782', // a valid Israeli check digit
  phone: '050-1234567',
  email: 'dana@example.com',
};
const answers = { terms: true, healthDeclaration: true, photoConsent: true, allergies: '', pickup: '' };

function bookingBody(overrides = {}) {
  return {
    parent,
    children: [{ childName: 'יובל', childGrade: "ב'", weekId: 'w1', days: ['2030-07-01'] }],
    answers,
    signature: longSignature(),
    termsVersion: 'whatever',
    ...overrides,
  };
}

test('setup', async () => {
  setObjectStore(makeMemoryObjectStore());
  stubMorning();
  invalidateAll();

  tenant = await makeTenant('קייטנת דנה');
  await saveProgramConfig(tenant.id, sampleCamp());
  await saveMorningConnection(tenant.id, { keyId: 'kid', keySecret: 'ksecret' });
  await markMorningVerified(tenant.id, { pluginId: 'plug-1', businessName: 'קייטנת דנה' });
  invalidateAll();

  suspended = await makeTenant('עסק מושעה');
  await saveProgramConfig(suspended.id, sampleCamp());

  call = await serve(makeApp());
});

test('an unknown slug is a 404, not a stack trace', async () => {
  const response = await call(`/b/${uniqueSlug()}`);
  assert.equal(response.status, 404);
  assert.match(await response.text(), /הדף לא נמצא/);
});

test('the booking page renders the business name and its own asset path', async () => {
  const response = await call(`/b/${tenant.slug}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /קייטנת בדיקה/);
  assert.match(html, new RegExp(`/b/${tenant.slug}/assets/booking\\.js\\?v=`));
  // The boot payload must carry this tenant's own prefix, or the script would
  // post to whatever happens to be at /api/quote.
  assert.match(html, new RegExp(`"base":"/b/${tenant.slug}"`));
  assert.doesNotMatch(html, /dek_wrapped|key_secret/);
  assert.match(html, /name="robots" content="noindex"/);
});

test('the page is not cached, so a sold-out day is never served from a cache', async () => {
  const response = await call(`/b/${tenant.slug}`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('a suspended business gets a sentence and no way to pay', async () => {
  const { platform } = await import('../src/db/index.js');
  await platform((c) => c.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [suspended.id]));

  const page = await call(`/b/${suspended.slug}`);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /אינה זמינה כרגע/);

  const book = await call(`/b/${suspended.slug}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingBody()),
  });
  assert.equal(book.status, 503);
});

test('a quote prices the cart without writing anything', async () => {
  const response = await call(`/b/${tenant.slug}/api/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      children: [
        { childName: 'יובל', weekId: 'w1', days: ['2030-07-01', '2030-07-02'] },
        { childName: 'נועה', weekId: 'w1', days: ['2030-07-01', '2030-07-02'] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const quote = await response.json();
  assert.equal(quote.total, 570); // 300 + 300 less 10% on the second child
  assert.equal(quote.discountTotal, 30);
  assert.equal(quote.items.length, 2);
});

test('a week id from another business is refused, not booked', async () => {
  // The boundary that matters most: weeks are resolved against this tenant's
  // config, so another business's identifiers simply do not exist here.
  const response = await call(`/b/${tenant.slug}/api/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ children: [{ childName: 'x', weekId: 'their-week', days: ['2030-07-01'] }] }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /שבוע לא מוכר/);
});

test('a day that is not on offer is refused even if the week is real', async () => {
  const response = await call(`/b/${tenant.slug}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingBody({
      children: [{ childName: 'יובל', weekId: 'w1', days: ['2031-01-01'] }],
    })),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).field, /days/);
});

test('an unticked health declaration is refused', async () => {
  const response = await call(`/b/${tenant.slug}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingBody({ answers: { ...answers, healthDeclaration: false } })),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /הצהרת הבריאות/);
});

test('a missing signature is refused before anything is written', async () => {
  const response = await call(`/b/${tenant.slug}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingBody({ signature: '' })),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, 'signature');
});

test('an invalid Israeli id is refused', async () => {
  const response = await call(`/b/${tenant.slug}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingBody({ parent: { ...parent, idNumber: '123456789' } })),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /מספר הזהות/);
});

let bookedOrderId;

test('a complete booking signs, reserves, and returns a payment link', async () => {
  const response = await call(`/b/${tenant.slug}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bookingBody()),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  bookedOrderId = body.orderId;
  assert.equal(body.total, 150);
  assert.equal(body.paymentUrl, `https://pay.morning.test/${body.orderId}`);

  const order = await getOrder(tenant.id, body.orderId);
  assert.equal(order.status, STATUS.pending);
  assert.equal(order.paymentUrl, body.paymentUrl);

  // The signed form exists before the payment link does, so a business can
  // never hold money for a registration with no form behind it.
  const consent = await getConsent(tenant.id, body.orderId);
  assert.equal(consent.archive_key, `t/${tenant.id}/consent/${body.orderId}.html`);
  assert.equal(consent.terms_version, (await import('../src/programs/camp.js'))
    .termsVersionOf(sampleCamp()));
});

test('the payment link carries this tenant own notifyUrl and secret', async () => {
  const form = morningCalls.filter((c) => c.href.endsWith('/payments/form')).at(-1);
  const secret = await revealWebhookSecret(tenant.id);
  assert.ok(secret && secret.length > 20);
  assert.equal(form.body.custom, bookedOrderId);
  assert.match(form.body.notifyUrl, new RegExp(`/webhooks/morning/${tenant.slug}/payment`));
  assert.ok(form.body.notifyUrl.includes(encodeURIComponent(secret)) || form.body.notifyUrl.includes(secret));
  assert.match(form.body.successUrl, new RegExp(`/b/${tenant.slug}/paid`));
  assert.equal(form.body.income.reduce((s, l) => s + l.price, 0), 150);
});

test('the signed form is readable by its order id, and only within its tenant', async () => {
  const mine = await call(`/b/${tenant.slug}/consent/${bookedOrderId}`);
  assert.equal(mine.status, 200);
  const html = await mine.text();
  assert.match(html, /דנה כהן/);
  assert.match(html, /123456782/);
  assert.equal(mine.headers.get('cache-control'), 'private, no-store');

  // The same order id under another business: the consent row is invisible to
  // it, so there is no key to read and the object store is never addressed.
  const theirs = await call(`/b/${suspended.slug}/consent/${bookedOrderId}`);
  assert.equal(theirs.status, 404);
});

test('a webhook with no secret, a wrong secret or the wrong tenant secret is refused', async () => {
  const mine = await revealWebhookSecret(tenant.id);
  const path = `/webhooks/morning/${tenant.slug}/payment`;
  const post = (query) => call(`${path}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ external_data: bookedOrderId, number: '60009' }).toString(),
  });

  assert.equal((await post('')).status, 401);
  assert.equal((await post('?secret=')).status, 401);
  assert.equal((await post('?secret=wrong')).status, 401);
  assert.equal((await post(`?secret=${encodeURIComponent(`${mine}x`)}`)).status, 401);

  // A different business's secret must not work here either, which is the
  // whole reason the secret is per tenant rather than platform-wide.
  const other = await revealWebhookSecret(suspended.id);
  assert.equal((await post(`?secret=${encodeURIComponent(other ?? 'none')}`)).status, 401);

  // Still unpaid after all of that.
  assert.equal((await getOrder(tenant.id, bookedOrderId)).status, STATUS.pending);
});

test('an unknown tenant in the webhook path is a 404 before any secret is compared', async () => {
  const response = await call(`/webhooks/morning/${uniqueSlug()}/payment?secret=anything`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'external_data=X',
  });
  assert.equal(response.status, 404);
});

test('a correct webhook marks the order paid, and a redelivery changes nothing', async () => {
  const secret = await revealWebhookSecret(tenant.id);
  const post = () => call(`/webhooks/morning/${tenant.slug}/payment?secret=${encodeURIComponent(secret)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      external_data: bookedOrderId, number: '60009', transaction_id: 'tx-9',
      url: 'https://morning.test/doc',
    }).toString(),
  });

  assert.equal((await post()).status, 200);
  const paid = await getOrder(tenant.id, bookedOrderId);
  assert.equal(paid.status, STATUS.paid);
  assert.equal(paid.rows[0].doc_number, '60009');

  // Morning retries at 10, 20 and 30 minutes on a non-2xx.
  assert.equal((await post()).status, 200);
  const { attendanceForDate } = await import('../src/store/registrations.js');
  const list = await attendanceForDate(tenant.id, '2030-07-01');
  assert.equal(list.filter((r) => r.order_id === bookedOrderId).length, 1);
});

test('a webhook with no correlation id is acknowledged, not retried forever', async () => {
  const secret = await revealWebhookSecret(tenant.id);
  const response = await call(`/webhooks/morning/${tenant.slug}/payment?secret=${encodeURIComponent(secret)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'number=60010',
  });
  assert.equal(response.status, 200);
});

test('a webhook naming an order this tenant does not have is acknowledged, not retried', async () => {
  const secret = await revealWebhookSecret(tenant.id);
  const response = await call(`/webhooks/morning/${tenant.slug}/payment?secret=${encodeURIComponent(secret)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'external_data=NOSUCH&number=60011',
  });
  assert.equal(response.status, 200);
});

test('the secret comparison does not leak length through a throw', () => {
  const { secretOk } = _internals;
  assert.equal(secretOk('abc', 'abc'), true);
  assert.equal(secretOk('abc', 'abcd'), false);
  assert.equal(secretOk('abc', 'ab'), false);
  assert.equal(secretOk('', ''), false);
  assert.equal(secretOk(null, 'abc'), false);
  assert.equal(secretOk('abc', undefined), false);
});

test('a business with no published program answers rather than erroring', async () => {
  const blank = await makeTenant('עסק חדש');
  try {
    const page = await call(`/b/${blank.slug}`);
    assert.equal(page.status, 404);
    assert.match(await page.text(), /אין כרגע הרשמה פתוחה/);

    const quote = await call(`/b/${blank.slug}/api/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ children: [{ childName: 'x', weekId: 'w1', days: ['2030-07-01'] }] }),
    });
    assert.equal(quote.status, 404);
    assert.equal((await quote.json()).error, 'אין כרגע הרשמה פתוחה');
  } finally {
    await dropTenant(blank.id);
  }
});

test('a closed registration refuses a booking but still serves the page', async () => {
  const closing = await makeTenant('קייטנה שנסגרה');
  try {
    await saveProgramConfig(closing.id, sampleCamp({
      registrationClosesAt: '2020-01-01T00:00:00+02:00',
    }));
    const page = await call(`/b/${closing.slug}`);
    assert.equal(page.status, 200);

    const book = await call(`/b/${closing.slug}/api/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingBody()),
    });
    assert.equal(book.status, 409);
    assert.match((await book.json()).error, /נסגרה/);
  } finally {
    await dropTenant(closing.id);
  }
});

test('a business that has not connected Morning cannot take a signature', async () => {
  // Checked before the document is written, so an unconnected business does
  // not accumulate signed forms for payments it cannot take.
  const unconnected = await makeTenant('עסק ללא מורנינג');
  try {
    await saveProgramConfig(unconnected.id, sampleCamp());
    const response = await call(`/b/${unconnected.slug}/api/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bookingBody()),
    });
    assert.equal(response.status, 500);
    assert.equal(await getConsent(unconnected.id, 'ANY'), null);
  } finally {
    await dropTenant(unconnected.id);
  }
});

test('the rate limit is per business, so one rush cannot lock out another', async () => {
  // The single-tenant original keyed its limiter by IP alone. In one process
  // serving every business that is a cross-tenant denial of service: a burst
  // aimed at one booking page would refuse parents on all of them. Two fresh
  // tenants here so neither inherits a count from an earlier test.
  const busy = await makeTenant('עסק עמוס');
  const calm = await makeTenant('עסק רגוע');
  try {
    await saveProgramConfig(busy.id, sampleCamp());
    await saveProgramConfig(calm.id, sampleCamp());

    const post = (slug) => call(`/b/${slug}/api/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Deliberately invalid, so each attempt is refused at validation and
      // nothing is written. The limiter runs before that, which is the point.
      body: JSON.stringify(bookingBody({ signature: '' })),
    });

    const statuses = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await post(busy.slug)).status);
    assert.deepEqual(statuses.slice(0, 6), Array(6).fill(400), statuses.join(','));
    assert.equal(statuses[6], 429);

    // The other business is untouched by that burst.
    assert.equal((await post(calm.slug)).status, 400);
  } finally {
    await dropTenant(busy.id);
    await dropTenant(calm.id);
  }
});

test('teardown', async () => {
  globalThis.fetch = realFetch;
  resetObjectStore();
  await call?.close();
  await dropTenant(tenant?.id);
  await dropTenant(suspended?.id);
  await closePool();
});
