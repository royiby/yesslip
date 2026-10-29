# Yesslip

Multi-tenant registration, signed consent and Morning payments for small
businesses. A generic product built from the Yetziron registration server,
which stays untouched and single-tenant.

This file is the state of the code. The product plan is kept privately.

## Where this is up to

Phase 1 of the plan, part way. The multi-tenant foundation and Google login are
in and tested; no customer-facing surface has been ported yet.

| Piece | File | What it settles |
|---|---|---|
| Tenant-scoped schema | `migrations/001_init.sql` | 8 tenant tables with row-level security FORCEd, the 7 Google Sheets tabs ported to tables, plus platform tables. |
| Tenant-scoped data access | `src/db/index.js` | `withTenant()` is the only way to reach a tenant table. Deny by default: no tenant set reads empty. |
| Envelope encryption | `src/crypto/secrets.js` | Per-tenant data key under a master key. Ciphertext bound to tenant and field, so it cannot be moved between either. |
| Tenants and credentials | `src/tenants/store.js` | Tenant CRUD, Morning credentials in, decryption isolated to one named function. |
| Morning client, per tenant | `src/morning/client.js` | A factory with its token cache in the closure. Full API surface ported. |
| Client resolution | `src/morning/index.js` | `morningFor(tenantId)`, and the onboarding check that discovers the Grow clearing. |
| Google sign-in | `src/auth/google.js` | OIDC authorization code flow with PKCE, and real RS256 verification of the ID token. |
| Sessions | `src/auth/session.js` | Signed cookies. No sessions table; see below. |
| Users, roles, invitations | `src/auth/store.js` | Memberships as the authorisation, invitations stored as hashes. |
| Guards and routes | `src/auth/routes.js` | `requireUser`, `requireTenant({ role })`, and the login round trip. |

**Not started:** the booking page, the operator app, contracts, consents to R2,
live config editing, the Sheets mirror, branding, billing.

## Three things worth knowing before reading the code

**1. The app is not the database owner.** It connects as `yesslip_app`.
Row-level security does not constrain a table's owner unless it is FORCEd, so
both are done: the policies are forced, and the app is not the owner. A test
suite connected as the owner would pass while production leaked, so
`test/isolation.test.js` runs as the app role.

**2. There is no module-level mutable state in the Morning client.** The
single-tenant original cached its access token in a module `let`, which in a
process serving two businesses means whichever tenant authenticated first
supplies the token for every later call: one business reading another's
invoices, with every response looking valid. A `let` at module scope in
`src/morning/client.js` reintroduces that bug.

**3. A session says who, never what.** The cookie carries a user id and an
issue time. Which businesses that user may act for, and in what role, is read
from `memberships` on every request. The cost is one indexed read; the benefit
is that "remove this person from my business" takes effect on their next click
with no session to expire. `users.sessions_valid_from` covers the case a
membership change does not, a stolen device, and is the only reason a sessions
table is not needed.

## Running it

Needs Docker for Postgres, and Node 22 or newer.

```bash
npm install
npm run db:up          # Postgres 18 in Docker on :5433
cp .env.example .env
npm run keygen         # once for SECRETS_MASTER_KEY, again for SESSION_SECRET
npm run migrate
npm test
```

Google login additionally needs an OAuth client (console.cloud.google.com,
APIs & Services, Credentials, Web application) with
`<PUBLIC_BASE_URL>/auth/google/callback` as an authorised redirect URI, and
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` set. The tests do not need it.

`npm run db:psql` opens a shell on the dev database. `npm start` runs the
server; only `/auth/*` and `/health` exist so far.

## Tests

111 tests, all passing. They need the database up and migrated, and they do not
mock it, because much of what is under test is the database's own enforcement.

| File | Proves |
|---|---|
| `test/isolation.test.js` | Two tenants cannot see, write, update or delete each other. No tenant set reads empty. The tenant setting does not survive onto a pooled connection. `cancellations` cannot be rewritten. |
| `test/secrets.test.js` | Round trips; a ciphertext read as another tenant, another field, or with another key fails; tampering fails; master-key rotation works. |
| `test/morning-client.test.js` | Two tenants never share a token; a 401 clears only the client that saw it; `notifyUrl` and `pluginId` are per tenant; a standing order sends `documentVatType` 0. |
| `test/tenants.test.js` | Credentials round trip; the database holds no plaintext secret; a ciphertext moved between tenant rows fails; the settings-screen object carries no secret. |
| `test/auth-google.test.js` | Tokens signed with a real local RSA key: a swapped payload, another signer, `alg: none`, the wrong audience or issuer, expiry, a replayed nonce and an unverified email are each refused. Key rotation recovers in one refetch. |
| `test/auth-session.test.js` | A re-encoded payload with the original signature is refused; expiry lives inside the signed payload, not in `Max-Age`; `Secure` only on https; cookie parsing is not a prefix match. |
| `test/auth-store.test.js` | The Google subject is the identity, not the email; the last owner cannot be removed or demoted; invitations are single-use, replaceable, expiring, and stored only as hashes. |
| `test/auth-routes.test.js` | Open redirects are refused, including `//host` and backslash forms; the callback requires a matching state; a non-member gets 404 and a member without the role gets 403. |

## Decisions already made, and why

**Postgres is the system of record, not Google Sheets.** Sheets allows 300
writes a minute per project, shared across every tenant. Camp registration
opens at 20:00 and two hundred parents arrive in ten minutes, so one tenant's
rush would 429 everybody else's. Sheets returns later as an opt-in async
mirror, because handing an accountant the `cancellations` tab is worth keeping.

**`cancellations` is append-only in the database, not by convention.** 001 gave
it no UPDATE or DELETE policy, assuming RLS would refuse both. It does not: for
UPDATE and DELETE, RLS is a filter, so a default-deny matches zero rows and
reports success. `003` revokes the privileges instead, which turns a silent
no-op into an immediate error. A test caught this.

**`sessions_valid_from` defaults to the epoch, not `now()`.** The cookie's
issue time comes from the app's clock and that column from the database's, and
the row is written a few milliseconds after the cookie is minted, so `now()`
left a new user's cutoff slightly ahead of their own first cookie. Measured at
~19ms locally; in production the clocks are on different machines. `005`
removes the cross-clock comparison at account creation rather than adding a
tolerance, which would have weakened the sign-out it exists for. A test caught
this too.

**The ID token's signature is verified even though the spec allows skipping
it.** OpenID Connect Core 3.1.3.7 lets a confidential client trust a token
received directly from the token endpoint over TLS. Thirty lines is cheap at
the one boundary where being wrong means signing in as somebody else, and it
also catches a misconfigured token endpoint.

**Express 4, matching the source.** Express 5 changed path syntax and query
handling; porting 1000+ lines of existing routes onto it while also making them
multi-tenant is two risky changes at once. The upgrade is its own task.

**No ORM, and no auth library.** Raw SQL with `pg`, and the OIDC flow written
out. The plan had named `better-auth`, and it would have been a reasonable
choice, but what was actually needed here was one provider, a signed cookie and
a memberships table, against a codebase whose whole character is four
dependencies and no framework.

## Next

Port the booking surface for one tenant, then consents to R2, then the operator
app. The Phase 1 checkpoint is Yetziron running on this stack as tenant #1 with
no change she can notice.
