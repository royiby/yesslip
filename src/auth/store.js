import crypto from 'node:crypto';
import { platform, platformTx } from '../db/index.js';
import { createTenant } from '../tenants/store.js';

/**
 * Users, who they work for, and how someone new gets let in.
 *
 * Authorisation is a question asked of `memberships` on every request rather
 * than something baked into a session. The cost is one indexed read per
 * request; the benefit is that "remove this person from my business" takes
 * effect immediately and in one place.
 */

const INVITE_DAYS = 14;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/**
 * The Google subject is the identity, not the email. People change their
 * email, and Google guarantees `sub` is stable and never reused; matching on
 * email would also mean a Workspace admin re-creating an address inherits the
 * old person's access.
 */
export async function upsertUserFromGoogle({ sub, email, name }) {
  if (!sub || !email) throw new Error('a Google identity needs a subject and an email');
  return platform(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (google_sub) DO UPDATE SET
         email = EXCLUDED.email,
         name  = COALESCE(EXCLUDED.name, users.name)
       RETURNING id, google_sub, email, name, sessions_valid_from, created_at`,
      [sub, String(email).toLowerCase(), name ?? null],
    );
    return rows[0];
  });
}

export async function getUserById(id) {
  if (!id) return null;
  return platform(async (client) => {
    const { rows } = await client.query(
      'SELECT id, google_sub, email, name, sessions_valid_from FROM users WHERE id = $1', [id],
    );
    return rows[0] ?? null;
  });
}

/**
 * Whether a cookie issued at `issuedAtMs` is still honoured. A session is
 * refused once `sessions_valid_from` moves past it, which is the "sign me out
 * everywhere" lever a membership change cannot provide.
 */
export function sessionIsFresh(user, issuedAtMs) {
  if (!user || typeof issuedAtMs !== 'number') return false;
  return issuedAtMs >= new Date(user.sessions_valid_from).getTime();
}

export async function signOutEverywhere(userId) {
  return platform((client) =>
    client.query('UPDATE users SET sessions_valid_from = now() WHERE id = $1', [userId]));
}

/** The businesses this user can act for, with the role in each. */
export async function membershipsFor(userId) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT t.id AS tenant_id, t.slug, t.name, t.status, m.role
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY t.name`,
      [userId],
    );
    return rows;
  });
}

/**
 * The role, or null. Null is the answer to both "not a member" and "no such
 * tenant", on purpose: distinguishing them tells an outsider which slugs
 * exist.
 */
export async function roleFor(userId, tenantId) {
  if (!userId || !tenantId) return null;
  return platform(async (client) => {
    const { rows } = await client.query(
      'SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2', [userId, tenantId],
    );
    return rows[0]?.role ?? null;
  });
}

export async function listMembers(tenantId) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT u.id, u.email, u.name, m.role, m.created_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 ORDER BY m.created_at`,
      [tenantId],
    );
    return rows;
  });
}

/** Whoever creates a business owns it. */
export async function createTenantWithOwner(userId, details) {
  const tenant = await createTenant(details);
  await platform((client) => client.query(
    `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'owner')`,
    [userId, tenant.id],
  ));
  return tenant;
}

/**
 * Removing the last owner would leave a business nobody can administer, with
 * paying parents and a live standing order attached to it. Refused rather than
 * left to the caller to remember.
 */
export async function removeMember(tenantId, userId) {
  return platformTx(async (client) => {
    const { rows } = await client.query(
      'SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE',
      [tenantId, userId],
    );
    const role = rows[0]?.role;
    if (!role) return { removed: false, problem: 'המשתמש אינו משויך לעסק הזה' };

    if (role === 'owner') {
      const { rows: owners } = await client.query(
        `SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner'`,
        [tenantId],
      );
      if (owners[0].n <= 1) {
        return { removed: false, problem: 'אי אפשר להסיר את הבעלים האחרון של העסק' };
      }
    }

    await client.query('DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    return { removed: true, problem: null };
  });
}

