import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

/**
 * Migrations run as the OWNER (DATABASE_ADMIN_URL), not as the app role, since
 * they create tables, policies and the app role itself. The app never holds
 * these credentials.
 *
 * One file, one transaction. A migration that fails leaves nothing behind and
 * is not recorded, so the fix is to edit the file and run again.
 */

const DIR = new URL('../../migrations/', import.meta.url);

// Any number taken from thin air, as long as it is the same one everywhere:
// two deploys starting at once must not both run 001.
const LOCK_ID = 8712_4411;

export async function migrate({ url = process.env.DATABASE_ADMIN_URL, log = console.log } = {}) {
  if (!url) throw new Error('DATABASE_ADMIN_URL is not set. Copy .env.example to .env.');

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    let applied = 0;

    for (const name of files) {
      if (done.has(name)) continue;
      const sql = await readFile(new URL(name, DIR), 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        // Name the file. A bare syntax error with no filename is the worst
        // possible message when there are twenty migrations.
        throw new Error(`migration ${name} failed: ${error.message}`, { cause: error });
      }

      log(`applied ${name}`);
      applied += 1;
    }

    if (applied === 0) log('nothing to apply');
    return applied;
  } finally {
    // Releasing the lock is implicit on disconnect, but being explicit means a
    // long-lived caller does not hold it.
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

// Run directly: node src/db/migrate.js
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
