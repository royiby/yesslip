import crypto from 'node:crypto';

/**
 * Sessions are signed cookies, not rows.
 *
 * The cookie asserts identity (which user) and nothing about authorisation
 * (which businesses, which role). That is resolved from `memberships` on every
 * request, which is why removing someone from a business locks them out on
 * their next click with no session to expire. See migrations/004_auth.sql.
 *
 * `users.sessions_valid_from` covers the case a membership change does not: a
 * stolen device, where the user themselves wants every existing cookie dead.
 */

const SESSION_COOKIE = 'yesslip_session';
const OAUTH_COOKIE = 'yesslip_oauth';

function secret(name = 'SESSION_SECRET') {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set. Generate one with: npm run keygen`);
  const key = Buffer.from(raw, 'base64');
  if (key.length < 32) throw new Error(`${name} must be at least 32 bytes of base64`);
  return key;
}

function hmac(key, payload) {
  return crypto.createHmac('sha256', key).update(payload).digest('base64url');
}

function equal(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  // timingSafeEqual throws on a length mismatch, and the lengths here are not
  // secret (both are fixed-width digests), so comparing them first is fine.
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** value.signature, where value is base64url JSON. */
export function seal(claims, key = secret()) {
  const value = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${value}.${hmac(key, value)}`;
}

export function open(token, key = secret()) {
  const text = String(token ?? '');
  const dot = text.lastIndexOf('.');
  if (dot <= 0) return null;

  const value = text.slice(0, dot);
  const signature = text.slice(dot + 1);
  if (!equal(signature, hmac(key, value))) return null;

  try {
    const claims = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    // An expiry inside the signed payload rather than relying on the cookie's
    // Max-Age, which the client controls and can simply ignore.
    if (!claims || typeof claims.exp !== 'number' || claims.exp <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

function attributes({ path = '/', maxAgeSeconds, sameSite = 'Lax' }) {
  const secure = String(process.env.PUBLIC_BASE_URL ?? '').startsWith('https://') ? ' Secure;' : '';
  const age = maxAgeSeconds === 0 ? ' Max-Age=0;' : ` Max-Age=${Math.floor(maxAgeSeconds)};`;
  return `Path=${path};${age} HttpOnly;${secure} SameSite=${sameSite}`;
}

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

// ──────────────────── the login session ────────────────────

export function sessionDays() {
  const days = Number(process.env.SESSION_DAYS ?? 30);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

export function issueSession(userId, { days = sessionDays() } = {}) {
  const now = Date.now();
  const token = seal({ uid: String(userId), iat: now, exp: now + days * 86_400_000 });
  return `${SESSION_COOKIE}=${token}; ${attributes({ maxAgeSeconds: days * 86_400 })}`;
}

export function clearSession() {
  return `${SESSION_COOKIE}=; ${attributes({ maxAgeSeconds: 0 })}`;
}

/**
 * The claims in the cookie, or null. Says who, not what they may do, and does
 * not touch the database: `requireUser` in routes.js does the freshness check
 * against sessions_valid_from.
 */
export function readSession(req) {
  const raw = readCookie(req.headers?.cookie, SESSION_COOKIE);
  if (!raw) return null;
  const claims = open(raw);
  if (!claims?.uid) return null;
  return claims;
}

// ──────────────────── the OAuth round trip ────────────────────

/**
 * state, nonce, the PKCE verifier and where to go afterwards, parked in a
 * short-lived signed cookie rather than in a table.
 *
 * It has to be a cookie and not server state because the browser leaves for
 * Google and comes back, and SameSite=Lax is what lets it survive that
 * top-level redirect. Ten minutes, because a login that takes longer than that
 * should start again rather than leave a usable verifier lying around.
 */
export function issueOauthState({ state, nonce, verifier, returnTo }) {
  const token = seal({ state, nonce, verifier, returnTo, exp: Date.now() + 10 * 60_000 });
  return `${OAUTH_COOKIE}=${token}; ${attributes({ path: '/auth', maxAgeSeconds: 600 })}`;
}

export function clearOauthState() {
  return `${OAUTH_COOKIE}=; ${attributes({ path: '/auth', maxAgeSeconds: 0 })}`;
}

export function readOauthState(req) {
  const raw = readCookie(req.headers?.cookie, OAUTH_COOKIE);
  return raw ? open(raw) : null;
}

export function newOauthChallenge(returnTo = '/app') {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return {
    state: crypto.randomBytes(16).toString('base64url'),
    nonce: crypto.randomBytes(16).toString('base64url'),
    verifier,
    // PKCE S256. Belt and braces for a confidential client, but it costs three
    // lines and removes the authorization-code interception class entirely.
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    returnTo,
  };
}

export const COOKIES = { session: SESSION_COOKIE, oauth: OAUTH_COOKIE };
