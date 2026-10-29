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

/**
 * A camp config good enough to book against: two weeks, one of them capped at
 * two seats so a capacity test has something to fill. Dates are far in the
 * future so a test never depends on today.
 */
export function sampleCamp(overrides = {}) {
  return {
    campName: 'קייטנת בדיקה',
    timezone: 'Asia/Jerusalem',
    currency: 'ILS',
    pricing: { dailyPrice: 150, weeklyPrice: 600, siblingDiscountPercent: 10, vatType: 1 },
    hours: '08:00-14:00',
    location: 'רחוב הבדיקה 1',
    includes: 'ארוחת בוקר',
    cancellationPolicy: 'ביטול עד 48 שעות לפני תחילת היום המוזמן',
    registrationClosesAt: '',
    paymentLinkTtlMinutes: 60,
    consent: {
      terms: ['סעיף ראשון', 'סעיף שני'],
      healthDeclaration: 'אני מצהיר/ה שהילד/ה בריא/ה',
      photoConsent: 'אני מאשר/ת צילום ופרסום',
      allergiesPrompt: 'רגישויות ואלרגיות',
      pickupPrompt: 'מורשים לאיסוף',
    },
    weeks: [
      {
        id: 'w1',
        label: 'שבוע ראשון',
        capacityPerDay: 2,
        days: ['2030-07-01', '2030-07-02', '2030-07-03', '2030-07-04', '2030-07-05'],
      },
      {
        id: 'w2',
        label: 'שבוע שני',
        capacityPerDay: null,
        days: ['2030-07-08', '2030-07-09', '2030-07-10', '2030-07-11', '2030-07-12'],
      },
    ],
    ...overrides,
  };
}

/** The decorated form, for anything that prices or validates without a database. */
export async function decoratedSampleCamp(overrides = {}) {
  const { decorateCamp } = await import('../src/programs/camp.js');
  return decorateCamp(sampleCamp(overrides));
}

/** A 1x1 transparent PNG, as the signature canvas would produce it. */
export const SIGNATURE_PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** A signature long enough to pass the form's length check. */
export function longSignature() {
  const prefix = 'data:image/png;base64,';
  const bytes = Buffer.from(SIGNATURE_PNG.slice(prefix.length), 'base64');
  // Pad the PNG with a trailing comment-ish chunk of zero bytes. The magic
  // number is what parseSignature checks, and it stays at the front.
  return prefix + Buffer.concat([bytes, Buffer.alloc(200)]).toString('base64');
}
