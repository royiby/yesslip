import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { log } from '../lib/logger.js';
import { cardPage, escapeHtml } from '../lib/html.js';
import { rateLimiter } from '../lib/ratelimit.js';
import { validateBookingPayload, validateQuotePayload, ValidationError } from '../lib/validate.js';
import { priceCart } from '../pricing.js';
import { registrationClosed } from '../programs/camp.js';
import { getProgramConfig } from '../programs/store.js';
import { getTenantBySlug, revealWebhookSecret } from '../tenants/store.js';
import { remainingPerDay, getConsent, newOrderId, CapacityError } from '../store/registrations.js';
import { readConsentDocument, AlreadySignedError } from '../consent/archive.js';
import { brandPalette } from '../lib/palette.js';
import { createBooking, confirmPayment } from '../orders.js';
import { objectStore } from '../storage/objects.js';
import { renderBookingPage, renderNotOpenPage } from './page.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The public booking surface, mounted at /b/:slug.
 *
 * ─────────────────────── why the slug is in the path ───────────────────────
 *
 * A subdomain per tenant would read better and needs a wildcard certificate, a
 * wildcard DNS record and, for custom domains, Cloudflare for SaaS. A path
 * prefix needs none of those and is one certificate. It can become a subdomain
 * later without touching anything below this line, because nothing below here
 * knows how the tenant was resolved: it reads req.tenant.
 *
 * ───────────────────────────── not cached ─────────────────────────────
 *
 * Every request reads the tenant row and the program config. The single-tenant
 * original held its config in a module variable because it was a file on disk,
 * and reloading it was a deliberate act. Two indexed reads are cheaper than
 * the staleness window a cache would introduce, and a business owner who drops
 * a price expects the next parent to see it. If this ever shows up in a
 * profile, the fix is a short-TTL cache keyed by tenant, not a module variable.
 */

/** Loads the tenant and its program. Anything missing answers before the
 *  handlers run, so no handler has to consider a half-resolved tenant. */
