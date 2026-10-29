-- Yesslip: multi-tenant core.
--
-- Two kinds of table live here.
--
--   Platform tables (tenants, users, memberships, tenant_connections) are keyed
--   by nothing but themselves and are read by the app's own code paths.
--
--   Tenant tables (registrations, attendance, consents, contracts,
--   cancellations, subscriptions, program_configs) all carry tenant_id and all
--   have row-level security forced on. A query that forgets its WHERE clause
--   returns nothing instead of returning another business's parents.
--
-- The tenant is carried in the `app.tenant_id` session setting, which
-- src/db/index.js sets with SET LOCAL inside a transaction. When it is unset,
-- app_current_tenant() is NULL, every policy expression evaluates to NULL
-- rather than true, and every tenant table reads as empty. Deny by default is
-- the point: forgetting to set the tenant must fail closed, not fail open.

-- ─────────────────────────── roles ───────────────────────────
--
-- The app does NOT connect as the owner. A table's owner bypasses row-level
-- security unless it is FORCEd, and relying on one ALTER having been run on
-- every table is a thinner wall than simply not being the owner. We do both.
--
-- In production this block is a one-time DBA step; it lives here so that a
-- development database is one command away.

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yesslip_app') THEN
    CREATE ROLE yesslip_app LOGIN PASSWORD 'yesslip_app';
  END IF;
END
$role$;

GRANT USAGE ON SCHEMA public TO yesslip_app;

-- ─────────────────────────── helpers ───────────────────────────

-- NULL when unset, so a policy comparing against it denies rather than allows.
-- nullif() guards the empty string, which would otherwise raise on the cast and
-- turn a missing tenant into a 500 instead of an empty result.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $fn$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $fn$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$;

-- ─────────────────────────── platform ───────────────────────────

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'onboarding'
                    CHECK (status IN ('onboarding', 'active', 'suspended', 'cancelled')),

  -- Branding. Colors are validated in the application against a strict hex
  -- pattern before they ever reach here, and this constraint is the second
  -- wall: these values are interpolated into a CSS custom property, so
  -- anything that is not a hex color is a script-injection attempt.
  color_primary   text NOT NULL DEFAULT '#2563eb' CHECK (color_primary ~ '^#[0-9a-fA-F]{6}$'),
  color_accent    text NOT NULL DEFAULT '#f59e0b' CHECK (color_accent  ~ '^#[0-9a-fA-F]{6}$'),
  logo_key        text,  -- object key in R2, never a caller-supplied URL

  timezone        text NOT NULL DEFAULT 'Asia/Jerusalem',
  currency        text NOT NULL DEFAULT 'ILS',
  locale          text NOT NULL DEFAULT 'he',

  -- The tenant's data key, itself encrypted with SECRETS_MASTER_KEY. Every
  -- secret belonging to this tenant is encrypted with this key and not with
  -- the master directly, so the master can be rotated by rewrapping one small
  -- column per tenant instead of re-encrypting every secret.
  dek_wrapped     bytea NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub  text NOT NULL UNIQUE,   -- the stable Google subject, not the email
  email       text NOT NULL,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Email is not the identity (people change them, and Google reuses nothing but
-- `sub`), but it is how an invitation is addressed, so it is looked up.
CREATE INDEX users_email_idx ON users (lower(email));

CREATE TABLE memberships (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'staff')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);

-- One row per external account a tenant has connected. Today that is Morning;
-- the shape is deliberately provider-agnostic so a second provider does not
-- need a migration.
--
-- Both Morning paths end here identically: a key id and secret that we hold on
-- the tenant's behalf. Whether the tenant pasted them or a partner callback
-- delivered them changes `obtained_via` and nothing else, which is what makes
-- the partner program an onboarding upgrade rather than a rewrite.
CREATE TABLE tenant_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'morning' CHECK (provider IN ('morning')),
  environment      text NOT NULL DEFAULT 'production' CHECK (environment IN ('sandbox', 'production')),

  -- Encrypted with the tenant's data key. Self-describing blobs; see
  -- src/crypto/secrets.js for the layout. Never selected into a response.
  key_id_enc       bytea NOT NULL,
  key_secret_enc   bytea NOT NULL,
  webhook_secret_enc bytea NOT NULL,

  obtained_via     text NOT NULL DEFAULT 'pasted' CHECK (obtained_via IN ('pasted', 'partner')),

  -- Discovered from Morning, not asked of the tenant.
  plugin_id        text,
  document_type    int NOT NULL DEFAULT 320,
  business_name    text,

  status           text NOT NULL DEFAULT 'unverified'
                     CHECK (status IN ('unverified', 'verified', 'failed', 'revoked')),
  last_error       text,
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, provider)
);

