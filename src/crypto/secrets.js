import crypto from 'node:crypto';

/**
 * Envelope encryption for the credentials we hold on a tenant's behalf.
 *
 * SECRETS_MASTER_KEY wraps a per-tenant data key (the DEK, stored wrapped on
 * the tenant row); the DEK encrypts that tenant's secrets. Two reasons it is
 * not simply the master key encrypting everything:
 *
 *   - Rotating the master then means rewrapping one small column per tenant,
 *     not re-encrypting every secret on the platform.
 *   - Deleting a tenant's DEK renders that tenant's secrets unreadable in one
 *     statement, which is a cheap and verifiable form of erasure.
 *
 * Every ciphertext is bound to a context string (AES-GCM additional
 * authenticated data). The context includes the tenant id and the field name,
 * so a ciphertext lifted from one tenant's row and pasted into another's fails
 * to decrypt rather than quietly working. That turns a copy-paste or a bad
 * join into a loud error instead of one business issuing invoices with
 * another's credentials.
 */

const ALGO = 'aes-256-gcm';
const VERSION = 1;
const IV_LEN = 12;   // 96 bits, the GCM default and what Node's tag handling assumes
const TAG_LEN = 16;
const KEY_LEN = 32;

const DEK_CONTEXT = 'yesslip:dek:v1';

/** Layout: version(1) || iv(12) || tag(16) || ciphertext */
function seal(key, plaintext, context) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

function open(key, blob, context) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < 1 + IV_LEN + TAG_LEN) throw new Error('ciphertext is too short to be valid');

  const version = buf[0];
  if (version !== VERSION) throw new Error(`unknown ciphertext version ${version}`);

  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const body = buf.subarray(1 + IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * Read lazily rather than at import time, so that a tool which does not touch
 * secrets (a migration, a one-off script) runs without the key being present.
 */
export function masterKey() {
  const raw = process.env.SECRETS_MASTER_KEY;
  if (!raw) {
    throw new Error('SECRETS_MASTER_KEY is not set. Generate one with: npm run keygen');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`SECRETS_MASTER_KEY must be ${KEY_LEN} bytes of base64, got ${key.length}`);
  }
  return key;
}

export function generateDek() {
  return crypto.randomBytes(KEY_LEN);
}

export function wrapDek(dek, key = masterKey()) {
  if (!Buffer.isBuffer(dek) || dek.length !== KEY_LEN) {
    throw new Error(`a data key must be ${KEY_LEN} bytes`);
  }
  return seal(key, dek.toString('base64'), DEK_CONTEXT);
}

export function unwrapDek(wrapped, key = masterKey()) {
  const dek = Buffer.from(open(key, wrapped, DEK_CONTEXT), 'base64');
  if (dek.length !== KEY_LEN) throw new Error('unwrapped data key has the wrong length');
  return dek;
}

/**
 * `field` names what is being encrypted ('morning.key_secret'). It is part of
 * the authenticated context, so a value cannot be moved to a different column
 * any more than it can be moved to a different tenant.
 */
export function context(tenantId, field) {
  if (!tenantId) throw new Error('a secret context needs a tenant id');
  if (!field) throw new Error('a secret context needs a field name');
  return `yesslip:secret:v1:${tenantId}:${field}`;
}

export function encryptSecret(dek, plaintext, tenantId, field) {
  if (plaintext === undefined || plaintext === null || plaintext === '') {
    throw new Error(`refusing to encrypt an empty value for ${field}`);
  }
  return seal(dek, plaintext, context(tenantId, field));
}

export function decryptSecret(dek, blob, tenantId, field) {
  return open(dek, blob, context(tenantId, field));
}

/** Rewrap every DEK under a new master. Used by a rotation script. */
export function rewrapDek(wrapped, oldKey, newKey) {
  return wrapDek(unwrapDek(wrapped, oldKey), newKey);
}
