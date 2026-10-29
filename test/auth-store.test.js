import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { platform, closePool } from '../src/db/index.js';
import {
  upsertUserFromGoogle, getUserById, sessionIsFresh, signOutEverywhere,
  membershipsFor, roleFor, listMembers, createTenantWithOwner, removeMember, setRole,
  createInvitation, listInvitations, revokeInvitation, acceptInvitationByToken,
  claimInvitationsByEmail,
} from '../src/auth/store.js';
import { makeTenant, dropTenant, makeUser, dropUser, uniqueSlug } from './_helpers.js';

test('a Google identity creates a user, and signing in again updates it', async (t) => {
  const sub = `google-${crypto.randomBytes(4).toString('hex')}`;
  const first = await upsertUserFromGoogle({ sub, email: 'Her@Example.com', name: 'שם' });
  t.after(async () => { await dropUser(first.id); await closePool(); });

  assert.equal(first.email, 'her@example.com', 'email is stored lowercased');

  // The subject is the identity, so a changed email updates the same row
  // rather than creating a second account.
  const again = await upsertUserFromGoogle({ sub, email: 'new@example.com', name: null });
  assert.equal(again.id, first.id);
  assert.equal(again.email, 'new@example.com');
  assert.equal(again.name, 'שם', 'a login without a name must not erase the one we had');
});

test('a user signing in with a different Google account is a different user', async (t) => {
  const a = await upsertUserFromGoogle({ sub: 'sub-a', email: 'same@example.com' });
  const b = await upsertUserFromGoogle({ sub: 'sub-b', email: 'same@example.com' });
  t.after(async () => { await dropUser(a.id); await dropUser(b.id); await closePool(); });
  assert.notEqual(a.id, b.id);
});

test('an identity with no subject or email is refused', async (t) => {
  t.after(async () => { await closePool(); });
  await assert.rejects(() => upsertUserFromGoogle({ email: 'a@b.com' }), /subject and an email/);
  await assert.rejects(() => upsertUserFromGoogle({ sub: 'x' }), /subject and an email/);
});

test('signing out everywhere invalidates cookies issued before it', async (t) => {
  const user = await makeUser();
  t.after(async () => { await dropUser(user.id); await closePool(); });

  const issuedAt = Date.now();
  assert.equal(sessionIsFresh(user, issuedAt), true);

  await new Promise((resolve) => setTimeout(resolve, 10));
  await signOutEverywhere(user.id);

  const after = await getUserById(user.id);
  assert.equal(sessionIsFresh(after, issuedAt), false, 'the old cookie must stop working');
  assert.equal(sessionIsFresh(after, Date.now() + 1000), true, 'a fresh login still works');
});

test('whoever creates a business owns it', async (t) => {
  const user = await makeUser();
  const tenant = await createTenantWithOwner(user.id, { slug: uniqueSlug(), name: 'קייטנה' });
  t.after(async () => { await dropTenant(tenant.id); await dropUser(user.id); await closePool(); });

  assert.equal(await roleFor(user.id, tenant.id), 'owner');
  const mine = await membershipsFor(user.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].slug, tenant.slug);
  assert.equal(mine[0].role, 'owner');
});

test('a non-member gets null, not a role, and a missing tenant looks the same', async (t) => {
  const outsider = await makeUser();
  const tenant = await makeTenant();
  t.after(async () => { await dropTenant(tenant.id); await dropUser(outsider.id); await closePool(); });

  // Same answer for "not a member" and "no such tenant": telling them apart
  // tells an outsider which businesses exist.
  assert.equal(await roleFor(outsider.id, tenant.id), null);
  assert.equal(await roleFor(outsider.id, '99999999-9999-4999-8999-999999999999'), null);
  assert.equal(await roleFor(null, tenant.id), null);
  assert.deepEqual(await membershipsFor(outsider.id), []);
});

test('the last owner cannot be removed or demoted', async (t) => {
  const owner = await makeUser();
  const tenant = await createTenantWithOwner(owner.id, { slug: uniqueSlug(), name: 'קייטנה' });
  t.after(async () => { await dropTenant(tenant.id); await dropUser(owner.id); await closePool(); });

  // A business with no owner has paying parents and a live standing order and
  // nobody who can administer it.
  const removed = await removeMember(tenant.id, owner.id);
  assert.equal(removed.removed, false);
  assert.match(removed.problem, /הבעלים האחרון/);

  const demoted = await setRole(tenant.id, owner.id, 'staff');
  assert.equal(demoted.changed, false);
  assert.match(demoted.problem, /הבעלים האחרון/);

  assert.equal(await roleFor(owner.id, tenant.id), 'owner');
});

