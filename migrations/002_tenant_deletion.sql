-- A tenant must be deletable: account closure, and erasure on request under
-- the Privacy Protection Law. Every tenant table references tenants with
-- ON DELETE CASCADE, so one DELETE removes that business entirely, and
-- dropping its wrapped data key along with the row renders any copy of its
-- encrypted secrets unreadable.
--
-- Left out of 001 by oversight: the app role could create a tenant but not
-- remove one.

GRANT DELETE ON tenants TO yesslip_app;
GRANT DELETE ON users   TO yesslip_app;
