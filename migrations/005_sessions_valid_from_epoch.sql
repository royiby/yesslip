-- Stop a brand-new user from starting out signed out.
--
-- 004 defaulted sessions_valid_from to now(). The session cookie's issue time
-- comes from the application's clock and this column from the database's, and
-- the row is created a few milliseconds after the cookie is minted, so a
-- freshly created user's cutoff sits slightly in the *future* of their own
-- first cookie. Measured at ~19ms locally, and in production the two clocks
-- belong to different machines, so the gap is whatever NTP leaves.
--
-- Caught by test/auth-store.test.js, which asserted a new user's session was
-- fresh and found it was not.
--
-- The fix removes the cross-clock comparison at account creation rather than
-- papering over it with a tolerance: the epoch means "no cutoff", so the
-- column is only ever compared against after an explicit sign-out-everywhere,
-- which is the one moment it is meant to describe. A tolerance would instead
-- have weakened that sign-out by its own width.

ALTER TABLE users ALTER COLUMN sessions_valid_from SET DEFAULT to_timestamp(0);

-- Nothing is in production, but a user created under 004's default would be
-- permanently one step behind their own cookies.
UPDATE users SET sessions_valid_from = to_timestamp(0)
 WHERE sessions_valid_from > to_timestamp(0);

COMMENT ON COLUMN users.sessions_valid_from IS
  'Cookies issued before this instant are refused. The epoch means no cutoff. Set to now() to sign a user out of every device.';
