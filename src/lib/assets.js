import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Content-hashed asset URLs.
 *
 * A page and the script it loads are fetched separately, so a long max-age on
 * a fixed URL lets a browser pair fresh HTML with a cached older script, which
 * fails exactly when it matters, right after a deploy. Hashing the URL means a
 * changed file is a different URL, so that pairing cannot happen and the file
 * can still be cached hard.
 *
 * Hashes are computed once per process: these files only change on deploy.
 */
const versions = new Map();

export function assetUrl(publicPath, filePath) {
  if (!versions.has(filePath)) {
    let version;
    try {
      version = createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 10);
    } catch {
      // A missing file is the static handler's problem to report, not ours.
      version = 'dev';
    }
    versions.set(filePath, version);
  }
  return `${publicPath}?v=${versions.get(filePath)}`;
}

export const _internals = { versions };
