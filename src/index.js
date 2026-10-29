import 'dotenv/config';
import express from 'express';
import { makeAuthRouter } from './auth/routes.js';
import { makeBookingRouter, makeWebhookRouter } from './booking/routes.js';
import { getPool, closePool } from './db/index.js';
import { objectStore } from './storage/objects.js';
import { log } from './lib/logger.js';

/**
 * The server.
 *
 * Two kinds of surface, and the difference is the whole security model:
 *
 *   /auth and (later) /app are signed in. A session says who, memberships say
 *   which businesses, and every tenant table is reached through withTenant.
 *
 *   /b/:slug and /webhooks are public and have no session at all. A parent has
 *   a link, not an account. The tenant comes from the path, and nothing but the
 *   path and a per-tenant webhook secret decides which business a request acts
 *   on, which is why those two are the places to look hardest.
 */

export function makeApp() {
  const app = express();

  // Behind Cloudflare and a platform proxy, so the client IP arrives in a
  // header. Consents record an IP as part of the evidence chain, and recording
  // the load balancer's would make every signature look like it came from us.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use('/auth', makeAuthRouter());

  // Public, no session. See the note above.
  app.use('/b', makeBookingRouter());
  app.use('/webhooks', makeWebhookRouter());

  app.get('/health', async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      // The document store is reported rather than probed. A HEAD on every
      // health check costs a request per minute per instance for an answer
      // that only changes on deploy; what actually matters here is whether a
      // bucket is configured at all, because "memory" means signed consents
      // are being kept somewhere they will not survive a restart.
      res.json({ ok: true, db: 'up', documents: objectStore().kind });
    } catch (error) {
      // 503, so a platform health check actually fails rather than reporting a
      // cheerful 200 with bad news in the body.
      res.status(503).json({ ok: false, db: 'down', error: error.message });
    }
  });

  // Last: an error handler that logs the detail and says nothing revealing.
  app.use((error, _req, res, _next) => {
    log.error('request.failed', { message: error.message, stack: error.stack });
    res.status(500).json({ error: 'משהו נשבר אצלנו. נסו שוב.' });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  // Called at boot, not on the first signature, so an unconfigured bucket is
  // one warning in the deploy log rather than a line per parent.
  objectStore();
  const server = makeApp().listen(port, () => log.info('server.listening', { port }));

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log.info('server.stopping', { signal });
      server.close(() => closePool().then(() => process.exit(0)));
    });
  }
}
