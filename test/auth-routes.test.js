import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeApp } from '../src/index.js';
import { safeReturnTo, requireUser, requireTenant } from '../src/auth/routes.js';
import { issueSession, COOKIES } from '../src/auth/session.js';
import { createTenantWithOwner, createInvitation, acceptInvitationByToken } from '../src/auth/store.js';
import { closePool } from '../src/db/index.js';
import { makeUser, dropUser, dropTenant, uniqueSlug } from './_helpers.js';

process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

/** Start an app on an ephemeral port; returns a fetch bound to its origin. */
async function serve(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, options = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...options });
  call.close = () => new Promise((resolve) => server.close(resolve));
  return call;
}

const sessionCookieFor = (userId) => {
  const header = issueSession(userId);
  return `${COOKIES.session}=${header.slice(header.indexOf('=') + 1, header.indexOf(';'))}`;
};

test('only a local path is followed after login', () => {
  assert.equal(safeReturnTo('/app/settings'), '/app/settings');
  assert.equal(safeReturnTo('/'), '/');

  // Each of these would otherwise sign a user in and land them somewhere else,
  // with our own signature on the state cookie making it look legitimate.
  for (const hostile of [
    'https://evil.example/phish',
    '//evil.example',            // protocol-relative: the browser reads a host
    '\\\\evil.example',          // some clients normalise backslashes to /
    '/app\\@evil.example',
    'javascript:alert(1)',
    '/app\r\nSet-Cookie: x=1',   // header splitting
    '', null, undefined,
  ]) {
    assert.equal(safeReturnTo(hostile), '/app', `expected ${JSON.stringify(hostile)} to be refused`);
  }
});

test('/auth/google parks a state cookie and sends the user to Google', async (t) => {
  const call = await serve(makeApp());
  t.after(async () => { await call.close(); await closePool(); });

  const response = await call('/auth/google?returnTo=/app/settings');
  assert.equal(response.status, 302);

  const location = new URL(response.headers.get('location'));
  assert.equal(location.host, 'accounts.google.com');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(location.searchParams.get('state'));

  const cookie = response.headers.getSetCookie().find((c) => c.startsWith(COOKIES.oauth));
  assert.ok(cookie, 'the state cookie must be set, or the callback has nothing to check against');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/auth/);
});

test('a hostile returnTo does not survive into the login round trip', async (t) => {
  const call = await serve(makeApp());
  t.after(async () => { await call.close(); await closePool(); });
  // Signed by us, so it has to be refused on the way in, not on the way out.
  const response = await call('/auth/google?returnTo=https://evil.example');
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^https:\/\/accounts\.google\.com\//);
});

test('the callback refuses everything that is not a matching round trip', async (t) => {
  const call = await serve(makeApp());
  t.after(async () => { await call.close(); await closePool(); });

  // No state cookie at all.
  assert.equal((await call('/auth/google/callback?code=x&state=y')).status, 400);

  // A real state cookie, then a mismatched state. This is the CSRF defence:
  // without it an attacker's code is redeemed in the victim's browser.
  const start = await call('/auth/google?returnTo=/app');
  const oauthCookie = start.headers.getSetCookie()
    .find((c) => c.startsWith(COOKIES.oauth)).split(';')[0];

  const mismatch = await call('/auth/google/callback?code=x&state=not-the-one',
    { headers: { cookie: oauthCookie } });
  assert.equal(mismatch.status, 400);

  // A consent screen the user declined is reported this way and is not an error.
  assert.equal((await call('/auth/google/callback?error=access_denied',
    { headers: { cookie: oauthCookie } })).status, 400);
});

test('an API call with no session gets JSON, and a page gets a redirect', async (t) => {
  const call = await serve(makeApp());
  t.after(async () => { await call.close(); await closePool(); });

  const asApi = await call('/auth/me', { headers: { accept: 'application/json' } });
  assert.equal(asApi.status, 401);
  assert.equal((await asApi.json()).signedOut, true);

  // Returning login HTML to a fetch() is how a session expiry becomes an
  // unreadable parse error.
  const asPage = await call('/auth/me', { headers: { accept: 'text/html' } });
  assert.equal(asPage.status, 302);
  assert.match(asPage.headers.get('location'), /^\/auth\/google\?returnTo=/);
});

