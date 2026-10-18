// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

import type { Pool } from 'pg'
import { randomBytes } from 'node:crypto'

/**
 * Auth substrate (see docs/auth-setup.md): users, orgs,
 * org_members, org_invites, auth_epochs, audit_log.
 *
 * Everything here is additive and idempotent — `ensureAuthSchema` runs at
 * server boot unconditionally (same pattern as `initSchema` in `db.ts`),
 * whatever the `AUTH` stage. See docs/auth-setup.md for the full env var /
 * rollout reference.
 */

function newId(): string {
  return randomBytes(12).toString('base64url')
}

/**
 * Create (if missing) every auth table plus the append-only enforcement on
 * `audit_log`. Safe to call on every boot: every statement is
 * `IF NOT EXISTS` / `CREATE OR REPLACE` so re-running changes nothing once
 * the schema is up to date.
 */
export async function ensureAuthSchema(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Principals. `UNIQUE(issuer, subject)` is the real identity key — the
    // same email can legitimately show up under multiple issuers (dev login,
    // Google, Entra) as SEPARATE identities, so email is intentionally NOT
    // unique here; invite acceptance matches by email at the membership
    // layer instead (see docs/auth-setup.md "Identity model").
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                 TEXT PRIMARY KEY,
        issuer             TEXT NOT NULL,
        subject            TEXT NOT NULL,
        email              TEXT NOT NULL,
        name               TEXT,
        is_platform_admin  BOOLEAN NOT NULL DEFAULT false,
        status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (issuer, subject)
      )
    `)
    // Non-unique: lets us find "does this email already exist under some
    // issuer" (invite prefill / support lookups) without claiming uniqueness
    // we don't have. lower() so lookups are case-insensitive without citext.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email))
    `)

    // Local email/password identities. Password material is kept outside the
    // principal row so OIDC-only users never acquire an empty credential.
    // `password_hash` contains a versioned scrypt envelope (never plaintext).
    await client.query(`
      CREATE TABLE IF NOT EXISTS local_auth_credentials (
        user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        password_hash       TEXT NOT NULL,
        email_verified_at   TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    // Verification links carry a random token; only its SHA-256 digest is
    // durable. Tokens are single-use and expire after 24 hours.
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verification_tokens (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   TEXT NOT NULL UNIQUE,
        expires_at   TIMESTAMPTZ NOT NULL,
        consumed_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user
      ON email_verification_tokens (user_id, created_at DESC)
    `)

    // Split name parts (given/family) live beside the IdP-owned display
    // `name`: they're filled from OIDC claims on first sight but afterwards
    // belong to the USER (PATCH /api/me) — findOrCreateUser only ever fills
    // them when NULL, never overwrites. `last_org_id` remembers the org the
    // user was last pinned to so multi-org logins land where they left off.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS given_name TEXT`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS family_name TEXT`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_org_id TEXT`)
    // UI language preference ('en' | 'fr'), user-owned via PATCH /api/me. NULL =
    // follow the browser (client-side detection); applied cross-device once the
    // session resolves. See src/lib/i18n.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT`)
    // Versioned clickwrap evidence. Privacy is acknowledged rather than used
    // as a blanket consent: processing still needs its own lawful basis.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_version TEXT`)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_acknowledged_at TIMESTAMPTZ`)

    await client.query(`
      CREATE TABLE IF NOT EXISTS orgs (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        slug               TEXT NOT NULL UNIQUE,
        sso_email_domains  TEXT[] NOT NULL DEFAULT '{}',
        status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    // Org-admin-editable settings bag (whitelisted key-by-key at the PATCH
    // endpoint — today only `inviteTtlHours`). `default_landscape_id` is a
    // plain TEXT pointer (no FK: `landscapes` belongs to db.ts's initSchema
    // and boots independently); deletion repoints it in code.
    await client.query(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'`)
    await client.query(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS default_landscape_id TEXT`)

    // Global operator-owned settings. The JSONB bag is intentionally a
    // singleton so future platform settings can be added through a strict
    // endpoint whitelist without a schema migration per preference.
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        id          TEXT PRIMARY KEY CHECK (id = 'global'),
        settings    JSONB NOT NULL DEFAULT '{}',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by  TEXT
      )
    `)
    await client.query(`
      INSERT INTO platform_settings (id, settings)
      VALUES ('global', '{"requireIndependentTechnologyReview": true}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `)

    // Org role is per-membership row — deliberately distinct from
    // `users.is_platform_admin`, which is an operator flag with no org.
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_members (
        org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, user_id)
      )
    `)

    // `token_hash` (never the raw token) is what's stored — the mailed link
    // carries the raw token, the server only ever compares hashes. Unique so
    // a hash collision (practically impossible, sha256) can't silently
    // resolve to the wrong invite.
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_invites (
        id           TEXT PRIMARY KEY,
        org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        email        TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        token_hash   TEXT NOT NULL UNIQUE,
        expires_at   TIMESTAMPTZ NOT NULL,
        created_by   TEXT NOT NULL,
        accepted_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invites (org_id, created_at DESC)
    `)

    // One row per org; bumping `epoch` invalidates every session minted
    // before the bump. Checked at the sync upgrade (sessionEpoch.ts), on live
    // sockets (wsAuth.ts startEpochRevocation) and by GET /api/auth/me — NOT by
    // the HTTP middleware. No row yet = epoch 1 implicitly. Reserved for
    // org-wide events (a suspension); a change to one user's access bumps
    // `auth_user_epochs` below instead.
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_epochs (
        org_id  TEXT PRIMARY KEY,
        epoch   BIGINT NOT NULL DEFAULT 1
      )
    `)

    // One row per (org, user) whose access in that org was ever REDUCED;
    // pinned in the session as `uepoch` and checked wherever `epoch` is.
    // Without it, demoting one member revoked every session in the org — the
    // admin who did it included (measured 2026-10-16). No row = epoch 1. No
    // foreign keys, like auth_epochs: a row outliving its member is harmless,
    // and it must outlive a DELETE of the membership it revokes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_user_epochs (
        org_id   TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        epoch    BIGINT NOT NULL DEFAULT 1,
        PRIMARY KEY (org_id, user_id)
      )
    `)

    // One row per user who ever lost platform admin or was deactivated
    // (trg_epoch_users, wsAuth.ts ensureEpochTriggers); pinned in the session
    // as `gepoch` and checked wherever `epoch` is, plus on cookie-authenticated
    // HTTP. It reaches what the two tables above cannot: an org-less session,
    // one pinned to an org the user has left, and the signed `isPlatformAdmin`
    // claim the sync gate trusts across every org. A table, not a column on
    // `users`: no ALTER of `users` at boot. No row = epoch 1, no foreign key —
    // it must outlive a deleted user.
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_global_epochs (
        user_id  TEXT PRIMARY KEY,
        epoch    BIGINT NOT NULL DEFAULT 1
      )
    `)

    // Append-only audit trail. `org_id` is nullable for platform-level
    // events (org create/suspend, platform-admin grants) that have no single
    // owning org. `detail` is arbitrary JSON context for the action.
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id                     BIGSERIAL PRIMARY KEY,
        at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
        org_id                 TEXT,
        actor_user_id          TEXT NOT NULL,
        impersonator_user_id   TEXT,
        action                 TEXT NOT NULL,
        target_kind            TEXT NOT NULL,
        target_id              TEXT NOT NULL,
        detail                 JSONB
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_log_org_at ON audit_log (org_id, at DESC)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_log_org_target_id
      ON audit_log (org_id, target_kind, target_id, id DESC)
    `)

    // Active/historical impersonation sessions (platform admin console).
    // One row per POST /api/platform/impersonate; `ended_at` is set by
    // either the normal exit flow or a platform admin's force-stop DELETE.
    // Nullable `ended_at` is the "active" filter (`?active=1` on the list
    // endpoint); no FKs to `users` with ON DELETE CASCADE since this is an
    // audit-adjacent history table — a deleted user's past impersonations
    // should still be visible, not silently vanish.
    await client.query(`
      CREATE TABLE IF NOT EXISTS impersonations (
        id              TEXT PRIMARY KEY,
        admin_user_id   TEXT NOT NULL,
        target_user_id  TEXT NOT NULL,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at        TIMESTAMPTZ
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_impersonations_active ON impersonations (ended_at) WHERE ended_at IS NULL
    `)

    // Append-only enforcement, belt + suspenders: REVOKE the privilege (so a
    // future `GRANT ALL` on the role doesn't silently reopen it) AND a
    // trigger that raises on UPDATE/DELETE regardless of role privileges —
    // covers the case where the connecting role already had UPDATE/DELETE
    // granted broadly (e.g. via a schema-wide GRANT) before this ran.
    await client.query(`REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC`)
    await client.query(`
      CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log`)
    await client.query(`
      CREATE TRIGGER audit_log_no_update_delete
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()
    `)

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Idempotent upsert of the 'default' org (name "Default Organization"),
 * returning its id. Resources created before auth was enabled backfill into
 * this org so nothing becomes unreachable under RLS.
 */
export async function ensureDefaultOrg(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM orgs WHERE slug = $1', ['default'])
  if (rows.length > 0) return rows[0].id

  const id = newId()
  const { rows: inserted } = await pool.query<{ id: string }>(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, 'default')
     ON CONFLICT (slug) DO NOTHING
     RETURNING id`,
    [id, 'Default Organization']
  )
  if (inserted.length > 0) return inserted[0].id

  // Lost the race against a concurrent booting instance — re-read.
  const { rows: existing } = await pool.query<{ id: string }>('SELECT id FROM orgs WHERE slug = $1', ['default'])
  return existing[0].id
}
