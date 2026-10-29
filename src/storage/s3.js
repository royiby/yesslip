import { createHash, createHmac } from 'node:crypto';

/**
 * The smallest S3 client that does the job: five verbs, signed with SigV4 over
 * `fetch`. Deliberately not the AWS SDK, which is tens of megabytes of
 * dependency for PUT, GET, HEAD, DELETE and LIST, and this file is small
 * enough to read in one sitting.
 *
 * Path-style addressing only (`<endpoint>/<bucket>/<key>`), which is what
 * Cloudflare R2, Backblaze B2 and MinIO all speak, and which AWS still serves.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const DEFAULT_TIMEOUT_MS = 15_000;

/** RFC 3986, which is stricter than encodeURIComponent about these four. */
function uriEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A key is encoded segment by segment, because `/` stays a separator in a path. */
function encodeKeyPath(key) {
  return String(key).split('/').map(uriEncode).join('/');
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/** "2026-10-29T09:15:00.000Z" to { amzDate: "20261029T091500Z", stamp: "20261029" } */
function timestamps(now = new Date()) {
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate, stamp: amzDate.slice(0, 8) };
}

function signingKey({ secretAccessKey, stamp, region }) {
  const date = hmac(`AWS4${secretAccessKey}`, stamp);
  const regionKey = hmac(date, region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, 'aws4_request');
}

/**
 * Builds the Authorization header for one request. Split out from `send` so a
 * test can assert the signature without a server, and so the signing rules
 * stay readable next to the AWS documentation they come from.
 */
export function signRequest({
  method, url, headers, payloadHash, accessKeyId, secretAccessKey, region, now,
}) {
  const { amzDate, stamp } = timestamps(now);
  const target = new URL(url);

  const signed = {
    ...headers,
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  // Header names lowercased and sorted; values trimmed. Both sides of the
  // signature have to agree character for character.
  const names = Object.keys(signed).map((n) => n.toLowerCase()).sort();
  const lower = Object.fromEntries(
    Object.entries(signed).map(([n, v]) => [n.toLowerCase(), String(v).trim()]),
  );
  const canonicalHeaders = `${names.map((n) => `${n}:${lower[n]}`).join('\n')}\n`;
  const signedHeaders = names.join(';');

  const query = [...target.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    method, target.pathname, query, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${stamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey({ secretAccessKey, stamp, region }))
    .update(stringToSign)
    .digest('hex');

  return {
    headers: {
      ...signed,
      authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
  };
}

export class S3Error extends Error {
  constructor(status, body, { method, key }) {
    super(`S3 ${method} ${key || '/'} to ${status}${body ? `: ${String(body).slice(0, 200)}` : ''}`);
    this.name = 'S3Error';
    this.status = status;
  }
}

/** One bucket, one credential. Built fresh per operation by the caller, so a
 *  rotated credential takes effect without a restart. */
export function makeS3Client(settings) {
  const {
    endpoint, bucket, region = 'auto', accessKeyId, secretAccessKey,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
  } = settings;
  const base = String(endpoint).replace(/\/+$/, '');

  function urlFor(key, query = {}) {
    const url = new URL(`${base}/${uriEncode(bucket)}${key ? `/${encodeKeyPath(key)}` : ''}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    }
    return url;
  }

  async function send({ method, key, query, body, headers = {} }) {
    const url = urlFor(key, query);
    const payload = body === undefined ? Buffer.alloc(0)
      : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const signed = signRequest({
      method, url, headers,
      payloadHash: sha256Hex(payload),
      accessKeyId, secretAccessKey, region,
    });

    const response = await fetchImpl(url, {
      method,
      headers: signed.headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : payload,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = method === 'HEAD' ? '' : await response.text().catch(() => '');
      throw new S3Error(response.status, text, { method, key });
    }
    return response;
  }

  return {
    bucket,

    /**
     * `ifNoneMatch: true` sends `If-None-Match: *`, which makes the write
     * conditional on the key not already existing. S3 and R2 both answer 412
     * when it does. See src/storage/objects.js for why that matters and for
     * what happens on a provider that ignores the header.
     */
    async putObject(key, body, { contentType = 'application/octet-stream', metadata = {}, ifNoneMatch = false } = {}) {
      const headers = { 'content-type': contentType };
      if (ifNoneMatch) headers['if-none-match'] = '*';
      // x-amz-meta-* headers are part of the signature, so they travel with it
      // rather than being bolted on afterwards.
      for (const [name, value] of Object.entries(metadata)) {
        headers[`x-amz-meta-${name.toLowerCase()}`] = String(value);
      }
      await send({ method: 'PUT', key, body, headers });
      return { key };
    },

    async getObject(key) {
      const response = await send({ method: 'GET', key });
      return {
        key,
        body: Buffer.from(await response.arrayBuffer()),
        metadata: metadataFrom(response.headers),
      };
    },

    /** Treats a key that is already gone as success, which is also how S3
     *  answers, so a half-finished purge can be run again. */
    async deleteObject(key) {
      try {
        await send({ method: 'DELETE', key });
        return { key, deleted: true };
      } catch (error) {
        if (error instanceof S3Error && error.status === 404) return { key, deleted: false };
        throw error;
      }
    },

    /** null rather than a throw for "not there", which is the usual question. */
    async headObject(key) {
      try {
        const response = await send({ method: 'HEAD', key });
        return {
          key,
          size: Number(response.headers.get('content-length') ?? 0),
          metadata: metadataFrom(response.headers),
        };
      } catch (error) {
        if (error instanceof S3Error && (error.status === 404 || error.status === 403)) return null;
        throw error;
      }
    },

    /** Every key under a prefix, following continuation tokens to the end. */
    async listObjects(prefix = '') {
      const out = [];
      let token;
      do {
        const response = await send({
          method: 'GET',
          key: '',
          query: { 'list-type': 2, prefix, 'max-keys': 1000, 'continuation-token': token },
        });
        const xml = await response.text();
        out.push(...parseListing(xml));
        token = tagValue(xml, 'NextContinuationToken');
        if (tagValue(xml, 'IsTruncated') !== 'true') token = undefined;
      } while (token);
      return out;
    },
  };
}

function metadataFrom(headers) {
  const meta = {};
  for (const [name, value] of headers.entries()) {
    if (name.startsWith('x-amz-meta-')) meta[name.slice('x-amz-meta-'.length)] = value;
  }
  return meta;
}

function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? unescapeXml(match[1]) : undefined;
}

/**
 * ListObjectsV2 is the only response shape this client has to read, and S3's
 * XML for it is flat and machine-generated, with no namespaces on these
 * elements and no CDATA, so matching the three tags is honest here and keeps
 * an XML parser out of the dependency list.
 */
export function parseListing(xml) {
  return [...String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, block]) => ({
    key: tagValue(block, 'Key') ?? '',
    size: Number(tagValue(block, 'Size') ?? 0),
    lastModified: tagValue(block, 'LastModified') ?? '',
    etag: (tagValue(block, 'ETag') ?? '').replace(/"/g, ''),
  }));
}

export const _internals = { uriEncode, encodeKeyPath, sha256Hex, timestamps };
