import { createMorningClient } from './client.js';
import {
  revealMorningCredentials, markMorningVerified, markMorningFailed,
} from '../tenants/store.js';
import { log } from '../lib/logger.js';

/**
 * Resolve a tenant's Morning client.
 *
 * Clients are cached per tenant so that an access token survives between
 * requests; without that, every parent hitting the booking page costs a token
 * exchange. Two things about this cache:
 *
 *   - It is keyed by tenant id and holds one client per tenant, so it does not
 *     reintroduce the shared-token bug. The thing that was dangerous before was
 *     one token serving every tenant, not the existence of a cache.
 *   - It holds decrypted credentials in memory. That is unavoidable for any
 *     API client, and it is why the TTL exists and why invalidate() is called
 *     whenever a tenant reconnects Morning.
 */

const TTL_MS = 10 * 60 * 1000;

const clients = new Map(); // tenantId -> { client, expiresAtMs }

export function invalidate(tenantId) {
  clients.delete(String(tenantId));
}

export function invalidateAll() {
  clients.clear();
}

/**
 * Returns null when the tenant has not connected Morning yet, rather than
 * throwing: a half-onboarded tenant is an ordinary state, and the caller shows
 * "connect Morning to continue" instead of a stack trace.
 */
export async function morningFor(tenantId) {
  const key = String(tenantId);
  const hit = clients.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return hit.client;

  const credentials = await revealMorningCredentials(tenantId);
  if (!credentials) return null;

  const client = createMorningClient({
    tenantId: key,
    keyId: credentials.keyId,
    keySecret: credentials.keySecret,
    environment: credentials.environment,
    pluginId: credentials.pluginId,
    documentType: credentials.documentType,
    log: (event, fields) => log.debug(event, fields),
  });

  clients.set(key, { client, expiresAtMs: Date.now() + TTL_MS });
  return client;
}

/**
 * The onboarding step. Verifies the credentials against Morning, records the
 * discovered clearing id, and returns something the wizard can render.
 *
 * Always writes the outcome to the connection row, success or failure, so the
 * settings screen can say what is wrong without the tenant having to retry to
 * find out.
 */
export async function verifyAndStore(tenantId) {
  invalidate(tenantId);

  const credentials = await revealMorningCredentials(tenantId);
  if (!credentials) return { ok: false, problem: 'לא חוברה חשבון מורנינג' };

  const client = createMorningClient({
    tenantId: String(tenantId),
    keyId: credentials.keyId,
    keySecret: credentials.keySecret,
    environment: credentials.environment,
    documentType: credentials.documentType,
    log: (event, fields) => log.debug(event, fields),
  });

  let result;
  try {
    result = await client.verifyConnection();
  } catch (error) {
    await markMorningFailed(tenantId, error.message);
    return { ok: false, problem: error.message };
  }

  if (!result.ok) {
    await markMorningFailed(tenantId, result.problem);
    return result;
  }

  await markMorningVerified(tenantId, {
    pluginId: result.pluginId,
    businessName: result.business?.name ?? result.business?.companyName ?? null,
  });
  // The cached client was built without a pluginId; drop it so the next call
  // picks up the one we just discovered.
  invalidate(tenantId);
  return result;
}
