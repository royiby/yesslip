import crypto from 'node:crypto';
import { platform, platformTx } from '../db/index.js';
import {
  generateDek, wrapDek, unwrapDek, encryptSecret, decryptSecret,
} from '../crypto/secrets.js';

/**
 * Tenants, and the credentials we hold for them.
 *
 * Everything that decrypts a secret lives in this file, and nothing in it is
 * reachable from a route handler without going through a named function whose
 * name says what it hands back. There is deliberately no `getTenant()` that
 * returns the decrypted Morning secret alongside the branding: the two have
 * very different blast radii and should not travel together.
 */

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

// Reserved because they are, or will be, paths and hostnames of our own.
const RESERVED_SLUGS = new Set([
  'app', 'api', 'www', 'admin', 'static', 'assets', 'help', 'support',
  'status', 'docs', 'blog', 'mail', 'billing', 'login', 'signup', 'webhook',
]);

export function slugProblem(slug) {
  const value = String(slug ?? '');
  if (!SLUG.test(value)) {
    return 'הכתובת יכולה להכיל אותיות אנגליות קטנות, ספרות ומקפים, באורך 3 עד 40 תווים';
  }
  if (RESERVED_SLUGS.has(value)) return 'הכתובת הזו שמורה, בחרו אחרת';
  return null;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Colors are checked here as well as by a CHECK constraint, because by the
 * time one reaches the database it has already been interpolated into a CSS
 * custom property in some code path we have not written yet. Two walls.
 */
export function colorProblem(color) {
  return HEX_COLOR.test(String(color ?? '')) ? null : 'צבע חייב להיות בפורמט #RRGGBB';
}

export async function createTenant({ slug, name, colorPrimary, colorAccent, timezone, locale }) {
  const problem = slugProblem(slug);
  if (problem) throw new Error(problem);
  for (const color of [colorPrimary, colorAccent]) {
    if (color !== undefined) {
      const bad = colorProblem(color);
      if (bad) throw new Error(bad);
    }
  }

  // The data key is generated here and never leaves wrapped. Nothing stores or
  // logs the plaintext DEK.
  const wrapped = wrapDek(generateDek());

  return platform(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO tenants (slug, name, dek_wrapped, color_primary, color_accent, timezone, locale)
       VALUES ($1, $2, $3, COALESCE($4, '#2563eb'), COALESCE($5, '#f59e0b'),
               COALESCE($6, 'Asia/Jerusalem'), COALESCE($7, 'he'))
       RETURNING id, slug, name, status, color_primary, color_accent, logo_key,
                 timezone, currency, locale, created_at`,
      [slug, name, wrapped, colorPrimary ?? null, colorAccent ?? null, timezone ?? null, locale ?? null],
    );
    return rows[0];
  });
}

/** Public-safe columns. Note what is absent: dek_wrapped. */
const PUBLIC_COLUMNS = `id, slug, name, status, color_primary, color_accent, logo_key,
                        timezone, currency, locale, created_at, updated_at`;

export async function getTenantBySlug(slug) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT ${PUBLIC_COLUMNS} FROM tenants WHERE slug = $1`, [slug],
    );
    return rows[0] ?? null;
  });
}

export async function getTenantById(id) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT ${PUBLIC_COLUMNS} FROM tenants WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  });
}