-- ─────────────────────────── tenant data ───────────────────────────

-- Replaces camp.json / tzaharon.json on a persistent disk. Same contents, same
-- validate-before-write discipline in the application; what changes is that it
-- survives without a volume and can be read by more than one process.
CREATE TABLE program_configs (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('camp', 'tzaharon')),
  config      jsonb NOT NULL,
  -- Hash of the terms text, as termsVersion is today: a signature records the
  -- version the parent actually saw, so editing the text later cannot
  -- retroactively change what anyone agreed to.
  terms_version text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id),
  PRIMARY KEY (tenant_id, kind)
);

-- Backs the "undo last change" button. The app keeps the most recent few.
CREATE TABLE program_config_history (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  config      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id)
);

CREATE INDEX program_config_history_idx
  ON program_config_history (tenant_id, kind, created_at DESC);

-- One row per child per order. The order is the unit of payment; the row is
-- the unit of attendance and of the invoice line.
CREATE TABLE registrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       text NOT NULL,
  row_id         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  phone          text,
  parent_name    text,
  parent_email   text,
  child_name     text,
  child_grade    text,

  week_id        text,
  days           date[] NOT NULL DEFAULT '{}',
  day_count      int NOT NULL DEFAULT 0,
  pricing_mode   text,

  list_amount    numeric(10,2),
  discount       numeric(10,2),
  amount         numeric(10,2),
  currency       text NOT NULL DEFAULT 'ILS',

  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'paid', 'cancelled', 'expired')),
  paid_at        timestamptz,
  payment_url    text,
  transaction_id text,
  doc_number     text,
  doc_url        text,
  notes          text,

  UNIQUE (tenant_id, order_id, row_id)
);

CREATE INDEX registrations_status_idx  ON registrations (tenant_id, status);
CREATE INDEX registrations_created_idx ON registrations (tenant_id, created_at DESC);
-- The soft reservation sweep looks for pending rows past their hold window.
CREATE INDEX registrations_pending_idx ON registrations (tenant_id, created_at)
  WHERE status = 'pending';
-- A webhook arrives knowing only Morning's transaction.
CREATE INDEX registrations_txn_idx ON registrations (tenant_id, transaction_id)
  WHERE transaction_id IS NOT NULL;

-- One row per child per PAID day. Derived, and rebuilt rather than patched.
CREATE TABLE attendance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  registration_id uuid REFERENCES registrations(id) ON DELETE CASCADE,
  date            date NOT NULL,
  child_name      text,
  child_grade     text,
  parent_name     text,
  phone           text,
  order_id        text,
  status          text NOT NULL DEFAULT 'expected',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attendance_day_idx ON attendance (tenant_id, date);

-- The evidence row for a signed form. The document itself is an object in R2;
-- this is what makes it findable and what an audit reads.
CREATE TABLE consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id           text NOT NULL,
  signed_at          timestamptz NOT NULL DEFAULT now(),
  signer_name        text,
  signer_id          text,
  phone              text,
  email              text,
  children           text,
  terms_version      text,
  health_declaration boolean,
  photo_consent      boolean,
  ip                 inet,
  user_agent         text,
  -- R2 object key. Not a URL: the URL is minted on demand and expires.
  archive_key        text,
  -- Set when retention removes the bytes. The evidence row outlives the
  -- document on purpose, so the record of a signature having existed is not
  -- erased along with it.
  destroyed_at       timestamptz,
  UNIQUE (tenant_id, order_id)
);

CREATE INDEX consents_signed_idx ON consents (tenant_id, signed_at DESC);

CREATE TABLE contracts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contract_id      text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  template_id      text,
  template_title   text,
  template_version text,
  client_name      text,
  phone            text,
  email            text,
  amount           numeric(10,2),
  currency         text NOT NULL DEFAULT 'ILS',
  status           text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'signed', 'cancelled')),
  signed_at        timestamptz,
  ip               inet,
  user_agent       text,
  fields           jsonb NOT NULL DEFAULT '{}',
  document_key     text,
  payment_url      text,
  notes            text,
  UNIQUE (tenant_id, contract_id)
);

CREATE INDEX contracts_status_idx ON contracts (tenant_id, status, created_at DESC);

