-- Google login, and the two things it needs beyond the users table from 001.
--
-- There is deliberately no sessions table. A session is a signed cookie
-- carrying a user id and an issue time, and authorisation is re-derived from
-- `memberships` on every request. That is not laziness about revocation, it is
-- where revocation belongs: the operation an owner actually performs is
-- "remove this person from my business", and removing the membership row
-- denies them on their very next request without anything else having to
-- expire. A session table would add a read per request and a second place for
-- access to be true.
--
-- What that leaves missing is "sign me out everywhere", which a stolen laptop
-- needs and a membership change does not cover. Hence one column.

ALTER TABLE users
  ADD COLUMN sessions_valid_from timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN users.sessions_valid_from IS
  'Cookies issued before this instant are refused. Bump it to sign a user out of every device.';

-- An owner invites staff by email, before that person has ever signed in, so
-- an invitation cannot reference a user row.
--
-- Matching happens on the email Google asserts, not on the one typed here:
-- those can differ in case and in gmail dot-and-plus forms, so the lookup is
-- on lower(email) and an invitation is consumed only once.
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),

  -- The token is sent in a link and only its hash is kept, for the same reason
  -- a password is not stored: this table is what a database leak hands over,
  -- and an invitation is a grant of access to children's registration data.
  token_sha256 bytea NOT NULL UNIQUE,

  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One pending invitation per address per business. A second invite to the same
-- person should replace the first, not race it.
CREATE UNIQUE INDEX invitations_pending_idx
  ON invitations (tenant_id, lower(email)) WHERE accepted_at IS NULL;

CREATE INDEX invitations_email_idx ON invitations (lower(email)) WHERE accepted_at IS NULL;

-- Not RLS-protected, and that is the same call as for memberships in 001:
-- these tables are how the app works out which tenant it is serving, so they
-- cannot themselves sit behind the tenant setting. Every read of them is
-- scoped in the application.
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO yesslip_app;
