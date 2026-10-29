import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  generateDek, wrapDek, unwrapDek, encryptSecret, decryptSecret, rewrapDek, masterKey,
} from '../src/crypto/secrets.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

test('a data key survives wrap and unwrap', () => {
  const dek = generateDek();
  assert.equal(dek.length, 32);
  assert.deepEqual(unwrapDek(wrapDek(dek)), dek);
});

test('wrapping the same key twice gives different ciphertext', () => {
  // A fresh IV each time. Identical blobs would leak that two tenants share a
  // key, and would make the ciphertext a usable fingerprint.
  const dek = generateDek();
  assert.notDeepEqual(wrapDek(dek), wrapDek(dek));
});

test('a secret survives encrypt and decrypt', () => {
  const dek = generateDek();
  const blob = encryptSecret(dek, 'super-secret-morning-key', TENANT_A, 'morning.key_secret');
  assert.equal(decryptSecret(dek, blob, TENANT_A, 'morning.key_secret'), 'super-secret-morning-key');
});

test('a ciphertext cannot be read as another tenant', () => {
  // This is the test that matters. A ciphertext lifted from one tenant's row
  // into another's, by a bad join or a copy-paste, must fail loudly rather
  // than let one business transact with another's credentials.
  const dek = generateDek();
  const blob = encryptSecret(dek, 'secret', TENANT_A, 'morning.key_secret');
  assert.throws(() => decryptSecret(dek, blob, TENANT_B, 'morning.key_secret'));
});

test('a ciphertext cannot be read as another field', () => {
  const dek = generateDek();
  const blob = encryptSecret(dek, 'secret', TENANT_A, 'morning.key_secret');
  assert.throws(() => decryptSecret(dek, blob, TENANT_A, 'morning.webhook_secret'));
});

test('a tampered ciphertext is rejected', () => {
  const dek = generateDek();
  const blob = encryptSecret(dek, 'secret', TENANT_A, 'morning.key_id');
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptSecret(dek, tampered, TENANT_A, 'morning.key_id'));
});

test('another tenant data key cannot read the secret', () => {
  const blob = encryptSecret(generateDek(), 'secret', TENANT_A, 'morning.key_id');
  assert.throws(() => decryptSecret(generateDek(), blob, TENANT_A, 'morning.key_id'));
});

test('a truncated blob is rejected rather than read as garbage', () => {
  assert.throws(() => decryptSecret(generateDek(), Buffer.alloc(4), TENANT_A, 'x'), /too short/);
});

test('an unknown version is rejected', () => {
  const dek = generateDek();
  const blob = Buffer.from(encryptSecret(dek, 'secret', TENANT_A, 'f'));
  blob[0] = 99;
  assert.throws(() => decryptSecret(dek, blob, TENANT_A, 'f'), /unknown ciphertext version/);
});

test('an empty secret is refused rather than stored', () => {
  assert.throws(() => encryptSecret(generateDek(), '', TENANT_A, 'morning.key_id'), /empty/);
});

test('a context needs both a tenant and a field', () => {
  const dek = generateDek();
  assert.throws(() => encryptSecret(dek, 'x', null, 'f'), /tenant id/);
  assert.throws(() => encryptSecret(dek, 'x', TENANT_A, ''), /field name/);
});

test('the master key must be 32 bytes of base64', (t) => {
  const original = process.env.SECRETS_MASTER_KEY;
  t.after(() => {
    // Restore by deleting rather than assigning, when it was absent: assigning
    // undefined stores the string "undefined", which passes the length check
    // nowhere and fails every later test confusingly.
    if (original === undefined) delete process.env.SECRETS_MASTER_KEY;
    else process.env.SECRETS_MASTER_KEY = original;
  });

  process.env.SECRETS_MASTER_KEY = Buffer.alloc(16).toString('base64');
  assert.throws(() => masterKey(), /must be 32 bytes/);

  delete process.env.SECRETS_MASTER_KEY;
  assert.throws(() => masterKey(), /not set/);
});

test('rotating the master key keeps the data key readable', () => {
  const oldKey = crypto.randomBytes(32);
  const newKey = crypto.randomBytes(32);
  const dek = generateDek();

  const wrapped = wrapDek(dek, oldKey);
  const rewrapped = rewrapDek(wrapped, oldKey, newKey);

  assert.deepEqual(unwrapDek(rewrapped, newKey), dek);
  // And the old master can no longer open the rewrapped key, which is the
  // point of rotating it.
  assert.throws(() => unwrapDek(rewrapped, oldKey));
});
