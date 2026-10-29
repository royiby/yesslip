import { withTenant } from '../db/index.js';
import { log } from '../lib/logger.js';
import { campProblems, decorateCamp, termsVersionOf } from './camp.js';

/**
 * Program configs, one row per tenant per kind.
 *
 * What this replaces is worth naming, because it is most of why the original
 * could not have a second customer. Settings lived in a JSON file on a hosted
 * disk, written atomically, backed up before each change, with an undo that
 * restored the previous file. All of that machinery existed to give one file
 * the properties a database row has for free: isolation between writers,
 * a history that is a table rather than a directory of timestamped copies, and
 * a write that either happened or did not.
 *
 * The history is kept for the same reason the original kept backups: a bad
 * edit to a live booking page has to be undoable in one click by someone who
 * is not a developer and is, at that moment, panicking.
 */

export class ProgramConfigError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'ProgramConfigError';
    this.code = 'PROGRAM_CONFIG';
    this.problems = problems;
  }
}

const KINDS = new Set(['camp', 'tzaharon']);
const VALIDATORS = { camp: campProblems };
const DECORATORS = { camp: decorateCamp };

function assertKind(kind) {
  if (!KINDS.has(kind)) throw new Error(`סוג תוכנית לא מוכר: ${kind}`);
  return kind;
}

/**
 * The live config, decorated. Null when the tenant has not set one up, which is
 * an ordinary state for a business that signed up this morning: the caller
 * shows an empty settings screen, and the booking page answers 404.
 */
export async function getProgramConfig(tenantId, kind = 'camp') {
  assertKind(kind);
  const row = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT config, terms_version, updated_at FROM program_configs
        WHERE kind = $1`,
      [kind],
    );
    return rows[0] ?? null;
  });
  if (!row) return null;
  const decorate = DECORATORS[kind] ?? ((c) => c);
  return { ...decorate(row.config), updatedAt: row.updated_at };
}

/** The undecorated config, for a settings screen that is about to patch it. */
export async function getRawProgramConfig(tenantId, kind = 'camp') {
  assertKind(kind);
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT config FROM program_configs WHERE kind = $1`, [kind],
    );
    return rows[0]?.config ?? null;
  });
}

/**
 * Validate, archive what is there now, then replace it. All three in one
 * transaction, so a history row without the change it preceded, or a change
 * with no way back, are both impossible rather than unlikely.
 *
 * Validation runs before the transaction opens because its answer does not
 * depend on anything in the database, and because holding a transaction open
 * across work that can reject is a habit worth not having.
 */
export async function saveProgramConfig(tenantId, config, { kind = 'camp', userId = null } = {}) {
  assertKind(kind);
  const problems = (VALIDATORS[kind] ?? (() => []))(config);
  if (problems.length > 0) throw new ProgramConfigError(problems);

  const termsVersion = kind === 'camp' ? termsVersionOf(config) : null;

  const result = await withTenant(tenantId, async (client) => {
    const { rows: before } = await client.query(
      `SELECT config, terms_version FROM program_configs WHERE kind = $1`, [kind],
    );
    if (before[0]) {
      await client.query(
        `INSERT INTO program_config_history (tenant_id, kind, config, created_by)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, kind, before[0].config, userId],
      );
    }
    await client.query(
      `INSERT INTO program_configs (tenant_id, kind, config, terms_version, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, kind) DO UPDATE
         SET config = EXCLUDED.config,
             terms_version = EXCLUDED.terms_version,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [tenantId, kind, config, termsVersion, userId],
    );
    return {
      termsVersion,
      previousTermsVersion: before[0]?.terms_version ?? null,
      created: !before[0],
    };
  });

  // Whether the consent wording changed is the one thing the settings screen
  // has to say out loud: it means every signature from here on records a
  // different version from the ones already taken.
  const termsChanged = Boolean(result.previousTermsVersion)
    && result.previousTermsVersion !== result.termsVersion;

  log.info('program_config.saved', {
    tenantId, kind, termsVersion: result.termsVersion, termsChanged, created: result.created,
  });
  return { ...result, termsChanged };
}

/** Most recent first. The screen offers the newest as "undo". */
export async function listProgramConfigHistory(tenantId, { kind = 'camp', limit = 20 } = {}) {
  assertKind(kind);
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, config, created_at, created_by FROM program_config_history
        WHERE kind = $1 ORDER BY id DESC LIMIT $2`,
      [kind, limit],
    );
    return rows;
  });
}

/**
 * Put back the most recent archived config and consume that archive row, so
 * tapping undo repeatedly walks back through the saves rather than toggling
 * between the last two. That is the original file-based behaviour, and it is
 * the one worth keeping: someone pressing undo twice means "further back", not
 * "never mind".
 *
 * Still validated, because a config that was legal when it was written may
 * collide with a rule added since, and silently restoring it would put an
 * invalid page live. Deliberately not routed through saveProgramConfig, which
 * would archive the config being discarded and turn the walk into a toggle.
 */
export async function undoProgramConfig(tenantId, { kind = 'camp', userId = null } = {}) {
  assertKind(kind);
  const archived = await listProgramConfigHistory(tenantId, { kind, limit: 1 });
  const previous = archived[0];
  if (!previous) return { ok: false, problem: 'אין מה לבטל: לא נשמר שינוי מאז ההתקנה.' };

  const problems = (VALIDATORS[kind] ?? (() => []))(previous.config);
  if (problems.length > 0) throw new ProgramConfigError(problems);

  const termsVersion = kind === 'camp' ? termsVersionOf(previous.config) : null;

  const result = await withTenant(tenantId, async (client) => {
    const { rows: before } = await client.query(
      `SELECT terms_version FROM program_configs WHERE kind = $1`, [kind],
    );
    await client.query(
      `INSERT INTO program_configs (tenant_id, kind, config, terms_version, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, kind) DO UPDATE
         SET config = EXCLUDED.config,
             terms_version = EXCLUDED.terms_version,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [tenantId, kind, previous.config, termsVersion, userId],
    );
    await client.query('DELETE FROM program_config_history WHERE id = $1', [previous.id]);
    const { rows: left } = await client.query(
      `SELECT count(*)::int AS n FROM program_config_history WHERE kind = $1`, [kind],
    );
    return {
      previousTermsVersion: before[0]?.terms_version ?? null,
      canUndo: left[0].n > 0,
    };
  });

  log.info('program_config.undone', { tenantId, kind, termsVersion });
  return {
    ok: true,
    undone: true,
    termsVersion,
    previousTermsVersion: result.previousTermsVersion,
    termsChanged: Boolean(result.previousTermsVersion)
      && result.previousTermsVersion !== termsVersion,
    canUndo: result.canUndo,
    restoredFrom: previous.created_at,
  };
}
