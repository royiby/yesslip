import 'dotenv/config';
import express from 'express';
import { makeAuthRouter } from './auth/routes.js';
import { getPool, closePool } from './db/index.js';
import { log } from './lib/logger.js';

/**
 * The server. Only auth is wired so far; the booking, operator and contract
 * surfaces are still to be ported, each behind requireTenant.
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

  app.get('/health', async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      res.json({ ok: true, db: 'up' });
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
  const server = makeApp().listen(port, () => log.info('server.listening', { port }));

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      log.info('server.stopping', { signal });
      server.close(() => closePool().then(() => process.exit(0)));
    });
  }
}