test('a second owner makes the first removable', async (t) => {
  const first = await makeUser();
  const second = await makeUser();
  const tenant = await createTenantWithOwner(first.id, { slug: uniqueSlug(), name: 'קייטנה' });
  t.after(async () => {
    await dropTenant(tenant.id); await dropUser(first.id); await dropUser(second.id); await closePool();
  });

  const invite = await createInvitation({ tenantId: tenant.id, email: second.email, role: 'owner' });
  await acceptInvitationByToken(invite.token, second.id);
  assert.equal(await roleFor(second.id, tenant.id), 'owner');

  const removed = await removeMember(tenant.id, first.id);
  assert.equal(removed.removed, true);
  assert.equal(await roleFor(first.id, tenant.id), null);
});

test('removing someone who is not a member says so', async (t) => {
  const tenant = await makeTenant();
  const stranger = await makeUser();
  t.after(async () => { await dropTenant(tenant.id); await dropUser(stranger.id); await closePool(); });
  const result = await removeMember(tenant.id, stranger.id);
  assert.equal(result.removed, false);
  assert.match(result.problem, /אינו משויך/);
});

test('an invitation stores only a hash of its token', async (t) => {
  const tenant = await makeTenant();
  t.after(async () => { await dropTenant(tenant.id); await closePool(); });

  const invite = await createInvitation({ tenantId: tenant.id, email: 'New@Example.com' });
  assert.ok(invite.token.length >= 40);
  assert.equal(invite.email, 'new@example.com');

  // This table is what a database leak hands over, and an invitation grants
  // access to children's registration data.
  const row = await platform(async (c) => (await c.query(
    'SELECT token_sha256 FROM invitations WHERE tenant_id = $1', [tenant.id],
  )).rows[0]);
  assert.deepEqual(row.token_sha256, crypto.createHash('sha256').update(invite.token).digest());
  assert.ok(!row.token_sha256.includes(Buffer.from(invite.token)));
});

test('an invitation is redeemed once, and a replay is refused', async (t) => {
  const tenant = await makeTenant();
  const user = await makeUser();
  t.after(async () => { await dropTenant(tenant.id); await dropUser(user.id); await closePool(); });

  const invite = await createInvitation({ tenantId: tenant.id, email: user.email, role: 'staff' });
  const first = await acceptInvitationByToken(invite.token, user.id);
  assert.equal(first.accepted, true);
  assert.equal(first.role, 'staff');
  assert.equal(await roleFor(user.id, tenant.id), 'staff');

  const second = await acceptInvitationByToken(invite.token, user.id);
  assert.equal(second.accepted, false);
  assert.match(second.problem, /אינה תקפה או שנעשה בה שימוש/);
});

test('an unknown token and a spent token are indistinguishable', async (t) => {
  t.after(async () => { await closePool(); });
  const user = await makeUser();
  t.after(async () => { await dropUser(user.id); });

  // So a probe cannot tell a wrong guess from a used invitation.
  const result = await acceptInvitationByToken('not-a-real-token', user.id);
  assert.equal(result.accepted, false);
  assert.match(result.problem, /אינה תקפה או שנעשה בה שימוש/);
});

test('an expired invitation is refused with a different, actionable message', async (t) => {
  const tenant = await makeTenant();
  const user = await makeUser();
  t.after(async () => { await dropTenant(tenant.id); await dropUser(user.id); await closePool(); });

  const invite = await createInvitation({ tenantId: tenant.id, email: user.email });
  await platform((c) => c.query(
    "UPDATE invitations SET expires_at = now() - interval '1 day' WHERE tenant_id = $1", [tenant.id],
  ));

  const result = await acceptInvitationByToken(invite.token, user.id);
  assert.equal(result.accepted, false);
  assert.match(result.problem, /פגה/);
  assert.equal(await roleFor(user.id, tenant.id), null);
});

test('re-inviting the same address replaces the pending invitation', async (t) => {
  const tenant = await makeTenant();
  const user = await makeUser();
  t.after(async () => { await dropTenant(tenant.id); await dropUser(user.id); await closePool(); });

  const first = await createInvitation({ tenantId: tenant.id, email: user.email, role: 'staff' });
  const second = await createInvitation({ tenantId: tenant.id, email: user.email, role: 'owner' });

  assert.equal((await listInvitations(tenant.id)).length, 1, 'one pending invite per address');
  // The superseded link must stop working, or a revoked-then-reissued role is
  // still claimable at the old one.
  assert.equal((await acceptInvitationByToken(first.token, user.id)).accepted, false);
  assert.equal((await acceptInvitationByToken(second.token, user.id)).accepted, true);
  assert.equal(await roleFor(user.id, tenant.id), 'owner');
});