test('a forged session cookie is not a session', async (t) => {
  const call = await serve(makeApp());
  t.after(async () => { await call.close(); await closePool(); });

  for (const value of ['garbage', 'a.b', `${Buffer.from('{"uid":"x","exp":9999999999999}').toString('base64url')}.sig`]) {
    const response = await call('/auth/me', {
      headers: { accept: 'application/json', cookie: `${COOKIES.session}=${value}` },
    });
    assert.equal(response.status, 401, `expected ${value} to be refused`);
  }
});

test('a signed-in user sees themselves and their businesses', async (t) => {
  const user = await makeUser();
  const tenant = await createTenantWithOwner(user.id, { slug: uniqueSlug(), name: 'קייטנת בדיקה' });
  const call = await serve(makeApp());
  t.after(async () => {
    await call.close(); await dropTenant(tenant.id); await dropUser(user.id); await closePool();
  });

  const response = await call('/auth/me', {
    headers: { accept: 'application/json', cookie: sessionCookieFor(user.id) },
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.user.email, user.email);
  assert.equal(body.tenants.length, 1);
  assert.equal(body.tenants[0].role, 'owner');
  assert.equal(body.tenants[0].slug, tenant.slug);
  // The cookie says who, not what: nothing about roles is trusted from it.
  assert.ok(!JSON.stringify(body).includes('google_sub'));
});

test('a session for a deleted user is not a session', async (t) => {
  const user = await makeUser();
  const cookie = sessionCookieFor(user.id);
  await dropUser(user.id);

  const call = await serve(makeApp());
  t.after(async () => { await call.close(); await closePool(); });

  const response = await call('/auth/me', { headers: { accept: 'application/json', cookie } });
  assert.equal(response.status, 401);
});

test('signing out is a POST, not a GET', async (t) => {
  const call = await serve(makeApp());
  t.after(async () => { await call.close(); await closePool(); });

  // A GET sign-out fires from any image tag on any page.
  assert.equal((await call('/auth/signout')).status, 404);

  const response = await call('/auth/signout', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.match(response.headers.getSetCookie()[0], /Max-Age=0/);
});

test('membership decides access, and a non-member gets 404 rather than 403', async (t) => {
  const owner = await makeUser();
  const staff = await makeUser();
  const outsider = await makeUser();
  const tenant = await createTenantWithOwner(owner.id, { slug: uniqueSlug(), name: 'קייטנה' });

  const invite = await createInvitation({ tenantId: tenant.id, email: staff.email, role: 'staff' });
  await acceptInvitationByToken(invite.token, staff.id);

  // A stand-in for the surfaces still to be ported, exercising the real guards.
  const app = express();
  app.get('/t/:tenantId/any', requireUser, requireTenant(), (req, res) =>
    res.json({ role: req.role }));
  app.get('/t/:tenantId/owner-only', requireUser, requireTenant({ role: 'owner' }), (_req, res) =>
    res.json({ ok: true }));

  const call = await serve(app);
  t.after(async () => {
    await call.close(); await dropTenant(tenant.id);
    await dropUser(owner.id); await dropUser(staff.id); await dropUser(outsider.id);
    await closePool();
  });

  const as = (user, path) => call(`/t/${tenant.id}${path}`,
    { headers: { accept: 'application/json', cookie: sessionCookieFor(user.id) } });

  assert.equal((await as(owner, '/any')).status, 200);
  assert.equal((await (await as(staff, '/any')).json()).role, 'staff');

  // 404: confirming the business exists to someone with no access is itself a
  // disclosure.
  assert.equal((await as(outsider, '/any')).status, 404);
  assert.equal((await as(outsider, '/owner-only')).status, 404);

  // Staff are members, so they get a straight refusal rather than a 404.
  assert.equal((await as(staff, '/owner-only')).status, 403);
  assert.equal((await as(owner, '/owner-only')).status, 200);
});

test('health reports the database', async (t) => {
  const call = await serve(makeApp());
  t.after(async () => { await call.close(); await closePool(); });
  const body = await (await call('/health')).json();
  assert.equal(body.ok, true);
  assert.equal(body.db, 'up');
});
