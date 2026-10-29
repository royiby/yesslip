import { makeS3Client, S3Error } from './s3.js';
import { log } from '../lib/logger.js';

/**
 * Where signed documents live.
 *
 * The single-tenant original wrote them to a directory on a hosted disk. That
 * is the one piece of state that made the process unreplaceable: no second
 * instance, no redeploy without a mounted volume, no moving host, and a legal
 * evidence chain that existed in exactly one place. Object storage removes all
 * of that at once, which is why it comes before any more surface lands here.
 *
 * ───────────────────────── write-once, and how far ─────────────────────────
 *
 * The original's immutability was `writeFile(..., { flag: 'wx' })`: the open
 * fails if the path exists, and that single flag is what stopped a document
 * being signed twice. The equivalent here is a conditional PUT, `If-None-Match:
 * *`, which S3 and R2 both answer with 412 when the key is taken.
 *
 * It is sent, and `alreadyExists` is what a caller checks. But be precise about
 * what is guaranteed: a provider that silently ignores the header would permit
 * an overwrite, and this code cannot tell the difference from a successful
 * conditional write. So the HEAD before the PUT stays, not as the mechanism but
 * as the part that works everywhere. The conditional PUT closes the race
 * between two simultaneous signings; the HEAD closes the ordinary case. Against
 * a provider that honours neither, a double signing would be caught by the
 * database instead: `consents` has UNIQUE (tenant_id, order_id).
 *
 * Three independent barriers, named here because "it is immutable" on its own
 * would be a claim this file cannot keep.
 */

export class ObjectStoreUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'ObjectStoreUnavailable';
    this.code = 'OBJECT_STORE';
  }
}

/** Only these characters, so a key cannot climb out of its tenant's prefix. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Every key carries the tenant id. One bucket serves every business, so the
 * prefix is the difference between "this tenant's document" and "a document".
 * It is belt and braces: the key is only ever read back out of a row that
 * row-level security already scoped to one tenant, so a bug would have to
 * defeat both to cross the boundary.
 */
export function documentKey(tenantId, kind, id) {
  for (const part of [tenantId, kind, id]) {
    if (!SAFE_SEGMENT.test(String(part ?? ''))) {
      throw new Error(`מזהה לא תקין למפתח אובייקט: ${part}`);
    }
  }
  return `t/${tenantId}/${kind}/${id}.html`;
}

function settingsFromEnv(env = process.env) {
  const endpoint = env.OBJECT_STORE_ENDPOINT;
  const bucket = env.OBJECT_STORE_BUCKET;
  const accessKeyId = env.OBJECT_STORE_ACCESS_KEY_ID;
  const secretAccessKey = env.OBJECT_STORE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint, bucket, accessKeyId, secretAccessKey,
    region: env.OBJECT_STORE_REGION || 'auto',
  };
}

/**
 * The S3-backed store. Built per call rather than held, so a rotated credential
 * takes effect on the next write instead of on the next restart.
 */
export function makeObjectStore(settings) {
  const client = makeS3Client(settings);

  return {
    kind: 's3',
    bucket: settings.bucket,

    /**
     * Returns `{ key, written: true }`, or `{ key, written: false,
     * alreadyExists: true }` when something is already stored under that key.
     * Never overwrites, and never reports a refusal as a success.
     */
    async putOnce(key, body, { contentType = 'text/html; charset=utf-8', metadata = {} } = {}) {
      const existing = await client.headObject(key);
      if (existing) return { key, written: false, alreadyExists: true };
      try {
        await client.putObject(key, body, { contentType, metadata, ifNoneMatch: true });
      } catch (error) {
        if (error instanceof S3Error && error.status === 412) {
          return { key, written: false, alreadyExists: true };
        }
        throw error;
      }
      return { key, written: true };
    },

    /** null for a key that was never written, which is the usual question. */
    async get(key) {
      try {
        const object = await client.getObject(key);
        return object.body;
      } catch (error) {
        if (error instanceof S3Error && error.status === 404) return null;
        throw error;
      }
    },

    async head(key) {
      return client.headObject(key);
    },

    async remove(key) {
      return client.deleteObject(key);
    },

    async list(prefix) {
      return client.listObjects(prefix);
    },
  };
}

/**
 * An in-memory store, for tests and for a developer who has not configured a
 * bucket. It enforces the same write-once rule, so a test of the signing path
 * is testing the real contract.
 *
 * Deliberately not a filesystem store. A directory on disk is the exact thing
 * this module exists to remove, and offering it as a convenience is how it
 * comes back. Documents signed against this store are gone on restart, which
 * is the honest consequence of not configuring a bucket and reads as one.
 */
export function makeMemoryObjectStore() {
  const objects = new Map();
  return {
    kind: 'memory',
    bucket: '(memory)',

    async putOnce(key, body, { contentType = 'text/html; charset=utf-8', metadata = {} } = {}) {
      if (objects.has(key)) return { key, written: false, alreadyExists: true };
      objects.set(key, { body: Buffer.from(body), contentType, metadata });
      return { key, written: true };
    },

    async get(key) {
      return objects.get(key)?.body ?? null;
    },

    async head(key) {
      const hit = objects.get(key);
      return hit ? { key, size: hit.body.length, metadata: hit.metadata } : null;
    },

    async remove(key) {
      return { key, deleted: objects.delete(key) };
    },

    async list(prefix = '') {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, size: value.body.length }));
    },

    _objects: objects,
  };
}

let shared = null;

/**
 * The process-wide store. One warning at startup if no bucket is configured,
 * rather than a line per signature: the second is noise, and the first is the
 * thing somebody has to act on.
 */
export function objectStore({ env = process.env } = {}) {
  if (shared) return shared;
  const settings = settingsFromEnv(env);
  if (settings) {
    shared = makeObjectStore(settings);
    log.info('objects.configured', { bucket: settings.bucket, endpoint: settings.endpoint });
  } else {
    shared = makeMemoryObjectStore();
    log.warn('objects.not_configured', {
      hint: 'אין אחסון אובייקטים: הטפסים החתומים יישמרו בזיכרון ויימחקו בהפעלה מחדש. '
        + 'הגדירו OBJECT_STORE_ENDPOINT / _BUCKET / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY.',
    });
  }
  return shared;
}

/** Tests swap the shared store; production never calls this. */
export function setObjectStore(store) {
  shared = store;
  return shared;
}

export function resetObjectStore() {
  shared = null;
}

export const _internals = { settingsFromEnv, SAFE_SEGMENT };
