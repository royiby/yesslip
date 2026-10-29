import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  authorizationUrl, exchangeCode, verifyIdToken, _resetJwksCache,
} from '../src/auth/google.js';

/**
 * The ID token is the whole authentication decision: whatever `sub` it carries
 * is who we sign in as. These tests sign real RS256 tokens with a locally
 * generated key and serve a matching JWKS, so the verification path is
 * exercised rather than stubbed.
 */

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function keypair(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk, kid };
}

const b64 = (object) => Buffer.from(JSON.stringify(object), 'utf8').toString('base64url');

function makeToken({ key, claims = {}, header = {}, tamper = false }) {
  const head = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-sub-123',
    email: 'Owner@Example.com',
    email_verified: true,
    name: 'בעלת העסק',
    iat: now,
    exp: now + 3600,
    ...claims,
  });

  if (header.alg === 'none') return `${head}.${body}.`;

  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(`${head}.${body}`, 'utf8'), key.privateKey)
    .toString('base64url');

  if (tamper) {
    // Same signature, different payload: the forgery the signature exists for.
    const forged = b64({
      iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'someone-else',
      email: 'attacker@example.com', email_verified: true, iat: now, exp: now + 3600,
    });
    return `${head}.${forged}.${signature}`;
  }
  return `${head}.${body}.${signature}`;
}

/** A JWKS endpoint stub that counts fetches, so key rotation is observable. */
function jwksServer(jwksList) {
  let fetches = 0;
  const impl = async () => {
    fetches += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'cache-control' ? 'public, max-age=3600' : null) },
      text: async () => JSON.stringify({ keys: jwksList() }),
    };
  };
  impl.fetches = () => fetches;
  return impl;
}

const verify = (token, fetchImpl, extra = {}) =>
  verifyIdToken(token, { clientId: CLIENT_ID, fetchImpl, ...extra });

test.beforeEach(() => _resetJwksCache());

test('a properly signed token verifies, and the email is normalised', async () => {
  const key = keypair('kid-1');
  const claims = await verify(makeToken({ key }), jwksServer(() => [key.jwk]));

  assert.equal(claims.sub, 'google-sub-123');
  // Lowercased, because it is matched against invitation addresses.
  assert.equal(claims.email, 'owner@example.com');
  assert.equal(claims.name, 'בעלת העסק');
});

test('a token with a swapped payload is refused', async () => {
  const key = keypair('kid-1');
  await assert.rejects(
    () => verify(makeToken({ key, tamper: true }), jwksServer(() => [key.jwk])),
    /signature does not verify/,
  );
});

test('a token signed by another key is refused', async () => {
  const real = keypair('kid-1');
  const impostor = keypair('kid-1'); // same kid, different key
  await assert.rejects(
    () => verify(makeToken({ key: impostor }), jwksServer(() => [real.jwk])),
    /signature does not verify/,
  );
});

test('alg none is refused instead of trusted', async () => {
  // The classic JWT failure: honouring the token's own choice of algorithm.
  const key = keypair('kid-1');
  await assert.rejects(
    () => verify(makeToken({ key, header: { alg: 'none' } }), jwksServer(() => [key.jwk])),
    /unexpected id_token algorithm/,
  );
});

test('a token for another client is refused', async () => {
  const key = keypair('kid-1');
  await assert.rejects(
    () => verify(makeToken({ key, claims: { aud: 'someone-else.apps.googleusercontent.com' } }),
      jwksServer(() => [key.jwk])),
    /issued for another client/,
  );
});

test('a token from another issuer is refused', async () => {
  const key = keypair('kid-1');
  await assert.rejects(
    () => verify(makeToken({ key, claims: { iss: 'https://evil.example' } }), jwksServer(() => [key.jwk])),
    /unexpected id_token issuer/,
  );
});

test('both spellings of the Google issuer are accepted', async () => {
  const key = keypair('kid-1');
  const server = jwksServer(() => [key.jwk]);
  for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
    const claims = await verify(makeToken({ key, claims: { iss } }), server);
    assert.equal(claims.sub, 'google-sub-123');
  }
});

test('an expired token is refused, but a minute of clock skew is tolerated', async () => {
  const key = keypair('kid-1');
  const server = jwksServer(() => [key.jwk]);
  const now = Math.floor(Date.now() / 1000);

  await assert.rejects(
    () => verify(makeToken({ key, claims: { exp: now - 3600 } }), server),
    /has expired/,
  );
  // Thirty seconds past expiry still passes: clocks drift, and a login failing
  // for that reason is unexplainable to the user.
  const claims = await verify(makeToken({ key, claims: { exp: now - 30 } }), server);
  assert.equal(claims.sub, 'google-sub-123');
});

