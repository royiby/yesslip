import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, getPool } from '../src/db/index.js';
import { priceCart } from '../src/pricing.js';
import {
  STATUS, newOrderId, createOrderRows, getOrder, updateOrder, markPaid,
  takenPerDay, remainingPerDay, checkCapacity, getConsent, attendanceForDate,
  CapacityError,
} from '../src/store/registrations.js';
import { makeTenant, dropTenant, decoratedSampleCamp, closePool } from './_helpers.js';

const camp = await decoratedSampleCamp(); // w1 capped at 2/day, w2 uncapped
let tenant;
let other;

function consentFor(orderId) {
  return {
    signedAt: new Date().toISOString(),
    signerName: 'דנה כהן',
    signerId: '123456782',
    phone: '0501234567',
    email: 'dana@example.com',
    children: ['יובל'],
    termsVersion: camp.termsVersion,
    healthDeclaration: true,
    photoConsent: false,
    ip: '203.0.113.9',
    userAgent: 'test',
    archiveKey: `t/x/consent/${orderId}.html`,
  };
}

async function book(tenantId, { days, orderId = newOrderId(), childName = 'יובל', weekId = 'w1' }) {
  const priced = priceCart(camp, [{ childName, weekId, days }]);
  await createOrderRows({
    tenantId,
    orderId,
    camp,
    priced,
    parent: { name: 'דנה כהן', phone: '972501234567', email: 'dana@example.com' },
    consent: consentFor(orderId),
  });
  return orderId;
}

test('setup', async () => {
  tenant = await makeTenant('עסק א');
  other = await makeTenant('עסק ב');
});

test('a booking writes one row per child and one consent row', async () => {
  const orderId = newOrderId();
  const priced = priceCart(camp, [
    { childName: 'יובל', weekId: 'w2', days: ['2030-07-08'] },
    { childName: 'נועה', weekId: 'w2', days: ['2030-07-08', '2030-07-09'] },
  ]);
  await createOrderRows({
    tenantId: tenant.id,
    orderId,
    camp,
    priced,
    parent: { name: 'דנה כהן', phone: '972501234567', email: 'dana@example.com' },
    consent: { ...consentFor(orderId), children: ['יובל', 'נועה'] },
  });

  const order = await getOrder(tenant.id, orderId);
  assert.equal(order.rows.length, 2);
  assert.equal(order.status, STATUS.pending);
  assert.equal(order.total, priced.total);
  assert.deepEqual(order.rows.map((r) => r.row_id), [`${orderId}-1`, `${orderId}-2`]);

  const consent = await getConsent(tenant.id, orderId);
  assert.equal(consent.terms_version, camp.termsVersion);
  assert.equal(consent.archive_key, `t/x/consent/${orderId}.html`);
  assert.equal(consent.destroyed_at, null);
});

test('booked days come back as civil dates, not shifted instants', async () => {
  // A date[] read as Date objects lands at local midnight and a UTC server
  // reports the day before. The query casts to text for exactly this reason.
  const orderId = await book(tenant.id, { days: ['2030-07-10', '2030-07-11'], weekId: 'w2' });
  const order = await getOrder(tenant.id, orderId);
  assert.deepEqual(order.rows[0].days, ['2030-07-10', '2030-07-11']);
  assert.equal(typeof order.rows[0].days[0], 'string');
});

test('an unpaid order holds its seats, and a stale one releases them', async () => {
  const orderId = await book(tenant.id, { days: ['2030-07-02'] });
  assert.equal((await takenPerDay(tenant.id, camp)).get('2030-07-02'), 1);
  assert.equal((await remainingPerDay(tenant.id, camp)).get('2030-07-02'), 1);

  // Age the row past the payment window. An abandoned link must not hold a
  // seat forever, or one browser tab closes a day for the season.
  await withTenant(tenant.id, (client) => client.query(
    `UPDATE registrations SET created_at = now() - interval '2 hours' WHERE order_id = $1`,
    [orderId],
  ));
  assert.equal((await takenPerDay(tenant.id, camp)).get('2030-07-02') ?? 0, 0);
  assert.equal((await remainingPerDay(tenant.id, camp)).get('2030-07-02'), 2);
});

test('an uncapped day reports null remaining, not zero', async () => {
  const remaining = await remainingPerDay(tenant.id, camp);
  assert.equal(remaining.get('2030-07-12'), null);
  assert.equal(remaining.get('2030-07-01'), 2);
});

test('a cart that would oversell a day is refused', async () => {
  await book(tenant.id, { days: ['2030-07-03'] });
  await book(tenant.id, { days: ['2030-07-03'], childName: 'נועה' });

  const full = await checkCapacity(tenant.id, camp, [
    { childName: 'אורי', weekId: 'w1', days: ['2030-07-03'] },
  ]);
  assert.equal(full.ok, false);
  assert.deepEqual(full.full, [{ day: '2030-07-03', left: 0, wanted: 1 }]);

  await assert.rejects(
    () => book(tenant.id, { days: ['2030-07-03'], childName: 'אורי' }),
    CapacityError,
  );
});

