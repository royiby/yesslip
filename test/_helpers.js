import crypto from 'node:crypto';
import { platform, closePool } from '../src/db/index.js';
import { createTenant } from '../src/tenants/store.js';

/**
 * Tests run against a real Postgres as the real app role (yesslip_app), not as
 * the owner. That is deliberate: row-level security does not apply to a table's
 * owner unless forced, so a test suite connected as the owner would pass while
 * production leaked.
 *
 * Start one with: npm run db:up && npm run migrate
 */

export function uniqueSlug(prefix = 't') {
  return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
}

export async function makeTenant(name = 'עסק לבדיקה') {
  return createTenant({ slug: uniqueSlug(), name });
}

export async function dropTenant(id) {
  if (!id) return;
  // Cascades to every tenant table. Also drops the wrapped data key, which is
  // what makes any surviving copy of that tenant's secrets unreadable.
  await platform((client) => client.query('DELETE FROM tenants WHERE id = $1', [id]));
}

export async function dropUser(id) {
  if (!id) return;
  await platform((client) => client.query('DELETE FROM users WHERE id = $1', [id]));
}

export async function makeUser(suffix = crypto.randomBytes(4).toString('hex')) {
  const { upsertUserFromGoogle } = await import('../src/auth/store.js');
  return upsertUserFromGoogle({
    sub: `google-${suffix}`, email: `user-${suffix}@example.com`, name: 'משתמש בדיקה',
  });
}

export { closePool };

/** A fetch stand-in that records calls and replays queued responses. */
export function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method ?? 'GET', body, headers: options.headers ?? {} });
    const reply = await handler({ url: String(url), options, body, index: calls.length - 1 });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? '')),
    };
  };
  impl.calls = calls;
  return impl;
}