-- Append-only, and enforced as such below: there is no UPDATE or DELETE policy
-- on this table, so the app role cannot rewrite history even by accident. This
-- is the tab an accountant asks for.
CREATE TABLE cancellations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  order_id            text NOT NULL,
  event               text NOT NULL CHECK (event IN ('cancelled', 'refund_confirmed')),
  actor               text,
  parent_name         text,
  phone               text,
  children            text,
  days                text,
  order_total         numeric(10,2),
  currency            text NOT NULL DEFAULT 'ILS',
  computed_refund     numeric(10,2),
  computed_percent    numeric(5,2),
  refund_amount       numeric(10,2),
  override_reason     text,
  policy_hours        int,
  policy_late_percent numeric(5,2),
  method              text,
  doc_number          text,
  doc_url             text,
  attendance_removed  boolean,
  notes               text
);

CREATE INDEX cancellations_order_idx ON cancellations (tenant_id, order_id, created_at);

-- The צהרון: fixed weekdays, a start month, and a standing order at Morning
-- that charges a saved card every month. Its own table rather than more
-- columns on registrations, because almost nothing matches and the lifetimes
-- differ by most of a year.
CREATE TABLE subscriptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sub_id              text NOT NULL,
  row_id              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  season              text,

  phone               text,
  parent_name         text,
  parent_email        text,
  child_name          text,
  child_grade         text,

  group_id            text,
  group_label         text,
  weekdays            int[] NOT NULL DEFAULT '{}',
  day_count           int NOT NULL DEFAULT 0,
  pricing_mode        text,

  monthly_list_amount numeric(10,2),
  monthly_discount    numeric(10,2),
  monthly_amount      numeric(10,2),
  currency            text NOT NULL DEFAULT 'ILS',

  start_month         text,
  end_month           text,
  month_count         int,
  total_commitment    numeric(10,2),

  status              text NOT NULL DEFAULT 'pending_card'
                        CHECK (status IN ('pending_card', 'active', 'cancelled', 'expired')),
  card_link_url       text,
  card_token_id       text,
  recurring_id        text,
  activated_at        timestamptz,
  cancelled_at        timestamptz,
  notes               text,

  UNIQUE (tenant_id, sub_id, row_id)
);

CREATE INDEX subscriptions_status_idx ON subscriptions (tenant_id, status);
-- The watchdog turns a saved card into a live standing order; it scans these.
CREATE INDEX subscriptions_pending_idx ON subscriptions (tenant_id, created_at)
  WHERE status = 'pending_card';

-- ─────────────────────────── updated_at triggers ───────────────────────────

CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER tenant_connections_touch BEFORE UPDATE ON tenant_connections
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER program_configs_touch BEFORE UPDATE ON program_configs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ─────────────────────────── row-level security ───────────────────────────
--
-- FORCE, not just ENABLE: ENABLE leaves the table owner exempt, and the owner
-- is who runs migrations and who a misconfigured DATABASE_URL would connect
-- as. Forcing it means the isolation holds even then.

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'registrations', 'attendance', 'consents', 'contracts',
    'cancellations', 'subscriptions', 'program_configs', 'program_config_history'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- Read and write are the same predicate. WITH CHECK is what stops a tenant
    -- from inserting a row stamped with somebody else's tenant_id, which USING
    -- alone would happily allow.
    EXECUTE format(
      'CREATE POLICY tenant_select ON %I FOR SELECT USING (tenant_id = app_current_tenant())', t);
    EXECUTE format(
      'CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (tenant_id = app_current_tenant())', t);

    -- cancellations is an append-only ledger: no UPDATE or DELETE policy, so
    -- both are denied for the app role. See the table comment.
    IF t <> 'cancellations' THEN
      EXECUTE format(
        'CREATE POLICY tenant_update ON %I FOR UPDATE USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
      EXECUTE format(
        'CREATE POLICY tenant_delete ON %I FOR DELETE USING (tenant_id = app_current_tenant())', t);
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO yesslip_app', t);
  END LOOP;
END
$rls$;

-- Platform tables: no RLS, because they are how the app finds out which tenant
-- it is serving in the first place. Guarded by the application instead.
GRANT SELECT, INSERT, UPDATE         ON tenants            TO yesslip_app;
GRANT SELECT, INSERT, UPDATE         ON users              TO yesslip_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships        TO yesslip_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_connections TO yesslip_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO yesslip_app;