test('inviting someone who is already a member is refused', async (t) => {
  const owner = await makeUser();
  const tenant = await createTenantWithOwner(owner.id, { slug: uniqueSlug(), name: 'קייטנה' });
  t.after(async () => { await dropTenant(tenant.id); await dropUser(owner.id); await closePool(); });
  await assert.rejects(
    () => createInvitation({ tenantId: tenant.id, email: owner.email }),
    /כבר משויך/,
  );
});

test('a revoked invitation stops working', async (t) => {
  const tenant = await makeTenant();
  const user = await makeUser();
  t.after(async () => { await dropTenant(tenant.id); await dropUser(user.id); await closePool(); });

  const invite = await createInvitation({ tenantId: tenant.id, email: user.email });
  const [pending] = await listInvitations(tenant.id);
  assert.equal(await revokeInvitation(tenant.id, pending.id), true);
  assert.equal((await acceptInvitationByToken(invite.token, user.id)).accepted, false);
  assert.equal(await revokeInvitation(tenant.id, pending.id), false, 'revoking twice is not an error');
});

test('one business cannot revoke another business invitation', async (t) => {
  const a = await makeTenant();
  const b = await makeTenant();
  t.after(async () => { await dropTenant(a.id); await dropTenant(b.id); await closePool(); });

  await createInvitation({ tenantId: a.id, email: 'x@example.com' });
  const [invite] = await listInvitations(a.id);
  assert.equal(await revokeInvitation(b.id, invite.id), false);
  assert.equal((await listInvitations(a.id)).length, 1);
});

test('a pending invitation is claimed on first sign-in, without the link', async (t) => {
  const tenant = await makeTenant();
  t.after(async () => { await dropTenant(tenant.id); await closePool(); });

  const email = `invited-${crypto.randomBytes(4).toString('hex')}@example.com`;
  await createInvitation({ tenantId: tenant.id, email: email.toUpperCase(), role: 'staff' });

  // Safe only because this address came from a verified email_verified claim
  // in a signature-checked ID token, not from anything the user typed.
  const user = await upsertUserFromGoogle({ sub: `g-${email}`, email, name: 'עובדת' });
  t.after(async () => { await dropUser(user.id); });

  const claimed = await claimInvitationsByEmail(user.id, user.email);
  assert.equal(claimed.length, 1);
  assert.equal(await roleFor(user.id, tenant.id), 'staff');
  assert.equal((await listInvitations(tenant.id)).length, 0);

  // Idempotent: signing in again claims nothing further.
  assert.deepEqual(await claimInvitationsByEmail(user.id, user.email), []);
});

test('an expired invitation is not claimed on sign-in, and stays visible to the owner', async (t) => {
  const tenant = await makeTenant();
  t.after(async () => { await dropTenant(tenant.id); await closePool(); });

  const email = `stale-${crypto.randomBytes(4).toString('hex')}@example.com`;
  await createInvitation({ tenantId: tenant.id, email });
  await platform((c) => c.query(
    "UPDATE invitations SET expires_at = now() - interval '1 day' WHERE tenant_id = $1", [tenant.id],
  ));

  const user = await upsertUserFromGoogle({ sub: `g-${email}`, email });
  t.after(async () => { await dropUser(user.id); });

  assert.deepEqual(await claimInvitationsByEmail(user.id, user.email), []);
  assert.equal(await roleFor(user.id, tenant.id), null);
  // Left in place, flagged, so the owner can send another rather than wonder
  // where it went.
  const [listed] = await listInvitations(tenant.id);
  assert.equal(listed.expired, true);
});

test('members are listed with their roles', async (t) => {
  const owner = await makeUser();
  const staff = await makeUser();
  const tenant = await createTenantWithOwner(owner.id, { slug: uniqueSlug(), name: 'קייטנה' });
  t.after(async () => {
    await dropTenant(tenant.id); await dropUser(owner.id); await dropUser(staff.id); await closePool();
  });

  const invite = await createInvitation({ tenantId: tenant.id, email: staff.email });
  await acceptInvitationByToken(invite.token, staff.id);

  const members = await listMembers(tenant.id);
  assert.equal(members.length, 2);
  assert.deepEqual(members.map((m) => m.role).sort(), ['owner', 'staff']);
});

test('a bad email or role is refused before a row is written', async (t) => {
  const tenant = await makeTenant();
  t.after(async () => { await dropTenant(tenant.id); await closePool(); });
  await assert.rejects(() => createInvitation({ tenantId: tenant.id, email: 'nope' }), /מייל/);
  await assert.rejects(
    () => createInvitation({ tenantId: tenant.id, email: 'a@b.com', role: 'admin' }),
    /unknown role/,
  );
  assert.deepEqual(await listInvitations(tenant.id), []);
});
