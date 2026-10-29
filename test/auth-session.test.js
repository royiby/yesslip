import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  seal, open, issueSession, clearSession, readSession, readCookie,
  issueOauthState, readOauthState, newOauthChallenge, COOKIES,
} from '../src/auth/session.js';

const KEY = crypto.randomBytes(32);
const asRequest = (cookie) => ({ headers: { cookie } });
/** The cookie value out of a Set-Cookie string. */
const valueOf = (setCookie) => setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';'));

test('a sealed payload round-trips', () => {
  const claims = { uid: 'u-1', exp: Date.now() + 60_000 };
  assert.deepEqual(open(seal(claims, KEY), KEY), claims);
});

test('a tampered payload is refused', () => {
  const token = seal({ uid: 'u-1', exp: Date.now() + 60_000 }, KEY);
  const [value, signature] = token.split('.');

  // Re-encode a different uid, keeping the original signature. This is the
  // attack the signature exists for: self-promotion by editing the cookie.
  const forged = Buffer.from(JSON.stringify({ uid: 'u-2', exp: Date.now() + 60_000 }), 'utf8')
    .toString('base64url');
  assert.equal(open(`${forged}.${signature}`, KEY), null);

  // And flipping a bit in the signature.
  assert.equal(open(`${value}.${signature.slice(0, -1)}x`, KEY), null);
});

test('another key cannot open it', () => {
  const token = seal({ uid: 'u-1', exp: Date.now() + 60_000 }, KEY);
  assert.equal(open(token, crypto.randomBytes(32)), null);
});

test('an expired payload is refused even with a valid signature', () => {
  // The expiry is inside the signed payload rather than left to the cookie's
  // Max-Age, which the client controls and can simply ignore.
  const token = seal({ uid: 'u-1', exp: Date.now() - 1 }, KEY);
  assert.equal(open(token, KEY), null);
});

test('a payload with no expiry is refused', () => {
  assert.equal(open(seal({ uid: 'u-1' }, KEY), KEY), null);
});

test('malformed tokens are refused rather than throwing', () => {
  for (const bad of ['', '.', 'nodot', 'a.b.c.d', '!!!.???', null, undefined]) {
    assert.equal(open(bad, KEY), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('a session cookie is HttpOnly, scoped to the site, and SameSite Lax', () => {
  const header = issueSession('user-1');
  assert.match(header, /^yesslip_session=/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Path=\/;/);
  // Lax, not Strict: the cookie has to survive the top-level redirect back
  // from Google, which Strict would drop.
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=2592000/);
});

test('a session cookie is only marked Secure on https', (t) => {
  const original = process.env.PUBLIC_BASE_URL;
  t.after(() => { process.env.PUBLIC_BASE_URL = original; });

  process.env.PUBLIC_BASE_URL = 'http://localhost:3000';
  assert.ok(!issueSession('u').includes('Secure'), 'local http must not set Secure, or dev cannot log in');

  process.env.PUBLIC_BASE_URL = 'https://app.yesslip.co.il';
  assert.match(issueSession('u'), /Secure/);
});

test('a session is read back, and clearing it expires the cookie', () => {
  const header = issueSession('user-42');
  const claims = readSession(asRequest(`${COOKIES.session}=${valueOf(header)}`));
  assert.equal(claims.uid, 'user-42');
  assert.equal(typeof claims.iat, 'number');

  assert.match(clearSession(), /Max-Age=0/);
});

test('no cookie, or someone else cookie, reads as no session', () => {
  assert.equal(readSession(asRequest('')), null);
  assert.equal(readSession({ headers: {} }), null);
  assert.equal(readSession(asRequest('other=1; unrelated=2')), null);
  assert.equal(readSession(asRequest(`${COOKIES.session}=garbage`)), null);
});

test('a cookie is parsed out of a crowded header', () => {
  // Values containing '=' (base64url padding, other apps' tokens) must not be
  // truncated at the first one.
  const header = 'a=1; yesslip_session=aaa.bbb==; _ga=GA1.2.3';
  assert.equal(readCookie(header, 'yesslip_session'), 'aaa.bbb==');
  assert.equal(readCookie(header, 'missing'), null);
  // Not a prefix match: a different cookie ending in the same name.
  assert.equal(readCookie('xyesslip_session=nope', 'yesslip_session'), null);
});

test('an OAuth challenge is unguessable and carries a correct S256 verifier', () => {
  const a = newOauthChallenge();
  const b = newOauthChallenge();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.verifier, b.verifier);
  assert.ok(a.state.length >= 20 && a.nonce.length >= 20 && a.verifier.length >= 40);

  const expected = crypto.createHash('sha256').update(a.verifier).digest('base64url');
  assert.equal(a.challenge, expected);
});

test('the OAuth state cookie is short-lived and scoped to /auth', () => {
  const challenge = newOauthChallenge('/app/settings');
  const header = issueOauthState(challenge);

  assert.match(header, /Path=\/auth;/);
  assert.match(header, /Max-Age=600/);
  assert.match(header, /HttpOnly/);

  const parked = readOauthState(asRequest(`${COOKIES.oauth}=${valueOf(header)}`));
  assert.equal(parked.state, challenge.state);
  assert.equal(parked.nonce, challenge.nonce);
  assert.equal(parked.verifier, challenge.verifier);
  assert.equal(parked.returnTo, '/app/settings');
});
