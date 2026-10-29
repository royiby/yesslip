import { log } from './lib/logger.js';
import { priceCart, cartToIncomeLines } from './pricing.js';
import { morningFor } from './morning/index.js';
import { archiveConsent } from './consent/archive.js';
import {
  STATUS, newOrderId, checkCapacity, createOrderRows, updateOrder, markPaid, CapacityError,
} from './store/registrations.js';

/**
 * The order lifecycle, with no knowledge of how the parent reached us. The
 * booking page goes through here, and so will anything else that ever creates
 * an order, so payment confirmation behaves identically whatever created it.
 *
 * Everything here takes an explicit tenant. There is no ambient "current
 * business": the single-tenant original could read its camp from a module and
 * its Morning client from another, and both of those are exactly the shapes
 * that leak between tenants in one process.
 */

export { STATUS, newOrderId, CapacityError };

function baseUrl() {
  return String(process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
}

/**
 * The redirect and callback URLs for one order.
 *
 * The webhook secret is per tenant, minted when that business connects Morning.
 * A single platform-wide secret would mean anyone who ever saw one tenant's
 * notifyUrl could mark another tenant's registrations paid, which is the
 * difference between a leaked secret costing one business and costing all of
 * them. The tenant is in the path so the handler knows whose secret to compare
 * against before it compares anything.
 */
export function urlsFor({ slug, orderId, webhookSecret }) {
  const base = baseUrl();
  const notify = new URL(`${base}/webhooks/morning/${encodeURIComponent(slug)}/payment`);
  notify.searchParams.set('secret', webhookSecret ?? '');
  return {
    successUrl: `${base}/b/${encodeURIComponent(slug)}/paid?order=${encodeURIComponent(orderId)}`,
    failureUrl: `${base}/b/${encodeURIComponent(slug)}/payment-failed?order=${encodeURIComponent(orderId)}`,
    notifyUrl: notify.toString(),
  };
}

/**
 * Sign, reserve, charge. In that order, and the order is the point:
 *
 *   1. Capacity, unlocked, so a parent who cannot be seated is told before
 *      anything is written anywhere.
 *   2. The signed document into object storage, write-once.
 *   3. Capacity again under a per-tenant lock, then the registration rows and
 *      the consent row, in one transaction. This is the authoritative check.
 *   4. The Morning payment link, and only then is the parent sent to pay.
 *
 * A business must never be able to take a payment for a registration that has
 * no signed form behind it, which rules out doing 4 before 2.
 */
export async function createBooking({
  tenant, camp, parent, cart, answers, signature, meta, notes = '', orderId = newOrderId(),
}) {
  if (!Array.isArray(cart) || cart.length === 0) throw new Error('העגלה ריקה');

  const priced = priceCart(camp, cart);
  if (!(priced.total > 0)) throw new Error('סכום ההזמנה חייב להיות גדול מאפס');

  const morning = await morningFor(tenant.id);
  if (!morning) {
    // Checked before the document is written: a tenant whose Morning account is
    // not connected cannot take a payment, and signing a form that cannot lead
    // to one wastes the parent's time and leaves an orphan to collect.
    throw new Error('העסק הזה עדיין לא חיבר חשבון מורנינג, ולכן אי אפשר להירשם כרגע');
  }

  const early = await checkCapacity(tenant.id, camp, priced.items);
  if (!early.ok) throw new CapacityError(early.full);

  const { archiveKey, consent } = await archiveConsent({
    tenantId: tenant.id,
    camp,
    orderId,
    signer: {
      name: parent.name,
      idNumber: parent.idNumber,
      phone: parent.phoneLocal ?? parent.phone,
      email: parent.email,
    },
    children: priced.items,
    answers,
    signature,
    meta,
  });

  await createOrderRows({
    tenantId: tenant.id,
    orderId,
    camp,
    priced,
    parent,
    consent: { ...consent, archiveKey },
    notes,
  });

  const { successUrl, failureUrl, notifyUrl } = urlsFor({
    slug: tenant.slug, orderId, webhookSecret: tenant.webhookSecret,
  });

  let payment;
  try {
    payment = await morning.createPaymentForm({
      description: `${camp.campName} · הזמנה ${orderId}`,
      amount: priced.total,
      currency: camp.currency ?? 'ILS',
      client: {
        name: parent.name,
        phone: parent.phone,
        emails: parent.email ? [parent.email] : [],
        add: true, // keeps the business's own Morning client list up to date
      },
      income: cartToIncomeLines(camp, priced),
      custom: orderId, // comes back as external_data, the only correlation handle
      successUrl,
      failureUrl,
      notifyUrl,
    });
  } catch (error) {
    // The rows already exist. Mark them so an abandoned order is explainable
    // and does not silently hold seats until its TTL expires.
    await updateOrder(tenant.id, orderId, {
      status: STATUS.cancelled,
      notes: `payment-link-failed: ${error.message}`.slice(0, 400),
    }).catch(() => {});
    throw error;
  }

  await updateOrder(tenant.id, orderId, { payment_url: payment.url });
  log.info('booking.created', {
    tenantId: tenant.id, orderId, total: priced.total, children: cart.length,
  });
  return { orderId, paymentUrl: payment.url, priced, archiveKey };
}

/** Called from the Morning webhook. Idempotent; see markPaid. */
export async function confirmPayment(tenantId, { orderId, transactionId, documentNumber, documentUrl }) {
  return markPaid(tenantId, orderId, { transactionId, documentNumber, documentUrl });
}
