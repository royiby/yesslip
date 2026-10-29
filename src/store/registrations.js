import { randomUUID } from 'node:crypto';
import { withTenant } from '../db/index.js';
import { log } from '../lib/logger.js';
import { dateShort } from '../lib/hebrew.js';

/**
 * Registrations, attendance and consents.
 *
 * ───────────────────── the race the spreadsheet could not win ─────────────────
 *
 * The single-tenant original read the sheet to count seats, then appended rows.
 * Between those two calls another parent could do the same, and both could be
 * sold the last seat. The window was a Google Sheets round trip wide, which is
 * hundreds of milliseconds, and camp registration opens at a published time
 * with everybody arriving at once. It was the most likely bug in the system.
 *
 * Here the count and the insert are one transaction, serialised per tenant by
 * `pg_advisory_xact_lock`. The lock is per tenant, not global, so one
 * business's 20:00 rush does not queue behind another's. Overselling now needs
 * two transactions to hold the same advisory lock at the same time, which
 * Postgres does not permit.
 *
 * The lock is taken, not relied on alone: `assertCapacity` runs inside it, and
 * it is the combination that is the guarantee. An advisory lock nobody else
 * takes protects nothing, so every path that inserts registrations goes through
 * `createOrderRows`.
 */

/** Any constant; it only has to be the same in every caller that competes. */
const CAPACITY_LOCK_CLASS = 8_201;

export const STATUS = {
  pending: 'pending',   // link sent, not paid yet, holds a soft reservation
  paid: 'paid',
  cancelled: 'cancelled',
  expired: 'expired',
};

export function newOrderId() {
  // Short enough to read out over the phone, random enough not to be guessable.
  return randomUUID().split('-')[0].toUpperCase();
}

/** Dates come back as ISO strings, never as Date objects: a booked day is a
 *  civil date, and parsing it into an instant is how it moves by one. */
const DAYS_AS_TEXT = `ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(days) d)`;

async function lockCapacity(client, tenantId) {
  await client.query(
    'SELECT pg_advisory_xact_lock($1, hashtext($2))',
    [CAPACITY_LOCK_CLASS, String(tenantId)],
  );
}

/**
 * Seats taken per day: every paid row, plus pending rows still inside their
 * payment window. A parent mid-checkout holds their seat, but an abandoned
 * link releases it instead of blocking the day forever.
 */
async function takenPerDayWith(client, camp) {
  const ttlMinutes = Number(camp.paymentLinkTtlMinutes ?? 60);
  const { rows } = await client.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day, count(*)::int AS taken
       FROM registrations, unnest(days) AS d
      WHERE status = 'paid'
         OR (status = 'pending' AND created_at > now() - make_interval(mins => $1))
      GROUP BY 1`,
    [ttlMinutes],
  );
  return new Map(rows.map((r) => [r.day, r.taken]));
}

export async function takenPerDay(tenantId, camp) {
  return withTenant(tenantId, (client) => takenPerDayWith(client, camp));
}

/** Remaining seats per day, or null for a day with no configured capacity. */
export function remainingFrom(camp, taken) {
  const remaining = new Map();
  for (const week of camp.weeks) {
    for (const day of week.days) {
      const capacity = week.capacityPerDay;
      remaining.set(day, capacity ? Math.max(0, capacity - (taken.get(day) ?? 0)) : null);
    }
  }
  return remaining;
}

export async function remainingPerDay(tenantId, camp) {
  const taken = await takenPerDay(tenantId, camp);
  return remainingFrom(camp, taken);
}

export class CapacityError extends Error {
  constructor(full) {
    super(`אין מקום בימים: ${full.map((f) => dateShort(f.day)).join(', ')}`);
    this.name = 'CapacityError';
    this.code = 'CAPACITY';
    this.full = full;
  }
}

/** Throws rather than returning a flag: inside a transaction, the throw is also
 *  the rollback, and the two must not be able to come apart. */
function assertCapacity(camp, taken, cart) {
  const wanted = new Map();
  for (const entry of cart) {
    for (const day of entry.days) wanted.set(day, (wanted.get(day) ?? 0) + 1);
  }
  const remaining = remainingFrom(camp, taken);
  const full = [];
  for (const [day, count] of wanted) {
    const left = remaining.get(day);
    if (left !== null && left !== undefined && left < count) {
      full.push({ day, left, wanted: count });
    }
  }
  if (full.length > 0) throw new CapacityError(full);
}

/** The unlocked read, for the seat counts on the booking page and for the fast
 *  rejection before anything is written. Advisory, by design: the authority is
 *  the check inside createOrderRows. */
export async function checkCapacity(tenantId, camp, cart) {
  const taken = await takenPerDay(tenantId, camp);
  try {
    assertCapacity(camp, taken, cart);
    return { ok: true, full: [] };
  } catch (error) {
    if (error instanceof CapacityError) return { ok: false, full: error.full };
    throw error;
  }
}

/**
 * One row per child, all sharing an order id, plus the consent row, plus the
 * capacity check that makes them legitimate. One transaction, so there is no
 * state in which a registration exists without the signature behind it.
 *
 * The consent document itself is already in object storage by the time this is
 * called. That order is deliberate: a document with no registration is an
 * orphan the retention sweep collects, while a registration with no document is
 * a business taking money for a form nobody signed.
 */
export async function createOrderRows({
  tenantId, orderId, camp, priced, parent, consent, notes = '',
}) {
  return withTenant(tenantId, async (client) => {
    await lockCapacity(client, tenantId);

    const taken = await takenPerDayWith(client, camp);
    assertCapacity(camp, taken, priced.items);

    const rows = [];
    for (const [index, item] of priced.items.entries()) {
      const { rows: inserted } = await client.query(
        `INSERT INTO registrations (
           tenant_id, order_id, row_id, phone, parent_name, parent_email,
           child_name, child_grade, week_id, days, day_count, pricing_mode,
           list_amount, discount, amount, currency, status, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date[],$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id, row_id`,
        [
          tenantId, orderId, `${orderId}-${index + 1}`,
          parent.phone, parent.name, parent.email ?? '',
          item.childName, item.childGrade ?? '', item.weekId,
          item.days, item.dayCount, item.mode,
          item.listAmount, item.discount, item.amount,
          camp.currency ?? 'ILS', STATUS.pending, notes,
        ],
      );
      rows.push(inserted[0]);
    }

    await client.query(
      `INSERT INTO consents (
         tenant_id, order_id, signed_at, signer_name, signer_id, phone, email,
         children, terms_version, health_declaration, photo_consent,
         ip, user_agent, archive_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::inet,$13,$14)`,
      [
        tenantId, orderId, consent.signedAt, consent.signerName, consent.signerId,
        consent.phone, consent.email, consent.children.join(', '),
        consent.termsVersion, consent.healthDeclaration, consent.photoConsent,
        consent.ip || null, consent.userAgent ?? '', consent.archiveKey,
      ],
    );

    log.info('order.created', { tenantId, orderId, children: rows.length, total: priced.total });
    return rows;
  });
}

/** Every row of one order, or null. */
export async function getOrder(tenantId, orderId) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, order_id, row_id, created_at, phone, parent_name, parent_email,
              child_name, child_grade, week_id, ${DAYS_AS_TEXT} AS days, day_count,
              pricing_mode, list_amount, discount, amount, currency, status,
              paid_at, payment_url, transaction_id, doc_number, doc_url, notes
         FROM registrations WHERE order_id = $1 ORDER BY row_id`,
      [orderId],
    );
    if (rows.length === 0) return null;
    return {
      orderId,
      rows,
      phone: rows[0].phone,
      parentName: rows[0].parent_name,
      parentEmail: rows[0].parent_email,
      status: rows[0].status,
      total: rows.reduce((sum, r) => sum + Number(r.amount || 0), 0),
      currency: rows[0].currency || 'ILS',
      createdAt: rows[0].created_at,
      paymentUrl: rows[0].payment_url,
    };
  });
}

