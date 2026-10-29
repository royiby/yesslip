# Yesslip

Multi-tenant registration, signed consent and Morning payments for small
businesses. A generic product built from the Yetziron registration server,
which stays untouched and single-tenant.

This file is the state of the code. The product plan is kept privately.

## Where this is up to

Phase 1 of the plan, part way. The multi-tenant foundation, Google login and the
parent-facing booking surface are in and tested. The operator app is next.

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
| Program config | `src/programs/camp.js`, `store.js` | Days, prices and consent wording per tenant, with history and a working undo. |
| Pricing | `src/pricing.js` | Daily and weekly tariffs, the weekly ceiling, the sibling discount. Pure. |
| Signed documents | `src/storage/`, `src/consent/` | Consents rendered self-contained and written once to S3-compatible object storage. |
| Registrations | `src/store/registrations.js` | Capacity, orders, attendance. The oversell race is closed. |
| The booking page | `src/booking/` | `/b/:slug`: pick days, sign, pay. One vanilla script, no build step. |
| Branding | `src/lib/palette.js` | Each business's two colours, with the text colour on top computed, not chosen. |

**Not started:** the operator app, contracts, cancellations and refunds, live
config editing from a screen, the Sheets mirror, billing.

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

**3. A booking page has no session at all.** `/b/:slug` and `/webhooks` are
reached by parents with a link, not an account. The tenant comes from the path;
nothing else decides which business a request acts on. That makes those two the
places to look hardest, and why the week ids, the consent key and the webhook
secret are all resolved per tenant rather than trusted from the request.

**4. A session says who, never what.** The cookie carries a user id and an
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

Signed consents go to any S3-compatible bucket (Cloudflare R2, Backblaze B2,
MinIO, S3). With `OBJECT_STORE_*` unset they are held in memory and lost on
restart, which the boot log says out loud. See `.env.example`.

`npm run db:psql` opens a shell on the dev database. `npm start` runs the
server. A tenant's booking page is at `/b/<slug>`, and it needs a program
config and a connected Morning account before it will take a booking.

## Tests

220 tests, all passing. They need the database up and migrated, and they do not
mock it, because much of what is under test is the database's own enforcement.
Morning and the object store are stubbed at the network boundary rather than by
swapping a module, so the real client code runs.

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
| `test/pricing.test.js` | Four days never cost more than five; the sibling discount skips the first child; the invoice lines add up to what is charged. |
| `test/camp.test.js` | A weekly price that is not a discount is refused; a date not on the calendar is refused; editing a price does not change `termsVersion` and editing a term does. |
| `test/programs.test.js` | An invalid edit does not replace the live config; undo walks back through saves rather than toggling the last two; one tenant cannot read another's program. |
| `test/registrations.test.js` | Two simultaneous bookings cannot both take the last seat; an abandoned link releases its seats; a redelivered callback does not double-write attendance; a patch cannot touch `tenant_id`. |
| `test/objects.test.js` | A document is written once; a key cannot climb out of its tenant prefix; `If-None-Match: *` is on the wire; a 412 is already-signed and a 403 is not. |
| `test/consent.test.js` | A renamed payload is not a PNG; the document carries the terms version and the IP and fetches nothing; signing twice is refused; two tenants can hold the same order id. |
| `test/booking-routes.test.js` | Another business's week id does not exist here; the webhook refuses a wrong secret and another tenant's secret; the rate limit is per business; a business with no Morning account cannot take a signature. |
| `test/palette.test.js` | Every hue clears WCAG AA on its own button, including the ones that need the brand colour darkened to get there. |

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

**Capacity is checked inside the transaction, under a per-tenant advisory
lock.** The original read the sheet to count seats, then appended rows, with a
Google Sheets round trip in between; two parents could both be sold the last
seat, and registration opens at a published time with everybody arriving at
once. The count and the insert are now one transaction, serialised per tenant
so one business's rush does not queue behind another's. The test for this
originally passed for the wrong reason: connection-setup latency was
serialising the two bookings, so the lock was never exercised. With the pool
pre-warmed, removing the lock puts three children on a two-seat day on every
run, which is what the test now asserts.

**Signed documents are write-once, with three barriers rather than one claim.**
The original relied on `open(2)` with `O_EXCL`; a single flag was what stopped a
form being signed twice. The equivalent here is a conditional PUT
(`If-None-Match: *`), which S3 and R2 answer with 412. But a provider that
ignored the header would permit an overwrite and this code could not tell, so
the HEAD before it stays, and `consents` carries `UNIQUE (tenant_id, order_id)`
underneath both. Saying "it is immutable" would have been a claim the storage
layer cannot keep on its own.

**The document is written before the rows, and the payment link after both.**
A signed form with no registration is an orphan the retention sweep collects. A
registration with no form is a business holding money for something nobody
signed. Only one of those is recoverable, so the order is not an accident.

**The text colour on a tenant's brand is computed, not chosen.** A business
picks a colour because it matches their logo. Pale yellow is a reasonable brand
colour and a terrible button background for white text, so `src/lib/palette.js`
picks whichever of near-black and white has the better WCAG ratio. Some colours
cannot carry readable text at all: pure red is 4.00:1 against white and 4.55:1
against near-black, so neither clears AA for a button label, and the colour
itself is darkened along its own hue until one does. That overrides what the
business chose, so the palette reports `adjusted` and a settings screen can say
so.

**The tenant is a path prefix, not a subdomain.** `/b/:slug` needs one
certificate. A subdomain needs a wildcard certificate, a wildcard DNS record
and, for custom domains, Cloudflare for SaaS. Nothing below the router knows how
the tenant was resolved, so it can become a subdomain later without touching the
booking code.

**Express 4, matching the source.** Express 5 changed path syntax and query
handling; porting 1000+ lines of existing routes onto it while also making them
multi-tenant is two risky changes at once. The upgrade is its own task.

**No ORM, and no auth library.** Raw SQL with `pg`, and the OIDC flow written
out. The plan had named `better-auth`, and it would have been a reasonable
choice, but what was actually needed here was one provider, a signed cookie and
a memberships table, against a codebase whose whole character is four
dependencies and no framework.

## Next

The operator app, then contracts and cancellations. The Phase 1 checkpoint is
Yetziron running on this stack as tenant #1 with no change she can notice.
