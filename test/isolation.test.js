import test from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, platform, closePool } from '../src/db/index.js';
import { makeTenant, dropTenant } from './_helpers.js';

/**
 * Cross-tenant isolation. This file exists because of one specific bug class:
 * a query that forgets which business it is for. Everything here runs as
 * yesslip_app, the same non-owner role the app uses, because row-level
 * security does not constrain a table's owner unless forced.
 *
 * If any test in this file fails, the platform is not safe to run two
 * customers on.
 */

async function insertRegistration(tenantId, orderId, childName) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO registrations (tenant_id, order_id, row_id, child_name, amount, status)
       VALUES ($1, $2, $3, $4, 100, 'paid') RETURNING id`,
      [tenantId, orderId, `${orderId}-1`, childName],
    );
    return rows[0].id;
  });
}

test('two tenants cannot see each other, in either direction', async (t) => {
  const a = await makeTenant('קייטנת א');
  const b = await makeTenant('קייטנת ב');
  t.after(async () => { await dropTenant(a.id); await dropTenant(b.id); await closePool(); });

  await insertRegistration(a.id, 'A-001', 'ילד של א');
  await insertRegistration(b.id, 'B-001', 'ילד של ב');

  const seenByA = await withTenant(a.id, async (c) =>
    (await c.query('SELECT child_name FROM registrations')).rows);
  const seenByB = await withTenant(b.id, async (c) =>
    (await c.query('SELECT child_name FROM registrations')).rows);

  assert.deepEqual(seenByA.map((r) => r.child_name), ['ילד של א']);
  assert.deepEqual(seenByB.map((r) => r.child_name), ['ילד של ב']);
});

test('a query with no tenant set reads nothing, rather than everything', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });
  await insertRegistration(a.id, 'A-002', 'ילד');

  // The failure mode this guards against is a handler that reaches for a
  // connection directly. Deny by default means that returns an empty list,
  // which surfaces as a visible bug, instead of every tenant's rows.
  const rows = await platform(async (c) => (await c.query('SELECT * FROM registrations')).rows);
  assert.equal(rows.length, 0);
});

test('a tenant cannot insert a row stamped with another tenant', async (t) => {
  const a = await makeTenant();
  const b = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await dropTenant(b.id); await closePool(); });

  // USING alone would allow this: it filters reads, not the tenant_id a write
  // claims. WITH CHECK is what refuses it.
  await assert.rejects(
    () => withTenant(b.id, (c) => c.query(
      `INSERT INTO registrations (tenant_id, order_id, row_id, child_name)
       VALUES ($1, 'X-1', 'X-1-1', 'מושתל')`,
      [a.id],
    )),
    (error) => {
      assert.equal(error.code, '42501', `expected an RLS violation, got ${error.code}: ${error.message}`);
      return true;
    },
  );

  const count = await withTenant(a.id, async (c) =>
    Number((await c.query('SELECT count(*) FROM registrations')).rows[0].count));
  assert.equal(count, 0);
});

test('a tenant cannot update or delete another tenant rows', async (t) => {
  const a = await makeTenant();
  const b = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await dropTenant(b.id); await closePool(); });

  await insertRegistration(a.id, 'A-003', 'שם מקורי');

  // Not an error: RLS filters the rows an UPDATE can see, so this matches
  // nothing. The row is untouched, which is what matters.
  const updated = await withTenant(b.id, async (c) =>
    (await c.query("UPDATE registrations SET child_name = 'נחטף' WHERE order_id = 'A-003'")).rowCount);
  assert.equal(updated, 0);

  const deleted = await withTenant(b.id, async (c) =>
    (await c.query("DELETE FROM registrations WHERE order_id = 'A-003'")).rowCount);
  assert.equal(deleted, 0);

  const name = await withTenant(a.id, async (c) =>
    (await c.query("SELECT child_name FROM registrations WHERE order_id = 'A-003'")).rows[0].child_name);
  assert.equal(name, 'שם מקורי');
});

test('the cancellations ledger cannot be rewritten, even by its own tenant', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });

  await withTenant(a.id, (c) => c.query(
    `INSERT INTO cancellations (tenant_id, order_id, event, actor, refund_amount)
     VALUES ($1, 'A-004', 'cancelled', 'המנהלת', 50)`,
    [a.id],
  ));

  // This is the tab an accountant is handed. An append-only ledger that the
  // application merely promises not to rewrite is a different thing from one
  // the database refuses to rewrite.
  await assert.rejects(
    () => withTenant(a.id, (c) => c.query("UPDATE cancellations SET refund_amount = 0")),
    (error) => {
      assert.equal(error.code, '42501', `expected a permission error, got ${error.code}`);
      return true;
    },
  );
  await assert.rejects(
    () => withTenant(a.id, (c) => c.query('DELETE FROM cancellations')),
    (error) => {
      assert.equal(error.code, '42501', `expected a permission error, got ${error.code}`);
      return true;
    },
  );

  const row = await withTenant(a.id, async (c) =>
    (await c.query('SELECT refund_amount FROM cancellations')).rows[0]);
  assert.equal(Number(row.refund_amount), 50);
});

test('withTenant refuses anything that is not a tenant id', async (t) => {
  t.after(async () => { await closePool(); });
  for (const bad of [null, undefined, '', 'not-a-uuid', '1; DROP TABLE registrations', 42]) {
    await assert.rejects(() => withTenant(bad, async () => 'ran'), /not a tenant id/);
  }
});

test('a rolled back transaction leaves no row behind', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });

  await assert.rejects(() => withTenant(a.id, async (c) => {
    await c.query(
      `INSERT INTO registrations (tenant_id, order_id, row_id) VALUES ($1, 'A-005', 'A-005-1')`,
      [a.id],
    );
    throw new Error('boom');
  }), /boom/);

  const count = await withTenant(a.id, async (c) =>
    Number((await c.query('SELECT count(*) FROM registrations')).rows[0].count));
  assert.equal(count, 0);
});

test('the tenant setting does not survive onto the next connection user', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });
  await insertRegistration(a.id, 'A-006', 'ילד');

  // set_config(..., true) is transaction-local. If it were not, the pooled
  // connection would hand tenant A's context to whoever got it next, which is
  // exactly the leak this design is built to prevent.
  await withTenant(a.id, async (c) => (await c.query('SELECT 1')).rows);

  const leaked = await platform(async (c) => {
    const { rows } = await c.query("SELECT current_setting('app.tenant_id', true) AS t");
    return rows[0].t;
  });
  assert.ok(leaked === null || leaked === '', `tenant setting leaked onto a pooled connection: ${leaked}`);
});

test('deleting a tenant removes its data', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await closePool(); });
  await insertRegistration(a.id, 'A-007', 'ילד');

  await dropTenant(a.id);

  // Cascade runs as the system, so RLS does not block it. Confirmed here
  // rather than assumed, because a cascade that silently failed would leave
  // orphaned children's data behind after an erasure request.
  const left = await platform(async (c) =>
    Number((await c.query('SELECT count(*) FROM registrations WHERE tenant_id = $1', [a.id])).rows[0].count));
  assert.equal(left, 0);
});
