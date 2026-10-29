import test from 'node:test';
import assert from 'node:assert/strict';
import { platform, closePool } from '../src/db/index.js';
import {
  createTenant, getTenantBySlug, getTenantById, slugProblem, colorProblem,
  saveMorningConnection, revealMorningCredentials, getMorningConnectionStatus,
  markMorningVerified, markMorningFailed,
} from '../src/tenants/store.js';
import { makeTenant, dropTenant, uniqueSlug } from './_helpers.js';

test('a slug is checked before it becomes a hostname', () => {
  assert.equal(slugProblem('yetziron'), null);
  assert.equal(slugProblem('camp-2026'), null);
  for (const bad of ['', 'ab', 'A-Camp', 'has space', 'trailing-', '-leading', 'קייטנה', 'x'.repeat(41)]) {
    assert.ok(slugProblem(bad), `expected ${JSON.stringify(bad)} to be refused`);
  }
  // Reserved because they are, or will be, our own hostnames and paths.
  for (const reserved of ['app', 'api', 'www', 'admin', 'billing']) {
    assert.ok(slugProblem(reserved), `expected ${reserved} to be reserved`);
  }
});

test('a colour is checked before it reaches a stylesheet', () => {
  assert.equal(colorProblem('#2563eb'), null);
  // Each of these would otherwise be interpolated into a CSS custom property.
  for (const bad of ['red', '#fff', 'rgb(0,0,0)', '#2563eb;}body{display:none', '', null]) {
    assert.ok(colorProblem(bad), `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('a tenant round-trips, and never hands back its data key', async (t) => {
  const slug = uniqueSlug('camp');
  const created = await createTenant({ slug, name: 'קייטנת הדס', colorPrimary: '#112233' });
  t.after(async () => { await dropTenant(created.id); await closePool(); });

  assert.equal(created.slug, slug);
  assert.equal(created.color_primary, '#112233');
  assert.equal(created.status, 'onboarding');

  for (const row of [await getTenantBySlug(slug), await getTenantById(created.id)]) {
    assert.equal(row.id, created.id);
    // The wrapped data key must never travel with the branding. These objects
    // get spread into page templates and JSON responses.
    assert.ok(!('dek_wrapped' in row), 'dek_wrapped must not be selected');
  }
});

test('a bad slug or colour is refused before any row is written', async (t) => {
  t.after(async () => { await closePool(); });
  await assert.rejects(() => createTenant({ slug: 'app', name: 'x' }), /שמורה/);
  await assert.rejects(
    () => createTenant({ slug: uniqueSlug(), name: 'x', colorPrimary: 'red' }),
    /#RRGGBB/,
  );
});

test('two tenants cannot be given the same slug', async (t) => {
  const slug = uniqueSlug();
  const first = await createTenant({ slug, name: 'ראשון' });
  t.after(async () => { await dropTenant(first.id); await closePool(); });
  await assert.rejects(() => createTenant({ slug, name: 'שני' }), /duplicate key|unique/i);
});

test('Morning credentials round-trip and a per-tenant webhook secret is minted', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });

  await saveMorningConnection(a.id, {
    keyId: 'key-id-a', keySecret: 'key-secret-a', environment: 'sandbox',
  });

  const revealed = await revealMorningCredentials(a.id);
  assert.equal(revealed.keyId, 'key-id-a');
  assert.equal(revealed.keySecret, 'key-secret-a');
  assert.equal(revealed.environment, 'sandbox');
  assert.equal(revealed.status, 'unverified');
  // Generated for us, not asked of the tenant, and not shared between tenants.
  assert.ok(revealed.webhookSecret.length >= 32);
});

test('what is stored in the database is not the secret', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });

  await saveMorningConnection(a.id, { keyId: 'plain-id', keySecret: 'plain-secret' });

  const raw = await platform(async (c) => (await c.query(
    'SELECT key_id_enc, key_secret_enc FROM tenant_connections WHERE tenant_id = $1', [a.id],
  )).rows[0]);

  // A dump of this table, or a leaked backup, must not be a list of live
  // Morning credentials.
  assert.ok(Buffer.isBuffer(raw.key_secret_enc));
  assert.ok(!raw.key_secret_enc.includes(Buffer.from('plain-secret')));
  assert.ok(!raw.key_id_enc.includes(Buffer.from('plain-id')));
});

test('two tenants credentials do not cross', async (t) => {
  const a = await makeTenant();
  const b = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await dropTenant(b.id); await closePool(); });

  await saveMorningConnection(a.id, { keyId: 'id-a', keySecret: 'secret-a' });
  await saveMorningConnection(b.id, { keyId: 'id-b', keySecret: 'secret-b' });

  const [ra, rb] = [await revealMorningCredentials(a.id), await revealMorningCredentials(b.id)];
  assert.equal(ra.keySecret, 'secret-a');
  assert.equal(rb.keySecret, 'secret-b');
  assert.notEqual(ra.webhookSecret, rb.webhookSecret);
});

test('a ciphertext moved to another tenant row will not decrypt', async (t) => {
  const a = await makeTenant();
  const b = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await dropTenant(b.id); await closePool(); });

  await saveMorningConnection(a.id, { keyId: 'id-a', keySecret: 'secret-a' });
  await saveMorningConnection(b.id, { keyId: 'id-b', keySecret: 'secret-b' });

  // Simulate the accident this guards against: a bad join, a migration, or a
  // copy-paste putting A's encrypted secret on B's row. It must fail loudly,
  // not let B transact as A.
  await platform((c) => c.query(
    `UPDATE tenant_connections SET key_secret_enc =
       (SELECT key_secret_enc FROM tenant_connections WHERE tenant_id = $1)
     WHERE tenant_id = $2`,
    [a.id, b.id],
  ));

  await assert.rejects(() => revealMorningCredentials(b.id));
});

test('the status shown on screen carries no secret', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });

  await saveMorningConnection(a.id, { keyId: 'id-a', keySecret: 'secret-a' });
  await markMorningVerified(a.id, { pluginId: 'plugin-uuid', businessName: 'עסק בדיקה' });

  const status = await getMorningConnectionStatus(a.id);
  assert.equal(status.status, 'verified');
  assert.equal(status.business_name, 'עסק בדיקה');
  assert.equal(status.has_clearing, true);
  assert.equal(status.obtained_via, 'pasted');

  // This object is rendered into the settings screen. Nothing resembling a
  // credential may be reachable from it, including the clearing id.
  const keys = Object.keys(status).join(' ');
  for (const forbidden of ['key_id', 'key_secret', 'webhook', 'enc', 'plugin_id']) {
    assert.ok(!keys.includes(forbidden), `status leaks ${forbidden}: ${keys}`);
  }
});

test('reconnecting Morning resets verification rather than keeping a stale pass', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });

  await saveMorningConnection(a.id, { keyId: 'id-1', keySecret: 'secret-1' });
  await markMorningVerified(a.id, { pluginId: 'plugin-1', businessName: 'עסק' });

  // A new key is a new set of facts: the plan may have changed, the clearing
  // may be gone. Carrying the old "verified" over would let a broken
  // connection look healthy.
  await saveMorningConnection(a.id, { keyId: 'id-2', keySecret: 'secret-2' });

  const status = await getMorningConnectionStatus(a.id);
  assert.equal(status.status, 'unverified');
  assert.equal(status.has_clearing, false);
  assert.equal((await revealMorningCredentials(a.id)).keySecret, 'secret-2');
});

test('a failed verification is recorded where the tenant can read it', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });

  await saveMorningConnection(a.id, { keyId: 'id-a', keySecret: 'secret-a' });
  await markMorningFailed(a.id, 'x'.repeat(900));

  const status = await getMorningConnectionStatus(a.id);
  assert.equal(status.status, 'failed');
  // Truncated, because this reaches a screen and a Morning error can carry a
  // whole response body.
  assert.equal(status.last_error.length, 500);
});

test('an incomplete Morning connection is refused', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });
  await assert.rejects(() => saveMorningConnection(a.id, { keyId: 'only-id' }), /חסר/);
  await assert.rejects(
    () => saveMorningConnection(a.id, { keyId: 'a', keySecret: 'b', environment: 'prod' }),
    /unknown Morning environment/,
  );
  assert.equal(await getMorningConnectionStatus(a.id), null);
});

test('a tenant with no Morning connection reveals nothing, rather than throwing', async (t) => {
  const a = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await closePool(); });
  assert.equal(await revealMorningCredentials(a.id), null);
});
