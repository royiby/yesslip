# Yesslip

Multi-tenant registration, signed consent and Morning payments for small
businesses. A generic product built from the Yetziron registration server
(`../WhatsappOrderAgent`), which stays untouched and single-tenant.

Plan and research: [PLAN.md](PLAN.md). This file is the state of the code.

## Where this is up to

Phase 1 of the plan, part way. The multi-tenant foundation is in and tested;
no feature surface has been ported yet.

**Done, with tests:**

| Piece | File | What it settles |
|---|---|---|
| Tenant-scoped Postgres schema | `migrations/001_init.sql` | 8 tenant tables with row-level security FORCEd, the 7 Google Sheets tabs ported to tables, plus platform tables. |
| Tenant-scoped data access | `src/db/index.js` | `withTenant()` is the only way to reach a tenant table. Deny by default: no tenant set reads empty. |
| Envelope encryption | `src/crypto/secrets.js` | Per-tenant data key under a master key. Ciphertext bound to tenant and field, so it cannot be moved between either. |
| Tenants and credentials | `src/tenants/store.js` | Tenant CRUD, Morning credentials in, decryption isolated to one named function. |
| Morning client, per tenant | `src/morning/client.js` | **The §2.1 fix.** A factory with its token cache in the closure. Full API surface ported. |
| Client resolution | `src/morning/index.js` | `morningFor(tenantId)`, and the onboarding verification that discovers the Grow clearing. |

**Not started:** Google login and memberships, the booking and operator
surfaces, consents to R2, live config editing, the Sheets mirror, billing.

## The two things worth knowing before reading the code

**1. The app is not the database owner.** It connects as `yesslip_app`.
Row-level security does not constrain a table's owner unless it is FORCEd, so
both are done: the policies are forced, and the app is not the owner. A test
suite that connected as the owner would pass while production leaked, so
`test/isolation.test.js` runs as the app role.

**2. There is no module-level mutable state in the Morning client.** The
single-tenant original cached its access token in a module `let`, which in a
process serving two businesses means whichever tenant authenticated first
supplies the token for every later call: one business reading another's
invoices, with every response looking valid. A `let` at module scope in
`src/morning/client.js` reintroduces that bug.

## Running it

Needs Docker for Postgres, and Node 22 or newer.

```bash
npm install
npm run db:up          # Postgres 18 in Docker on :5433
cp .env.example .env
npm run keygen         # paste the result into SECRETS_MASTER_KEY
npm run migrate
npm test
```

`npm run db:psql` opens a shell on the dev database.

## Tests

49 tests, all passing. They need the database up and migrated; they do not
mock it, because the thing under test is largely the database's own
enforcement.

| File | Proves |
|---|---|
| `test/isolation.test.js` | Two tenants cannot see, write, update or delete each other. No tenant set reads empty. The tenant setting does not survive onto a pooled connection. `cancellations` cannot be rewritten. |
| `test/secrets.test.js` | Round trips; a ciphertext read as another tenant, another field, or with another key fails; tampering fails; master-key rotation works. |
| `test/morning-client.test.js` | Two tenants never share a token; a 401 clears only the client that saw it; `notifyUrl` and `pluginId` are per tenant; a standing order sends `documentVatType` 0. |
| `test/tenants.test.js` | Credentials round trip; the database holds no plaintext secret; a ciphertext moved between tenant rows fails; the settings-screen object carries no secret; reconnecting resets verification. |

## Decisions already made, and why

**Postgres is the system of record, not Google Sheets.** Sheets' quota is 300
writes per minute per project, shared across every tenant. Camp registration
opens at 20:00 and two hundred parents arrive in ten minutes, so one tenant's
rush would 429 everybody else's. Sheets returns later as an opt-in, async,
best-effort mirror, because handing an accountant the `cancellations` tab is
worth keeping.

**`cancellations` is append-only in the database, not by convention.** 001 gave
it no UPDATE or DELETE policy, assuming RLS would refuse both. It does not: for
UPDATE and DELETE, RLS is a filter, so a default-deny matches zero rows and
reports success. `003_cancellations_append_only.sql` revokes the privileges
instead, which turns a silent no-op into an immediate error. The test caught
this.

**Express 4, matching the source.** Express 5 changed path syntax and query
handling; porting 1000+ lines of existing routes onto it at the same time as
making them multi-tenant is two risky changes at once. Upgrade is its own task.

**No ORM.** Raw SQL with `pg`, as the source uses raw everything. The schema is
the interesting part and it is readable as SQL.

## Next

In plan order: Google login and memberships, then port the booking surface for
one tenant, then consents to R2, then the operator app. The Phase 1 checkpoint
is Yetziron running on this stack as tenant #1 with no change she can notice.