export async function listTenants({ status = null } = {}) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT ${PUBLIC_COLUMNS} FROM tenants
       WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at`,
      [status],
    );
    return rows;
  });
}

async function dekFor(client, tenantId) {
  const { rows } = await client.query('SELECT dek_wrapped FROM tenants WHERE id = $1', [tenantId]);
  if (!rows[0]) throw new Error(`no such tenant: ${tenantId}`);
  return unwrapDek(rows[0].dek_wrapped);
}

/**
 * Store a tenant's Morning credentials.
 *
 * `obtainedVia` is 'pasted' today and 'partner' if Morning ever grants partner
 * access. That is the only field that differs between the two paths, which is
 * what keeps the partner program an onboarding change rather than a rewrite.
 *
 * The webhook secret is generated here, per tenant, and never shared. It rides
 * in the notifyUrl that Morning receives and therefore sits in Morning's logs,
 * so it must not be reusable for anything else.
 */
export async function saveMorningConnection(tenantId, {
  keyId, keySecret, environment = 'production', obtainedVia = 'pasted', documentType = 320,
}) {
  if (!keyId || !keySecret) throw new Error('חסר מזהה מפתח או מפתח סודי של מורנינג');
  if (!['sandbox', 'production'].includes(environment)) {
    throw new Error(`unknown Morning environment: ${environment}`);
  }

  return platformTx(async (client) => {
    const dek = await dekFor(client, tenantId);
    const webhookSecret = crypto.randomBytes(32).toString('base64url');

    const { rows } = await client.query(
      `INSERT INTO tenant_connections
         (tenant_id, provider, environment, key_id_enc, key_secret_enc,
          webhook_secret_enc, obtained_via, document_type, status)
       VALUES ($1, 'morning', $2, $3, $4, $5, $6, $7, 'unverified')
       ON CONFLICT (tenant_id, provider) DO UPDATE SET
         environment        = EXCLUDED.environment,
         key_id_enc         = EXCLUDED.key_id_enc,
         key_secret_enc     = EXCLUDED.key_secret_enc,
         webhook_secret_enc = EXCLUDED.webhook_secret_enc,
         obtained_via       = EXCLUDED.obtained_via,
         document_type      = EXCLUDED.document_type,
         status             = 'unverified',
         last_error         = NULL,
         verified_at        = NULL,
         plugin_id          = NULL
       RETURNING id, status, environment, obtained_via`,
      [
        tenantId, environment,
        encryptSecret(dek, keyId, tenantId, 'morning.key_id'),
        encryptSecret(dek, keySecret, tenantId, 'morning.key_secret'),
        encryptSecret(dek, webhookSecret, tenantId, 'morning.webhook_secret'),
        obtainedVia, documentType,
      ],
    );
    return rows[0];
  });
}

/**
 * The decrypted credentials, for building a Morning client. The name is blunt
 * on purpose: this is the one function in the codebase that hands back a live
 * secret, and a call to it should be obvious in review.
 *
 * Never return this to an HTTP response.
 */
export async function revealMorningCredentials(tenantId) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT c.key_id_enc, c.key_secret_enc, c.webhook_secret_enc, c.environment,
              c.plugin_id, c.document_type, c.status, t.dek_wrapped
         FROM tenant_connections c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.provider = 'morning'`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) return null;

    const dek = unwrapDek(row.dek_wrapped);
    return {
      keyId: decryptSecret(dek, row.key_id_enc, tenantId, 'morning.key_id'),
      keySecret: decryptSecret(dek, row.key_secret_enc, tenantId, 'morning.key_secret'),
      webhookSecret: decryptSecret(dek, row.webhook_secret_enc, tenantId, 'morning.webhook_secret'),
      environment: row.environment,
      pluginId: row.plugin_id,
      documentType: row.document_type,
      status: row.status,
    };
  });
}

/**
 * Just the webhook secret. A second function that returns a live secret, which
 * is a change to the property the comment above describes, so here is the
 * reason: every booking needs this one to build a notifyUrl, and every payment
 * callback needs it to verify. Handing those paths the Morning API key and
 * secret as well would mean the two most-travelled code paths in the system
 * routinely hold the credentials that can issue invoices and take refunds.
 *
 * Narrowing what a frequent caller receives is the opposite of widening the
 * surface. revealMorningCredentials stays the only way to the API keys.
 */
export async function revealWebhookSecret(tenantId) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT c.webhook_secret_enc, t.dek_wrapped
         FROM tenant_connections c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.provider = 'morning'`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    return decryptSecret(unwrapDek(row.dek_wrapped), row.webhook_secret_enc,
      tenantId, 'morning.webhook_secret');
  });
}

/** Connection state without any secret in it. Safe for the settings screen. */
export async function getMorningConnectionStatus(tenantId) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT environment, obtained_via, status, last_error, verified_at,
              business_name, document_type, (plugin_id IS NOT NULL) AS has_clearing
         FROM tenant_connections WHERE tenant_id = $1 AND provider = 'morning'`,
      [tenantId],
    );
    return rows[0] ?? null;
  });
}

export async function markMorningVerified(tenantId, { pluginId, businessName }) {
  return platform(async (client) => {
    await client.query(
      `UPDATE tenant_connections
          SET status = 'verified', plugin_id = $2, business_name = $3,
              verified_at = now(), last_error = NULL
        WHERE tenant_id = $1 AND provider = 'morning'`,
      [tenantId, pluginId, businessName ?? null],
    );
  });
}

export async function markMorningFailed(tenantId, message) {
  return platform(async (client) => {
    await client.query(
      `UPDATE tenant_connections SET status = 'failed', last_error = $2
        WHERE tenant_id = $1 AND provider = 'morning'`,
      // Truncated: these end up on a screen, and a Morning error can carry a
      // whole response body.
      [tenantId, String(message ?? '').slice(0, 500)],
    );
  });
}