async function resolveTenant(req, res, next) {
  try {
    const tenant = await getTenantBySlug(String(req.params.slug ?? ''));
    if (!tenant) {
      return res.status(404).type('html').send(cardPage('הדף לא נמצא', '<p>בדקו את הקישור.</p>'));
    }
    if (tenant.status === 'cancelled') {
      return res.status(404).type('html').send(cardPage('הדף לא נמצא', '<p>בדקו את הקישור.</p>'));
    }
    req.tenant = tenant;
    req.base = `/b/${encodeURIComponent(tenant.slug)}`;
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * A suspended tenant is a real business whose link parents already have, so it
 * gets a sentence rather than a 404, and no way to pay. Separate from
 * resolveTenant because the confirmation and consent pages still have to work
 * for somebody who paid before the suspension.
 */
function requireOpen(req, res, next) {
  if (req.tenant.status === 'suspended') {
    return res.status(503).type('html').send(cardPage(
      'ההרשמה אינה זמינה כרגע',
      `<p>${escapeHtml(req.tenant.name)} לא פתוחה להרשמה ברגע זה. נסו שוב מאוחר יותר.</p>`,
      { brand: brandPalette({ primary: req.tenant.color_primary }).brand },
    ));
  }
  return next();
}

/** The program, or null. Attached by the routes that need one. */
async function loadCamp(req, res, next) {
  try {
    req.camp = await getProgramConfig(req.tenant.id, 'camp');
    return next();
  } catch (error) {
    return next(error);
  }
}

/** JSON endpoints answer in JSON, including when there is no program yet. */
function requireCamp(req, res, next) {
  if (!req.camp || req.camp.weeks.length === 0) {
    return res.status(404).json({ error: 'אין כרגע הרשמה פתוחה' });
  }
  return next();
}

export function makeBookingRouter() {
  const router = express.Router();

  // Long cache: the script is versioned by content hash, not by query string,
  // and a parent on a bad connection should not re-download it mid-form.
  router.use('/:slug/assets', express.static(join(here, 'assets'), {
    maxAge: '1h',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));

  router.get('/:slug', resolveTenant, requireOpen, loadCamp, async (req, res, next) => {
    try {
      if (!req.camp || req.camp.weeks.length === 0) {
        return res.status(404).type('html').send(renderNotOpenPage(req.tenant));
      }
      // Seat counts are a nicety; the authoritative capacity check happens on
      // submit, inside the transaction. If the read fails the page still opens
      // rather than showing a parent an error they cannot act on.
      let availability = new Map();
      try {
        availability = await remainingPerDay(req.tenant.id, req.camp);
      } catch (error) {
        log.error('booking.availability_unavailable', {
          tenantId: req.tenant.id, error: error.message,
        });
      }
      return res.type('html').set('Cache-Control', 'no-store').send(renderBookingPage({
        tenant: req.tenant,
        camp: req.camp,
        availability,
        closed: registrationClosed(req.camp),
        base: req.base,
      }));
    } catch (error) {
      return next(error);
    }
  });

  /** The business's logo, streamed from object storage. */
  router.get('/:slug/logo', resolveTenant, async (req, res, next) => {
    try {
      if (!req.tenant.logo_key) return res.sendStatus(404);
      const bytes = await objectStore().get(req.tenant.logo_key);
      if (!bytes) return res.sendStatus(404);
      return res
        .set('Cache-Control', 'public, max-age=3600')
        .set('X-Content-Type-Options', 'nosniff')
        .type(req.tenant.logo_key.endsWith('.svg') ? 'image/svg+xml' : 'image/png')
        .send(bytes);
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    '/:slug/api/quote',
    express.json({ limit: '32kb' }),
    resolveTenant, requireOpen, loadCamp, requireCamp,
    (req, res) => {
      try {
        const cart = validateQuotePayload(req.camp, req.body);
        const priced = priceCart(req.camp, cart);
        res.json({
          total: priced.total,
          discountTotal: priced.discountTotal,
          savingsTotal: priced.savingsTotal,
          items: priced.items.map((item) => ({
            childName: item.childName,
            dayCount: item.dayCount,
            mode: item.mode,
            upgraded: item.upgraded,
            listAmount: item.listAmount,
            discount: item.discount,
            amount: item.amount,
          })),
        });
      } catch (error) {
        if (error instanceof ValidationError) {
          return res.status(400).json({ error: error.message, field: error.field });
        }
        log.error('quote.failed', { tenantId: req.tenant.id, error: error.message });
        return res.status(500).json({ error: 'שגיאה בחישוב המחיר' });
      }
    },
  );

  router.post(
    '/:slug/api/book',
    resolveTenant, requireOpen,
    rateLimiter({ windowMs: 60_000, max: 6, event: 'booking.rate_limited' }),
    express.json({ limit: '1mb' }), // the signature PNG travels in this body
    loadCamp, requireCamp,
    async (req, res) => {
      if (registrationClosed(req.camp)) {
        return res.status(409).json({ error: 'ההרשמה המקוונת נסגרה.' });
      }

      let payload;
      try {
        payload = validateBookingPayload(req.camp, req.body);
      } catch (error) {
        if (error instanceof ValidationError) {
          return res.status(400).json({ error: error.message, field: error.field });
        }
        throw error;
      }

      const orderId = newOrderId();
      try {
        const webhookSecret = await revealWebhookSecret(req.tenant.id);
        const booking = await createBooking({
          tenant: { ...req.tenant, webhookSecret },
          camp: req.camp,
          orderId,
          parent: payload.parent,
          cart: payload.children,
          answers: payload.answers,
          signature: payload.signature,
          meta: {
            ip: req.ip ?? '',
            userAgent: req.get('user-agent') ?? '',
          },
          notes: payload.answers.allergies ? 'יש הערות רפואיות, ראו טופס חתום' : '',
        });

        log.info('booking.submitted', {
          tenantId: req.tenant.id, orderId, total: booking.priced.total,
        });
        return res.json({
          orderId, paymentUrl: booking.paymentUrl, total: booking.priced.total,
        });
      } catch (error) {
        if (error instanceof CapacityError) {
          return res.status(409).json({ error: error.message, field: 'children' });
        }
        if (error instanceof AlreadySignedError) {
          // An order id collision, which is a 1-in-4-billion event per tenant.
          // Worth an explicit branch anyway: silently overwriting a signed form
          // is the one outcome that must be impossible.
          log.error('booking.order_id_collision', { tenantId: req.tenant.id, orderId });
          return res.status(500).json({ error: 'נסו שוב, אירעה תקלה זמנית.' });
        }
        log.error('booking.failed', {
          tenantId: req.tenant.id, orderId,
          error: error.message, stack: error.stack?.split('\n')[1],
        });
        return res.status(500).json({
          error: 'ההרשמה לא הושלמה ולא נגבה דבר. נסו שוב, או שלחו לנו הודעה ונרשום אותך/אותכם ידנית.',
        });
      }
    },
  );

  /**
   * The signed form, for the parent and for the business's records.
   *
   * The key is read from the consent row, which row-level security already
   * scoped to this tenant, so a guessed order id belonging to another business
   * resolves to no row, therefore to no key, therefore to a 404. The object
   * store is never addressed with anything from the URL.
   */
  router.get('/:slug/consent/:orderId', resolveTenant, async (req, res, next) => {
    try {
      const consent = await getConsent(req.tenant.id, String(req.params.orderId));
      if (!consent) {
        return res.status(404).type('html').send(cardPage('הטופס לא נמצא', '<p>בדקו את הקישור.</p>'));
      }
      if (consent.destroyed_at) {
        return res.status(410).type('html').send(cardPage(
          'הטופס נמחק',
          '<p>תקופת השמירה של הטופס הסתיימה והוא נמחק. רישום החתימה עצמו נשמר.</p>',
        ));
      }
      const html = await readConsentDocument(consent.archive_key);
      if (!html) {
        log.error('consent.missing_object', {
          tenantId: req.tenant.id, orderId: consent.order_id, key: consent.archive_key,
        });
        return res.status(404).type('html').send(cardPage('הטופס לא נמצא', '<p>בדקו את הקישור.</p>'));
      }
      return res.type('html').set('Cache-Control', 'private, no-store').send(html);
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:slug/paid', resolveTenant, loadCamp, (req, res) => {
    const orderId = String(req.query.order ?? '');
    const brand = brandPalette({ primary: req.tenant.color_primary }).brand;
    const consentLink = /^[A-Z0-9-]{1,64}$/.test(orderId)
      ? `<p><a href="${escapeHtml(req.base)}/consent/${encodeURIComponent(orderId)}">הטופס החתום שלכם</a></p>`
      : '';
    const camp = req.camp;
    res.type('html').send(cardPage('✅ התשלום התקבל', `
      <p>תודה! ההרשמה ל<strong>${escapeHtml(camp?.campName ?? req.tenant.name)}</strong> הושלמה.</p>
      <p>החשבונית נשלחת אליכם במייל ממורנינג.</p>
      ${consentLink}
      ${camp?.hours ? `<p class="muted">שעות: ${escapeHtml(camp.hours)}</p>` : ''}
      ${camp?.location ? `<p class="muted">מקום: ${escapeHtml(camp.location)}</p>` : ''}
      <p class="muted">אסמכתא: ${escapeHtml(orderId)}</p>`, { brand }));
  });

  router.get('/:slug/payment-failed', resolveTenant, (req, res) => {
    const brand = brandPalette({ primary: req.tenant.color_primary }).brand;
    res.type('html').send(cardPage('התשלום לא הושלם', `
      <p>לא נגבה דבר, וההרשמה לא הושלמה.</p>
      <p><a href="${escapeHtml(req.base)}">חזרה לדף ההרשמה</a></p>
      <p class="muted">אסמכתא: ${escapeHtml(String(req.query.order ?? ''))}</p>`, { brand }));
  });

  return router;
}

/**
 * Morning does not sign its callbacks, so the notifyUrl handed to it carries a
 * secret query parameter, compared in constant time.
 *
 * The secret is per tenant. That is the part worth dwelling on: with one
 * platform-wide secret, anyone who ever saw a single notifyUrl (in a browser's
 * network tab, in a Morning account's own settings, in a support screenshot)
 * could mark any order of any business paid. Per tenant, the same leak costs
 * one business. The tenant comes from the path, so the handler knows whose
 * secret to compare before comparing anything.
 */
function secretOk(expected, provided) {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  // Lengths are compared first because timingSafeEqual throws on a mismatch,
  // and the length of a secret is not the secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function makeWebhookRouter() {
  const router = express.Router();

  router.post(
    '/morning/:slug/payment',
    express.urlencoded({ extended: false, limit: '1mb' }),
    express.json({ limit: '1mb' }),
    async (req, res) => {
      const tenant = await getTenantBySlug(String(req.params.slug ?? ''));
      if (!tenant) {
        log.warn('morning.webhook_unknown_tenant', { slug: req.params.slug });
        return res.sendStatus(404);
      }

      const expected = await revealWebhookSecret(tenant.id);
      if (!secretOk(expected, req.query.secret)) {
        log.warn('morning.webhook_bad_secret', { tenantId: tenant.id });
        return res.sendStatus(401);
      }

      const body = req.body ?? {};

      // Morning's callback field names are not documented and were taken from
      // community sources. Logging the keys it actually sends turns a silent
      // mismatch into something readable in the deploy logs.
      log.info('morning.webhook_fields', {
        tenantId: tenant.id,
        keys: Object.keys(body).sort(),
        correlationField: body.external_data !== undefined ? 'external_data'
          : body.externalData !== undefined ? 'externalData'
            : body.custom !== undefined ? 'custom'
              : 'NONE, correlation will fail',
      });

      const orderId = body.external_data || body.externalData || body.custom || null;
      if (!orderId) {
        // Nothing to correlate. Acknowledge so Morning stops retrying, and
        // leave a loud log line: this means a payment link was created without
        // `custom`, which is a bug on our side, not theirs.
        log.error('morning.webhook_missing_order', {
          tenantId: tenant.id, body: JSON.stringify(body).slice(0, 500),
        });
        return res.sendStatus(200);
      }

      try {
        const result = await confirmPayment(tenant.id, {
          orderId: String(orderId),
          transactionId: body.transaction_id ?? body.transactionId ?? '',
          // `number` is the invoice number the business can search Morning
          // with; `document_id` is an internal id and means nothing to them.
          documentNumber: body.number ?? body.document_id ?? '',
          documentUrl: body.url ?? body.original_doc_url ?? '',
        });
        if (!result.ok) {
          // An order this tenant does not have. Acknowledged rather than
          // retried: retrying will not make it appear, and a 500 would have
          // Morning redelivering it for an hour.
          log.error('morning.webhook_order_not_found', { tenantId: tenant.id, orderId });
          return res.sendStatus(200);
        }
      } catch (error) {
        log.error('morning.webhook_failed', {
          tenantId: tenant.id, orderId,
          error: error.message, stack: error.stack?.split('\n')[1],
        });
        // 500 makes Morning retry, at 10, 20 and 30 minutes, which is what we
        // want when the database was briefly unavailable.
        return res.sendStatus(500);
      }
      return res.sendStatus(200);
    },
  );

  return router;
}

export const _internals = { secretOk, resolveTenant, requireOpen };
