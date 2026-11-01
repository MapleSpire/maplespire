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
 * RBAC schema: teams, scopes +
 * closure table, team grants, and the denormalized per-user effective
 * permissions table that both RLS policies (future) and the API (today, via
 * `access.ts`) read.
 *
 * A closure-table design (`scopes`/`scope_ancestors`) where the matrix
 * grantee is a **team** (not a user) — `user_effective_permissions` is the
 * denormalized union of a user's teams' grants, kept current by triggers
 * instead of computed per-query.
 *
 * Everything here is additive and idempotent — `ensureRbacSchema` runs at
 * server boot unconditionally, same as `ensureAuthSchema` in `../auth/schema.ts`.
 * No RLS policies are defined on resource tables here.
 */

function newId(): string {
  return randomBytes(12).toString('base64url')
}

/**
 * Create (if missing) every RBAC table, trigger, and the
 * `recompute_user_effective_permission` / `rbac_effective_access` functions.
 * Safe to call on every boot: every statement is `IF NOT EXISTS` / `CREATE OR
 * REPLACE` / guarded `DO` block, so re-running changes nothing once the
 * schema is up to date. Assumes `../auth/schema.ts`'s `ensureAuthSchema` has
 * already run (teams/scopes reference `orgs`/`users`).
 */
export async function ensureRbacSchema(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // ---------------------------------------------------------------
    // Teams — the principal side of a grant (who).
    // ---------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id           TEXT PRIMARY KEY,
        org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        archived_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_teams_org ON teams (org_id)
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        team_id  TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (team_id, user_id)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id)
    `)

    // Pre-assigned team memberships on a PENDING invite: the
    // admin configures the invitee's teams while the invite is outstanding;
    // acceptance copies these into team_members atomically with the org
    // membership. Lives here (not auth/schema.ts) because the teams FK does.
    await client.query(`
      CREATE TABLE IF NOT EXISTS invite_teams (
        invite_id  TEXT NOT NULL REFERENCES org_invites(id) ON DELETE CASCADE,
        team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        PRIMARY KEY (invite_id, team_id)
      )
    `)

    // ---------------------------------------------------------------
    // Scopes — the resource side of a grant (what): org -> landscape ->
    // version -> domain. `UNIQUE(org_id, kind, landscape_id, version_id,
    // domain_id)` is the idempotency key the upsert helpers below key off —
    // NULLs compare distinct in Postgres uniqueness, but every kind fixes
    // which of landscape/version/domain are non-null, so collisions across
    // kinds can't happen in practice.
    // ---------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS scopes (
        id           TEXT PRIMARY KEY,
        org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL CHECK (kind IN ('org', 'landscape', 'version', 'domain')),
        parent_id    TEXT REFERENCES scopes(id),
        landscape_id TEXT,
        version_id   TEXT,
        domain_id    TEXT,
        deleted_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (org_id, kind, landscape_id, version_id, domain_id)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scopes_org ON scopes (org_id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scopes_parent ON scopes (parent_id)
    `)

    // Each API/sync-cell process keeps a short-lived allowed-workspace cache.
    // A scope created on one process must invalidate negative entries on every
    // other process immediately; otherwise a freshly created workspace can
    // return a transient 403 until the remote cache TTL expires. PostgreSQL
    // NOTIFY is transactional, so listeners only observe committed scopes.
    await client.query(`
      CREATE OR REPLACE FUNCTION notify_workspace_access_changed() RETURNS trigger AS $$
      DECLARE
        affected_org_id TEXT;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          affected_org_id := OLD.org_id;
        ELSE
          affected_org_id := NEW.org_id;
        END IF;
        PERFORM pg_notify('workspace_access_changed', affected_org_id);
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_workspace_access_changed ON scopes`)
    await client.query(`
      CREATE TRIGGER trg_workspace_access_changed
      AFTER INSERT OR UPDATE OR DELETE ON scopes
      FOR EACH ROW EXECUTE FUNCTION notify_workspace_access_changed()
    `)

    // `parent_id` is IMMUTABLE after insert: the closure table
    // (`scope_ancestors`) is built once at insert time from the parent's
    // ancestor rows (see the AFTER INSERT trigger below) and never
    // recomputed. Allowing a later `UPDATE scopes SET parent_id = …` would
    // silently desync the closure table from the tree — re-parenting a scope
    // is not supported (delete + reinsert if this is ever truly needed).
    await client.query(`
      CREATE OR REPLACE FUNCTION scopes_parent_immutable() RETURNS trigger AS $$
      BEGIN
        IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
          RAISE EXCEPTION 'scopes.parent_id is immutable after insert (scope %)', OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_scopes_parent_immutable ON scopes`)
    await client.query(`
      CREATE TRIGGER trg_scopes_parent_immutable
      BEFORE UPDATE ON scopes
      FOR EACH ROW EXECUTE FUNCTION scopes_parent_immutable()
    `)

    // ---------------------------------------------------------------
    // scope_ancestors — closure table, trigger-maintained: one self row
    // (depth 0) plus a copy of the parent's ancestor
    // rows at depth+1. Gives O(1) "is X an ancestor of Y" / "all ancestors of
    // Y" reads with no recursive CTE on the hot path.
    // ---------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS scope_ancestors (
        scope_id     TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        ancestor_id  TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        depth        INT NOT NULL CHECK (depth >= 0),
        PRIMARY KEY (scope_id, ancestor_id)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_scope_ancestors_ancestor ON scope_ancestors (ancestor_id)
    `)

    await client.query(`
      CREATE OR REPLACE FUNCTION maintain_scope_closure() RETURNS trigger AS $$
      BEGIN
        INSERT INTO scope_ancestors (scope_id, ancestor_id, depth)
        VALUES (NEW.id, NEW.id, 0)
        ON CONFLICT (scope_id, ancestor_id) DO NOTHING;
        IF NEW.parent_id IS NOT NULL THEN
          INSERT INTO scope_ancestors (scope_id, ancestor_id, depth)
          SELECT NEW.id, ancestor_id, depth + 1
          FROM scope_ancestors
          WHERE scope_id = NEW.parent_id
          ON CONFLICT (scope_id, ancestor_id) DO NOTHING;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_scope_closure ON scopes`)
    await client.query(`
      CREATE TRIGGER trg_scope_closure
      AFTER INSERT ON scopes
      FOR EACH ROW EXECUTE FUNCTION maintain_scope_closure()
    `)

    // ---------------------------------------------------------------
    // team_scope_permissions — the matrix: explicit
    // (team, scope, resource_type) rows. `resource_type` is currently the
    // literal '*' (whole workspace); finer resource types (e.g. 'flows',
    // 'comments') can be introduced later without a schema change since it's
    // already part of the key.
    // ---------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_scope_permissions (
        team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        scope_id      TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL DEFAULT '*',
        can_read      BOOLEAN NOT NULL,
        can_write     BOOLEAN NOT NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_by    TEXT,
        PRIMARY KEY (team_id, scope_id, resource_type),
        CHECK (can_read OR can_write)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_team_scope_permissions_scope ON team_scope_permissions (scope_id)
    `)

    // ---------------------------------------------------------------
    // user_effective_permissions — denormalized union of a user's teams'
    // grants for a given (scope, resource_type), maintained INCREMENTALLY.
    // RLS policies (future) and `access.ts` read only this table plus the
    // closure table: O(1) per row check, no join fan-out over teams at query
    // time.
    // ---------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_effective_permissions (
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope_id      TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        can_read      BOOLEAN NOT NULL,
        can_write     BOOLEAN NOT NULL,
        PRIMARY KEY (user_id, scope_id, resource_type)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_effective_permissions_scope ON user_effective_permissions (scope_id)
    `)

    // Shared recompute: bool_or across every team the user belongs to that
    // has a grant on (scope_id, resource_type). UPSERTs the union row, or
    // deletes it when the user has no grant left there (e.g. after their
    // last granting team-membership is removed). SECURITY DEFINER-free (it's
    // called from triggers within the same schema owner context) but kept as
    // a standalone fn so both trigger bodies below can share it verbatim.
    await client.query(`
      CREATE OR REPLACE FUNCTION recompute_user_effective_permission(
        p_user_id TEXT, p_scope_id TEXT, p_resource_type TEXT
      ) RETURNS void AS $$
      DECLARE
        v_can_read  BOOLEAN;
        v_can_write BOOLEAN;
      BEGIN
        SELECT bool_or(tsp.can_read), bool_or(tsp.can_write)
        INTO v_can_read, v_can_write
        FROM team_scope_permissions tsp
        JOIN team_members tm ON tm.team_id = tsp.team_id
        WHERE tm.user_id = p_user_id
          AND tsp.scope_id = p_scope_id
          AND tsp.resource_type = p_resource_type;

        IF v_can_read IS NULL AND v_can_write IS NULL THEN
          DELETE FROM user_effective_permissions
          WHERE user_id = p_user_id AND scope_id = p_scope_id AND resource_type = p_resource_type;
        ELSE
          INSERT INTO user_effective_permissions (user_id, scope_id, resource_type, can_read, can_write)
          VALUES (p_user_id, p_scope_id, p_resource_type, coalesce(v_can_read, false), coalesce(v_can_write, false))
          ON CONFLICT (user_id, scope_id, resource_type)
          DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write;
        END IF;
      END;
      $$ LANGUAGE plpgsql
    `)

    // Trigger 1: a grant changed (team_scope_permissions INSERT/UPDATE/DELETE)
    // -> recompute that (scope, resource_type) for every member of that team.
    await client.query(`
      CREATE OR REPLACE FUNCTION trg_team_scope_permissions_changed() RETURNS trigger AS $$
      DECLARE
        v_team_id TEXT := COALESCE(NEW.team_id, OLD.team_id);
        v_scope_id TEXT := COALESCE(NEW.scope_id, OLD.scope_id);
        v_resource_type TEXT := COALESCE(NEW.resource_type, OLD.resource_type);
        v_member RECORD;
      BEGIN
        FOR v_member IN SELECT user_id FROM team_members WHERE team_id = v_team_id LOOP
          PERFORM recompute_user_effective_permission(v_member.user_id, v_scope_id, v_resource_type);
        END LOOP;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_tsp_changed ON team_scope_permissions`)
    await client.query(`
      CREATE TRIGGER trg_tsp_changed
      AFTER INSERT OR UPDATE OR DELETE ON team_scope_permissions
      FOR EACH ROW EXECUTE FUNCTION trg_team_scope_permissions_changed()
    `)

    // Trigger 2: membership changed (team_members INSERT/DELETE) -> recompute
    // every grant of that team for that one user.
    await client.query(`
      CREATE OR REPLACE FUNCTION trg_team_members_changed() RETURNS trigger AS $$
      DECLARE
        v_team_id TEXT := COALESCE(NEW.team_id, OLD.team_id);
        v_user_id TEXT := COALESCE(NEW.user_id, OLD.user_id);
        v_grant RECORD;
      BEGIN
        FOR v_grant IN
          SELECT DISTINCT scope_id, resource_type FROM team_scope_permissions WHERE team_id = v_team_id
        LOOP
          PERFORM recompute_user_effective_permission(v_user_id, v_grant.scope_id, v_grant.resource_type);
        END LOOP;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query(`DROP TRIGGER IF EXISTS trg_team_members_changed ON team_members`)
    await client.query(`
      CREATE TRIGGER trg_team_members_changed
      AFTER INSERT OR DELETE ON team_members
      FOR EACH ROW EXECUTE FUNCTION trg_team_members_changed()
    `)

    // ---------------------------------------------------------------
    // lock_permission_writes — ONE transaction-scoped lock serializing every
    // permission write (org_members, team_members, team_scope_permissions, and
    // the deletes that cascade into them). Taken by a BEFORE … FOR EACH
    // STATEMENT trigger on those tables (auth/wsAuth.ts ensureEpochTriggers),
    // i.e. before the statement locks any row, and by PUT
    // /api/orgs/:orgId/access before its first FOR UPDATE.
    //
    // Why: every write to these tables used to bump the org's auth epoch row,
    // which serialized them as a side effect. Grants stopped bumping, then
    // reductions moved to per-user epochs, and lock-order inversions appeared
    // — measured 2026-10-16 as deterministic 40P01s in
    // auth/epochDeadlock.integration.test.ts: on the per-user epoch rows, and
    // on user_effective_permissions (two transactions writing grants of teams
    // that share members, in opposite orders — masked until then by the org
    // row).
    //
    // Why ONE lock and not one per org (the first version): a per-org lock can
    // only be taken in a ROW trigger, which fires after the statement has
    // locked all its rows — so a statement spanning several orgs took their
    // locks in row order, and a single-row writer could hold its row while
    // waiting for the lock. A statement trigger fires before any row lock but
    // cannot know the rows, hence the orgs: the lock has to be global. (A
    // BEFORE ROW trigger is no way out: for UPDATE/DELETE it fires after the
    // row's own lock — measured as a 40P01 by epochDeadlock's mutants.)
    //
    // The price: permission writes of DIFFERENT orgs queue behind each other.
    // They wait (the primary pool sets no lock_timeout), they do not fail.
    // Hold time of one statement, measured 2026-10-17 (local Postgres 16,
    // median of 5): an org_members insert (invite accept) or one team-member
    // removal < 1 ms at any size; a grant created or narrowed recomputes every
    // member of the team — 3 ms at 10 members, ~70-80 ms at 1 000, ~380 ms at
    // 5 000. A matrix save of k such grants holds it ~k times that. Not
    // measured: the queue under concurrent load.
    //
    // A transaction that took it and then went idle (a leaked client, the #53
    // class) would stop every org's permission writes; the lock therefore sets
    // idle_in_transaction_session_timeout for its own transaction, so such a
    // session is terminated — and the lock released — after 30 s.
    // An advisory lock rather than a row: it revokes nobody and needs no row.
    // ---------------------------------------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION lock_permission_writes() RETURNS void AS $$
      BEGIN
        PERFORM set_config('idle_in_transaction_session_timeout', '30s', true);
        PERFORM pg_advisory_xact_lock(hashtextextended('auth-permission-writes', 0));
      END;
      $$ LANGUAGE plpgsql
    `)
    // The per-org functions of the first version (never released).
    await client.query('DROP FUNCTION IF EXISTS lock_orgs_permissions(TEXT, TEXT)')
    await client.query('DROP FUNCTION IF EXISTS lock_org_permissions(TEXT)')

    // ---------------------------------------------------------------
    // rbac_effective_access — the decision function `access.ts` wraps. See
    // that file's header for the semantics (org-admin bypass, read inherits
    // down the ancestor chain, write never comes from mere org membership).
    // Defined here (schema.ts) because it's schema, not app logic; `access.ts`
    // only calls it.
    // ---------------------------------------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION rbac_effective_access(
        p_user_id TEXT, p_scope_id TEXT, p_resource_type TEXT
      ) RETURNS TABLE(can_read BOOLEAN, can_write BOOLEAN, via TEXT, grant_scope_id TEXT) AS $$
      DECLARE
        v_org_id TEXT;
        v_org_scope_id TEXT;
        v_user_status TEXT;
      BEGIN
        SELECT status INTO v_user_status FROM users WHERE id = p_user_id;
        IF v_user_status IS NULL OR v_user_status <> 'active' THEN
          RETURN;
        END IF;

        SELECT org_id INTO v_org_id FROM scopes WHERE id = p_scope_id;
        IF v_org_id IS NULL THEN
          RETURN;
        END IF;

        SELECT id INTO v_org_scope_id FROM scopes WHERE org_id = v_org_id AND kind = 'org';

        -- Org admin bypass: full read+write on everything in their org.
        IF EXISTS (
          SELECT 1 FROM org_members
          WHERE org_id = v_org_id AND user_id = p_user_id AND role = 'admin'
        ) THEN
          RETURN QUERY SELECT true, true, 'org-admin'::TEXT, v_org_scope_id;
          RETURN;
        END IF;

        -- Otherwise: best grant over the target scope's ancestor chain
        -- (itself included, depth 0). Read inherits DOWN from any ancestor
        -- grant; write only counts when the grant itself allows it — mere
        -- org membership (no team grant at all) yields no access, per the
        -- "matrix overrides hierarchy" rule with team grants as the matrix.
        RETURN QUERY
        SELECT
          bool_or(uep.can_read)  AS can_read,
          bool_or(uep.can_write) AS can_write,
          'team-grant'::TEXT     AS via,
          (array_agg(uep.scope_id ORDER BY sa.depth ASC) FILTER (WHERE uep.can_read OR uep.can_write))[1] AS grant_scope_id
        FROM scope_ancestors sa
        JOIN user_effective_permissions uep
          ON uep.scope_id = sa.ancestor_id AND uep.resource_type = p_resource_type
        WHERE sa.scope_id = p_scope_id
          AND uep.user_id = p_user_id
          AND (uep.can_read OR uep.can_write)
        HAVING bool_or(uep.can_read) OR bool_or(uep.can_write);
      END;
      $$ LANGUAGE plpgsql STABLE
    `)

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// =====================================================================
// Scope upsert helpers — exported for later wiring (org admin console,
// domain observer). Each is idempotent via the `UNIQUE(org_id, kind,
// landscape_id, version_id, domain_id)` key and returns the scope id
// whether it just inserted or found an existing row.
// =====================================================================

async function upsertScope(
  pool: Pool,
  args: { orgId: string; kind: 'org' | 'landscape' | 'version' | 'domain'; parentId: string | null; landscapeId: string | null; versionId: string | null; domainId: string | null }
): Promise<string> {
  const { orgId, kind, parentId, landscapeId, versionId, domainId } = args

  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM scopes
     WHERE org_id = $1 AND kind = $2
       AND landscape_id IS NOT DISTINCT FROM $3
       AND version_id IS NOT DISTINCT FROM $4
       AND domain_id IS NOT DISTINCT FROM $5`,
    [orgId, kind, landscapeId, versionId, domainId]
  )
  if (existing.length > 0) {
    // Un-delete on re-upsert (e.g. a domain recreated after a soft delete).
    await pool.query('UPDATE scopes SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL', [existing[0].id])
    return existing[0].id
  }

  const id = newId()
  const { rows: inserted } = await pool.query<{ id: string }>(
    `INSERT INTO scopes (id, org_id, kind, parent_id, landscape_id, version_id, domain_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, kind, landscape_id, version_id, domain_id) DO NOTHING
     RETURNING id`,
    [id, orgId, kind, parentId, landscapeId, versionId, domainId]
  )
  if (inserted.length > 0) return inserted[0].id

  // Lost the race against a concurrent upsert — re-read.
  const { rows: reread } = await pool.query<{ id: string }>(
    `SELECT id FROM scopes
     WHERE org_id = $1 AND kind = $2
       AND landscape_id IS NOT DISTINCT FROM $3
       AND version_id IS NOT DISTINCT FROM $4
       AND domain_id IS NOT DISTINCT FROM $5`,
    [orgId, kind, landscapeId, versionId, domainId]
  )
  return reread[0].id
}

/** Idempotent upsert of the single org-level scope for `orgId`. Returns its id. */
export async function upsertOrgScope(pool: Pool, orgId: string): Promise<string> {
  return upsertScope(pool, { orgId, kind: 'org', parentId: null, landscapeId: null, versionId: null, domainId: null })
}

/** Idempotent upsert of a landscape scope, parented under the org scope. Returns its id. */
export async function upsertLandscapeScope(pool: Pool, orgId: string, landscapeId: string): Promise<string> {
  const orgScopeId = await upsertOrgScope(pool, orgId)
  return upsertScope(pool, { orgId, kind: 'landscape', parentId: orgScopeId, landscapeId, versionId: null, domainId: null })
}

/** Idempotent upsert of a version scope, parented under its landscape scope. Returns its id. */
export async function upsertVersionScope(pool: Pool, orgId: string, landscapeId: string, versionId: string): Promise<string> {
  const landscapeScopeId = await upsertLandscapeScope(pool, orgId, landscapeId)
  return upsertScope(pool, { orgId, kind: 'version', parentId: landscapeScopeId, landscapeId, versionId, domainId: null })
}

/** Idempotent upsert of a domain scope, parented under its version scope. Returns its id. */
export async function upsertDomainScope(
  pool: Pool,
  orgId: string,
  landscapeId: string,
  versionId: string,
  domainId: string
): Promise<string> {
  const versionScopeId = await upsertVersionScope(pool, orgId, landscapeId, versionId)
  return upsertScope(pool, { orgId, kind: 'domain', parentId: versionScopeId, landscapeId, versionId, domainId })
}

/**
 * Soft-delete a scope (e.g. a domain removed from the model). Grants
 * referencing it are left in place but become inert: `rbac_effective_access`
 * doesn't filter on `deleted_at` itself (callers enforcing read/write should
 * check it), but the row and its closure entries stay intact so re-creating
 * the same resource (`upsertDomainScope` again) un-deletes it with grants
 * already attached.
 */
export async function softDeleteScope(pool: Pool, scopeId: string): Promise<string> {
  await pool.query('UPDATE scopes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [scopeId])
  return scopeId
}