test('a token issued in the future is refused', async () => {
  const key = keypair('kid-1');
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(
    () => verify(makeToken({ key, claims: { iat: now + 600 } }), jwksServer(() => [key.jwk])),
    /issued in the future/,
  );
});

test('the nonce must match the login attempt that asked for it', async () => {
  const key = keypair('kid-1');
  const server = jwksServer(() => [key.jwk]);

  const ok = await verify(makeToken({ key, claims: { nonce: 'n-1' } }), server, { nonce: 'n-1' });
  assert.equal(ok.sub, 'google-sub-123');

  // Without this, a token obtained elsewhere for the same client is replayable.
  await assert.rejects(
    () => verify(makeToken({ key, claims: { nonce: 'n-1' } }), server, { nonce: 'n-2' }),
    /nonce does not match/,
  );
  await assert.rejects(
    () => verify(makeToken({ key }), server, { nonce: 'n-2' }),
    /nonce does not match/,
  );
});

test('an unverified email is refused', async () => {
  // Email is how an invitation is matched to a person, so an address anybody
  // could have typed is not good enough.
  const key = keypair('kid-1');
  const server = jwksServer(() => [key.jwk]);
  await assert.rejects(
    () => verify(makeToken({ key, claims: { email_verified: false } }), server),
    /no verified email/,
  );
  await assert.rejects(
    () => verify(makeToken({ key, claims: { email: undefined } }), server),
    /no email/,
  );
});

test('the signing keys are cached, not fetched per login', async () => {
  const key = keypair('kid-1');
  const server = jwksServer(() => [key.jwk]);
  await verify(makeToken({ key }), server);
  await verify(makeToken({ key }), server);
  await verify(makeToken({ key }), server);
  assert.equal(server.fetches(), 1);
});

test('a rotated signing key is picked up without an outage', async () => {
  const oldKey = keypair('kid-old');
  const newKey = keypair('kid-new');
  let published = [oldKey.jwk];
  const server = jwksServer(() => published);

  await verify(makeToken({ key: oldKey }), server);
  assert.equal(server.fetches(), 1);

  // Google rotates. The cached set no longer has the kid, so an unknown kid
  // must trigger one refetch rather than rejecting every login until the TTL.
  published = [newKey.jwk];
  const claims = await verify(makeToken({ key: newKey }), server);
  assert.equal(claims.sub, 'google-sub-123');
  assert.equal(server.fetches(), 2);
});

test('an unknown key id gives up after one refetch', async () => {
  const key = keypair('kid-1');
  const stranger = keypair('kid-unknown');
  const server = jwksServer(() => [key.jwk]);
  await assert.rejects(
    () => verify(makeToken({ key: stranger }), server),
    /no Google signing key matches kid kid-unknown/,
  );
  assert.equal(server.fetches(), 2, 'should refetch once, then stop');
});

test('a malformed token is refused rather than throwing something unreadable', async () => {
  const key = keypair('kid-1');
  const server = jwksServer(() => [key.jwk]);
  for (const bad of ['', 'abc', 'a.b', null]) {
    await assert.rejects(() => verify(bad, server), /not a JWT/);
  }
  const noKid = `${b64({ alg: 'RS256' })}.${b64({})}.x`;
  await assert.rejects(() => verify(noKid, server), /no key id/);
});

test('the authorization URL asks for identity only, with PKCE and account choice', () => {
  const url = new URL(authorizationUrl({
    state: 's', nonce: 'n', challenge: 'c', clientId: CLIENT_ID,
    uri: 'https://app.example/auth/google/callback',
  }));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'c');
  assert.equal(url.searchParams.get('state'), 's');
  assert.equal(url.searchParams.get('nonce'), 'n');
  // So a shared family computer does not silently reuse whichever Google
  // account happens to be signed in.
  assert.equal(url.searchParams.get('prompt'), 'select_account');
});

test('the code exchange posts the verifier and refuses a reply with no id_token', async () => {
  const config = { clientId: CLIENT_ID, clientSecret: 'shh' };
  let sent = null;
  const ok = async (_url, options) => {
    sent = new URLSearchParams(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ id_token: 'x.y.z' }) };
  };

  const tokens = await exchangeCode({
    code: 'the-code', verifier: 'the-verifier', uri: 'https://app.example/cb',
    fetchImpl: ok, config,
  });
  assert.equal(tokens.id_token, 'x.y.z');
  assert.equal(sent.get('code'), 'the-code');
  assert.equal(sent.get('code_verifier'), 'the-verifier');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('client_secret'), 'shh');

  await assert.rejects(() => exchangeCode({
    code: 'c', verifier: 'v', uri: 'u', config,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  }), /no id_token/);

  await assert.rejects(() => exchangeCode({
    code: 'c', verifier: 'v', uri: 'u', config,
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'invalid_grant' }),
  }), /token exchange failed \(400\)/);
});
