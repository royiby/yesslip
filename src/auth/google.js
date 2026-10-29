import crypto from 'node:crypto';

/**
 * Google sign-in: OpenID Connect authorization code flow, with PKCE.
 *
 * The ID token's signature is verified against Google's JWKS even though the
 * token arrives straight from the token endpoint over TLS, where OpenID
 * Connect Core 3.1.3.7 permits a confidential client to skip it. Thirty lines
 * is a cheap price at the one boundary where getting it wrong means signing in
 * as somebody else, and it also catches the misconfiguration where the token
 * endpoint is not the one we think it is.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

// Google has issued tokens under both spellings for years; both are correct.
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// Clocks drift. Sixty seconds is the usual allowance and is small enough that
// it cannot be used to replay a long-expired token.
const CLOCK_SKEW_MS = 60_000;

export function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. See .env.example.');
  }
  return { clientId, clientSecret };
}

export function redirectUri(base = process.env.PUBLIC_BASE_URL) {
  if (!base) throw new Error('PUBLIC_BASE_URL is not set');
  // Must match the Authorised redirect URI in the Google console byte for
  // byte, trailing slash included, or Google answers redirect_uri_mismatch.
  return `${String(base).replace(/\/+$/, '')}/auth/google/callback`;
}

export function authorizationUrl({ state, nonce, challenge, clientId = googleConfig().clientId, uri = redirectUri() }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', uri);
  url.searchParams.set('response_type', 'code');
  // No profile scopes beyond identity: this app has no use for anything else,
  // and a narrower consent screen is a better one.
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Ask for an account every time rather than silently reusing the one Google
  // happens to be signed in to, which on a shared family computer is how a
  // parent ends up looking at the operator app.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export async function exchangeCode({
  code, verifier, uri = redirectUri(), fetchImpl = globalThis.fetch, config = googleConfig(),
}) {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: uri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text);
  if (!body.id_token) throw new Error('Google returned no id_token');
  return body;
}

// ──────────────────── ID token verification ────────────────────

let jwksCache = null; // { keys, expiresAtMs }

export function _resetJwksCache() {
  jwksCache = null;
}

async function jwks({ fetchImpl = globalThis.fetch, force = false } = {}) {
  if (!force && jwksCache && jwksCache.expiresAtMs > Date.now()) return jwksCache.keys;

  const response = await fetchImpl(JWKS_URI, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`could not fetch Google's signing keys (${response.status})`);
  const body = JSON.parse(await response.text());
  if (!Array.isArray(body?.keys) || body.keys.length === 0) {
    throw new Error("Google's signing keys came back empty");
  }

  // Honour the endpoint's own cache lifetime; Google rotates these, and
  // caching past the header is how a deploy starts rejecting every login.
  const header = response.headers?.get?.('cache-control') ?? '';
  const maxAge = Number(/max-age=(\d+)/.exec(header)?.[1] ?? 3600);
  jwksCache = { keys: body.keys, expiresAtMs: Date.now() + Math.max(60, maxAge) * 1000 };
  return jwksCache.keys;
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/**
 * Returns the verified claims, or throws with a reason. Every failure here is
 * a refusal to sign someone in, so each one says what was wrong rather than
 * returning a bare false.
 */
export async function verifyIdToken(idToken, {
  nonce, clientId = googleConfig().clientId, fetchImpl = globalThis.fetch, now = Date.now(),
} = {}) {
  const parts = String(idToken ?? '').split('.');
  if (parts.length !== 3) throw new Error('id_token is not a JWT');

  const [rawHeader, rawPayload, rawSignature] = parts;
  const header = decodeSegment(rawHeader);

  // Pinned, not read from the token. Accepting the token's own choice of
  // algorithm is the classic JWT failure, and `none` is the punchline.
  if (header.alg !== 'RS256') throw new Error(`unexpected id_token algorithm: ${header.alg}`);
  if (!header.kid) throw new Error('id_token has no key id');

  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8');
  const signature = Buffer.from(rawSignature, 'base64url');

  let keys = await jwks({ fetchImpl });
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Unknown kid means Google probably rotated. Refetch once before giving
    // up, so a rotation is a slow login rather than an outage.
    keys = await jwks({ fetchImpl, force: true });
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error(`no Google signing key matches kid ${header.kid}`);

  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify('RSA-SHA256', signed, key, signature)) {
    throw new Error('id_token signature does not verify');
  }

  const claims = decodeSegment(rawPayload);

  if (!ISSUERS.has(claims.iss)) throw new Error(`unexpected id_token issuer: ${claims.iss}`);
  // aud can be a string or an array per the spec; Google sends a string.
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw new Error('id_token was issued for another client');

  if (typeof claims.exp !== 'number' || claims.exp * 1000 + CLOCK_SKEW_MS <= now) {
    throw new Error('id_token has expired');
  }
  if (typeof claims.iat === 'number' && claims.iat * 1000 - CLOCK_SKEW_MS > now) {
    throw new Error('id_token was issued in the future');
  }

  // Binds this token to the login attempt that asked for it. Without it, a
  // token obtained elsewhere for the same client would be replayable here.
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error('id_token nonce does not match');

  if (!claims.sub) throw new Error('id_token has no subject');
  if (!claims.email) throw new Error('id_token has no email');
  // An unverified address is one anybody could have typed, and email is how an
  // invitation is matched to a person.
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new Error('this Google account has no verified email address');
  }

  return {
    sub: claims.sub,
    email: String(claims.email).toLowerCase(),
    name: claims.name ?? null,
    picture: claims.picture ?? null,
    raw: claims,
  };
}
