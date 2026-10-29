-- Make the append-only ledger fail loudly.
--
-- 001 gave cancellations no UPDATE or DELETE policy, on the assumption that
-- row-level security would refuse both. It does not: for UPDATE and DELETE,
-- RLS acts as a filter, so a default-deny matches zero rows and reports
-- success. Verified in test/isolation.test.js, which is why this migration
-- exists.
--
-- Zero rows affected is the right outcome and the wrong signal. Code that
-- tries to rewrite a cancellation is a bug, and a bug that reports success is
-- the kind found a year later by an accountant. Revoking the privilege turns
-- it into an immediate permission error.
--
-- The grant stays for SELECT and INSERT: the ledger is written once and read
-- often.

REVOKE UPDATE, DELETE ON cancellations FROM yesslip_app;