test('two children of one cart counted against the same last seat is refused', async () => {
  // The check has to count the cart against itself, not just against the
  // database, or a parent with two children takes two of one remaining seat.
  await book(tenant.id, { days: ['2030-07-04'] });
  const priced = priceCart(camp, [
    { childName: 'א', weekId: 'w1', days: ['2030-07-04'] },
    { childName: 'ב', weekId: 'w1', days: ['2030-07-04'] },
  ]);
  await assert.rejects(() => createOrderRows({
    tenantId: tenant.id,
    orderId: newOrderId(),
    camp,
    priced,
    parent: { name: 'דנה', phone: '972501234567', email: 'd@example.com' },
    consent: consentFor('X'),
  }), CapacityError);
});

test('two simultaneous bookings cannot both take the last seat', async () => {
  // The bug the spreadsheet could not avoid: count, then write, with a network
  // round trip in between. Here the count and the write are one transaction,
  // serialised per tenant by an advisory lock.
  //
  // The pre-warm is not decoration. Without it the first booking takes the one
  // idle pooled client immediately while the second waits on a TCP connect and
  // a handshake, so the two never overlap and the test passes whether or not
  // the lock exists. Measured: with three clients already open, removing
  // lockCapacity puts three children on a two-seat day on every run.
  const day = '2030-07-05';
  await book(tenant.id, { days: [day] }); // 1 of 2 taken
  await Promise.all([
    getPool().query('SELECT 1'), getPool().query('SELECT 1'), getPool().query('SELECT 1'),
  ]);

  const results = await Promise.allSettled([
    book(tenant.id, { days: [day], childName: 'א' }),
    book(tenant.id, { days: [day], childName: 'ב' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one should have been seated');
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason.code, 'CAPACITY');

  // The invariant, checked against the database rather than the return values.
  assert.equal((await takenPerDay(tenant.id, camp)).get(day), 2);
});

test('one tenant filling a day leaves the other tenant that day empty', async () => {
  const day = '2030-07-01';
  await book(tenant.id, { days: [day] });
  await book(tenant.id, { days: [day], childName: 'נועה' });
  assert.equal((await remainingPerDay(tenant.id, camp)).get(day), 0);
  assert.equal((await remainingPerDay(other.id, camp)).get(day), 2);
  // And the lock is per tenant, so the second business can still book it.
  await book(other.id, { days: [day] });
  assert.equal((await takenPerDay(other.id, camp)).get(day), 1);
});

test('paying marks every row and writes one attendance row per child-day', async () => {
  const orderId = await book(tenant.id, { days: ['2030-07-09', '2030-07-10'], weekId: 'w2' });
  const result = await markPaid(tenant.id, orderId, {
    transactionId: 'tx-1', documentNumber: '60009', documentUrl: 'https://morning/doc',
  });
  assert.equal(result.ok, true);
  assert.equal(result.attendanceRows, 2);

  const order = await getOrder(tenant.id, orderId);
  assert.equal(order.status, STATUS.paid);
  assert.ok(order.rows.every((r) => r.status === STATUS.paid && r.paid_at));
  assert.equal(order.rows[0].doc_number, '60009');

  const list = await attendanceForDate(tenant.id, '2030-07-09');
  assert.ok(list.some((r) => r.order_id === orderId && r.child_name === 'יובל'));
});

test('a redelivered callback does not double-write attendance', async () => {
  // Morning retries at 10, 20 and 30 minutes on a non-2xx, so this runs for
  // real in production, not only in a test.
  const orderId = await book(tenant.id, { days: ['2030-07-11'], weekId: 'w2' });
  const first = await markPaid(tenant.id, orderId, { transactionId: 'tx-2' });
  assert.equal(first.attendanceRows, 1);

  const second = await markPaid(tenant.id, orderId, { transactionId: 'tx-2' });
  assert.equal(second.duplicate, true);
  assert.equal(second.attendanceRows, 0);

  const list = await attendanceForDate(tenant.id, '2030-07-11');
  assert.equal(list.filter((r) => r.order_id === orderId).length, 1);
});

test('a callback for an order this tenant does not have is reported, not invented', async () => {
  const result = await markPaid(tenant.id, 'NOSUCHID');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'order-not-found');
});

test('a callback cannot mark another tenant order paid', async () => {
  const orderId = await book(other.id, { days: ['2030-07-12'], weekId: 'w2' });
  const stolen = await markPaid(tenant.id, orderId);
  assert.equal(stolen.ok, false);
  assert.equal((await getOrder(other.id, orderId)).status, STATUS.pending);
});

test('a patch can only touch the columns it is allowed to', async () => {
  const orderId = await book(tenant.id, { days: ['2030-07-08'], weekId: 'w2' });
  const touched = await updateOrder(tenant.id, orderId, {
    payment_url: 'https://pay.example/1',
    amount: 999999,       // not patchable: a price change is not an order patch
    tenant_id: other.id,  // not patchable: that would be the whole boundary
  });
  assert.equal(touched, 1);
  const order = await getOrder(tenant.id, orderId);
  assert.equal(order.rows[0].payment_url, 'https://pay.example/1');
  assert.notEqual(Number(order.rows[0].amount), 999999);
  // Still this tenant's row, and still invisible to the other.
  assert.equal(await getOrder(other.id, orderId), null);
});

test('a patch of nothing patchable writes nothing', async () => {
  const orderId = await book(tenant.id, { days: ['2030-07-09'], weekId: 'w2' });
  assert.equal(await updateOrder(tenant.id, orderId, { amount: 1 }), 0);
});

test('teardown', async () => {
  await dropTenant(tenant?.id);
  await dropTenant(other?.id);
  await closePool();
});