/** The columns an order patch may touch, so a caller cannot name a column. */
const PATCHABLE = new Set([
  'status', 'paid_at', 'payment_url', 'transaction_id', 'doc_number', 'doc_url', 'notes',
]);

export async function updateOrder(tenantId, orderId, patch) {
  const entries = Object.entries(patch).filter(([key]) => PATCHABLE.has(key));
  if (entries.length === 0) return 0;

  const sets = entries.map(([key], i) => `${key} = $${i + 2}`).join(', ');
  const values = entries.map(([, value]) => value);

  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `UPDATE registrations SET ${sets} WHERE order_id = $1`,
      [orderId, ...values],
    );
    return rowCount;
  });
}

/**
 * Mark an order paid and write its attendance rows. Idempotent, because Morning
 * retries a non-2xx callback at 10, 20 and 30 minutes: a second delivery must
 * not double-write attendance, and the check and the write therefore share one
 * transaction rather than being two statements that usually run together.
 */
export async function markPaid(tenantId, orderId, {
  transactionId = '', documentNumber = '', documentUrl = '',
} = {}) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, order_id, row_id, status, phone, parent_name, child_name, child_grade,
              ${DAYS_AS_TEXT} AS days, amount
         FROM registrations WHERE order_id = $1 ORDER BY row_id FOR UPDATE`,
      [orderId],
    );
    if (rows.length === 0) {
      log.error('payment.unknown_order', { tenantId, orderId });
      return { ok: false, reason: 'order-not-found' };
    }
    if (rows[0].status === STATUS.paid) {
      log.info('payment.already_confirmed', { tenantId, orderId });
      return { ok: true, duplicate: true, attendanceRows: 0 };
    }

    await client.query(
      `UPDATE registrations
          SET status = $2, paid_at = now(), transaction_id = $3, doc_number = $4, doc_url = $5
        WHERE order_id = $1`,
      [orderId, STATUS.paid, transactionId, documentNumber, documentUrl],
    );

    let attendanceRows = 0;
    for (const row of rows) {
      for (const day of row.days) {
        await client.query(
          `INSERT INTO attendance (
             tenant_id, registration_id, date, child_name, child_grade,
             parent_name, phone, order_id, status
           ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,'expected')`,
          [
            tenantId, row.id, day, row.child_name, row.child_grade,
            row.parent_name, row.phone, orderId,
          ],
        );
        attendanceRows += 1;
      }
    }

    const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    log.info('payment.confirmed', { tenantId, orderId, total, attendanceRows });
    return { ok: true, attendanceRows, total };
  });
}

/** The signed document's key and whether its bytes are still held. */
export async function getConsent(tenantId, orderId) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT order_id, signed_at, signer_name, terms_version, archive_key, destroyed_at
         FROM consents WHERE order_id = $1`,
      [orderId],
    );
    return rows[0] ?? null;
  });
}

/** The staff-facing daily list. */
export async function attendanceForDate(tenantId, isoDate) {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, child_name, child_grade,
              parent_name, phone, order_id, status
         FROM attendance WHERE date = $1::date ORDER BY child_name`,
      [isoDate],
    );
    return rows;
  });
}

export const _internals = { assertCapacity, CAPACITY_LOCK_CLASS, PATCHABLE };
