import 'dotenv/config';
import pg from 'pg';

/**
 * Every query against a tenant table goes through withTenant(). There is no
 * exported `query()` that runs without a tenant, because the one bug this
 * whole design exists to prevent is a query that forgets which business it is
 * for.
 *
 * The tenant is carried in the `app.tenant_id` session setting, read by the
 * app_current_tenant() SQL function that every row-level security policy
 * compares against. Three details matter:
 *
 *   1. set_config(..., true) is transaction-LOCAL. The pool hands the same
 *      connection to the next caller, so a setting that outlived its
 *      transaction would be the exact cross-tenant leak we are guarding
 *      against. `SET LOCAL` cannot take a bind parameter; set_config can, so
 *      it is also the form that is not string-concatenated.
 *   2. The app connects as yesslip_app, which does not own the tables. An
 *      owner bypasses RLS unless it is FORCEd, and we both force it and avoid
 *      being the owner.
 *   3. When the setting is unset, app_current_tenant() is NULL and every
 *      policy denies. Forgetting the tenant yields an empty result, never
 *      somebody else's rows.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pool = null;

export function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');

  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // An idle client erroring out (a server restart, a dropped connection) emits
  // on the pool. Without a listener this is an unhandled 'error' event, which
  // takes the process down.
  pool.on('error', (error) => {
    console.error(JSON.stringify({ level: 'error', event: 'db.idle_client_error', message: error.message }));
  });

  return pool;
}

/**
 * Run `fn` inside a transaction scoped to one tenant.
 *
 * Returns whatever `fn` returns, and commits. Any throw rolls back and
 * re-throws, so a half-written registration cannot survive a failure.
 */
export async function withTenant(tenantId, fn) {
  if (!UUID.test(String(tenantId ?? ''))) {
    // Checked here rather than left to the ::uuid cast inside the policy,
    // where it would surface as an unrelated-looking error on the first query.
    throw new Error(`withTenant: not a tenant id: ${JSON.stringify(tenantId)}`);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', String(tenantId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Platform tables only: tenants, users, memberships, tenant_connections. These
 * are how the app works out which tenant it is serving, so they cannot
 * themselves be behind the tenant setting.
 *
 * Named so that it reads as a deliberate choice at the call site. If this shows
 * up around a query touching registrations, that is the bug.
 */
export async function platform(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Same, in a transaction, for multi-statement platform writes. */
export async function platformTx(fn) {
  return platform(async (client) => {
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}