export async function setRole(tenantId, userId, role) {
  if (!['owner', 'staff'].includes(role)) throw new Error(`unknown role: ${role}`);
  return platformTx(async (client) => {
    if (role === 'staff') {
      // Demoting the last owner is the same hole as removing them.
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM memberships
          WHERE tenant_id = $1 AND role = 'owner' AND user_id <> $2`,
        [tenantId, userId],
      );
      if (rows[0].n === 0) {
        return { changed: false, problem: 'אי אפשר להוריד את הבעלים האחרון לתפקיד עובד' };
      }
    }
    const { rowCount } = await client.query(
      'UPDATE memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId, role],
    );
    return { changed: rowCount === 1, problem: rowCount === 1 ? null : 'המשתמש אינו משויך לעסק הזה' };
  });
}

// ──────────────────── invitations ────────────────────

/**
 * Returns the raw token exactly once, for putting in a link. Only its hash is
 * stored, because this table is what a database leak hands over and an
 * invitation grants access to children's registration data.
 *
 * A second invitation to the same address replaces the first rather than
 * racing it (see the partial unique index in 004).
 */
export async function createInvitation({ tenantId, email, role = 'staff', invitedBy = null }) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!address.includes('@')) throw new Error('כתובת מייל לא תקינה');
  if (!['owner', 'staff'].includes(role)) throw new Error(`unknown role: ${role}`);

  const token = crypto.randomBytes(32).toString('base64url');

  const invitation = await platformTx(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND lower(u.email) = $2`,
      [tenantId, address],
    );
    if (existing[0]) throw new Error('המשתמש הזה כבר משויך לעסק');

    await client.query(
      `DELETE FROM invitations
        WHERE tenant_id = $1 AND lower(email) = $2 AND accepted_at IS NULL`,
      [tenantId, address],
    );

    const { rows } = await client.query(
      `INSERT INTO invitations (tenant_id, email, role, token_sha256, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
       RETURNING id, email, role, expires_at`,
      [tenantId, address, role, sha256(token), invitedBy, String(INVITE_DAYS)],
    );
    return rows[0];
  });

  return { ...invitation, token };
}

export async function listInvitations(tenantId) {
  return platform(async (client) => {
    const { rows } = await client.query(
      `SELECT id, email, role, expires_at, created_at,
              (expires_at <= now()) AS expired
         FROM invitations
        WHERE tenant_id = $1 AND accepted_at IS NULL
        ORDER BY created_at DESC`,
      [tenantId],
    );
    return rows;
  });
}

export async function revokeInvitation(tenantId, invitationId) {
  return platform(async (client) => {
    const { rowCount } = await client.query(
      'DELETE FROM invitations WHERE tenant_id = $1 AND id = $2 AND accepted_at IS NULL',
      [tenantId, invitationId],
    );
    return rowCount === 1;
  });
}

/** Redeem an invitation link. The token is looked up by hash, never compared in JS. */
export async function acceptInvitationByToken(token, userId) {
  return platformTx(async (client) => {
    const { rows } = await client.query(
      `SELECT id, tenant_id, role, expires_at, accepted_at
         FROM invitations WHERE token_sha256 = $1 FOR UPDATE`,
      [sha256(token)],
    );
    const invitation = rows[0];
    // One message for "no such token" and "already used", so a probe cannot
    // distinguish a wrong guess from a spent one.
    if (!invitation || invitation.accepted_at) {
      return { accepted: false, problem: 'ההזמנה אינה תקפה או שנעשה בה שימוש' };
    }
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      return { accepted: false, problem: 'ההזמנה פגה. בקשו הזמנה חדשה' };
    }

    await client.query(
      `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [userId, invitation.tenant_id, invitation.role],
    );
    await client.query(
      'UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1',
      [invitation.id, userId],
    );
    return { accepted: true, tenantId: invitation.tenant_id, role: invitation.role, problem: null };
  });
}

/**
 * Invitations addressed to this user's verified Google email, redeemed on
 * sign-in without them having to find the link again.
 *
 * Safe because the email came from a verified `email_verified` claim in a
 * signature-checked ID token, not from anything the user typed. An expired
 * invitation is left alone rather than deleted, so the owner can still see it
 * on the members screen and send another.
 */
export async function claimInvitationsByEmail(userId, email) {
  const address = String(email ?? '').toLowerCase();
  if (!address) return [];
  return platformTx(async (client) => {
    const { rows } = await client.query(
      `SELECT id, tenant_id, role FROM invitations
        WHERE lower(email) = $1 AND accepted_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [address],
    );
    for (const invitation of rows) {
      await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tenant_id) DO NOTHING`,
        [userId, invitation.tenant_id, invitation.role],
      );
      await client.query(
        'UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1',
        [invitation.id, userId],
      );
    }
    return rows.map((r) => ({ tenantId: r.tenant_id, role: r.role }));
  });
}
