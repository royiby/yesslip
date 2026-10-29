import { log } from './logger.js';

/**
 * Booking and signing each cost a Morning API call and a database write, so one
 * IP cannot be allowed to hammer them.
 *
 * The counter is keyed by tenant and IP together, not by IP alone. One process
 * now serves every business, and a shared key would let traffic to one tenant's
 * booking page lock parents out of another's, which is the single-tenant
 * original's limiter turned into a cross-tenant denial of service.
 *
 * Still in memory, and still fine: one process, and a restart clearing the
 * counters is harmless. It becomes wrong the day this runs on two machines,
 * which is the day it moves to the database.
 */
export function rateLimiter({
  windowMs,
  max,
  event = 'rate_limited',
  message = 'יותר מדי נסיונות. נסו שוב בעוד דקה.',
  respond = (_req, res, text) => res.status(429).json({ error: text }),
}) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }, windowMs).unref();

  return function limit(req, res, next) {
    const key = `${req.tenant?.id ?? 'none'}|${req.ip ?? 'unknown'}`;
    const now = Date.now();
    const times = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (times.length >= max) {
      log.warn(event, { tenantId: req.tenant?.id ?? null, ip: req.ip ?? null });
      return respond(req, res, message);
    }
    times.push(now);
    hits.set(key, times);
    return next();
  };
}

export const _internals = { };
