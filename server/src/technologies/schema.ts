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

/**
 * Central technology catalog schema. Catalog identity/revisions live in
 * PostgreSQL; Automerge documents only keep stable references and render
 * snapshots. Content revisions and audit/redirect rows are append-only.
 */
export async function ensureTechnologySchema(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // The catalog supports contains search (LIKE '%query%'). A B-tree cannot
    // accelerate that access pattern, whereas pg_trgm can. Install the
    // extension in the stable public schema so the operator class remains
    // available to isolated-schema tests and tenant schemas with a restricted
    // search_path.
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public')
    await client.query(`
      CREATE TABLE IF NOT EXISTS technology_identities (
        id                       TEXT PRIMARY KEY,
        scope                    TEXT NOT NULL CHECK (scope IN ('public', 'org_private')),
        owner_org_id             TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
        lifecycle_status         TEXT NOT NULL DEFAULT 'active'
                                   CHECK (lifecycle_status IN ('active', 'deprecated', 'retired', 'merged')),
        canonical_technology_id  TEXT REFERENCES technology_identities(id) ON DELETE RESTRICT,
        latest_revision          INTEGER NOT NULL DEFAULT 1 CHECK (latest_revision > 0),
        current_revision         INTEGER CHECK (current_revision > 0),
        created_by               TEXT NOT NULL,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (
          (scope = 'public' AND owner_org_id IS NULL) OR
          (scope = 'org_private' AND owner_org_id IS NOT NULL)
        ),
        CHECK (
          (lifecycle_status = 'merged' AND canonical_technology_id IS NOT NULL) OR
          (lifecycle_status <> 'merged')
        ),
        CHECK (canonical_technology_id IS NULL OR canonical_technology_id <> id)
      )
    `)
    await client.query(`ALTER TABLE technology_identities ADD COLUMN IF NOT EXISTS current_revision INTEGER`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_identities_owner
      ON technology_identities (owner_org_id, lifecycle_status, id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_identities_public
      ON technology_identities (lifecycle_status, id) WHERE scope = 'public'
    `)

    // Revision payloads never change after insertion. Workflow state lives in
    // a separate table so approval does not mutate catalog content.
    await client.query(`
      CREATE TABLE IF NOT EXISTS technology_revisions (
        technology_id       TEXT NOT NULL REFERENCES technology_identities(id) ON DELETE RESTRICT,
        revision            INTEGER NOT NULL CHECK (revision > 0),
        name                TEXT NOT NULL CHECK (length(btrim(name)) > 0),
        normalized_name     TEXT NOT NULL CHECK (length(normalized_name) > 0),
        description         TEXT,
        website_url         TEXT,
        documentation_url   TEXT,
        aliases             TEXT[] NOT NULL DEFAULT '{}',
        normalized_aliases  TEXT[] NOT NULL DEFAULT '{}',
        category            TEXT,
        icon_light_path     TEXT,
        icon_dark_path      TEXT,
        publisher           TEXT,
        ecosystem           TEXT,
        recommended_shape_types TEXT[] NOT NULL
          DEFAULT ARRAY['system', 'app', 'store', 'component', 'group']::TEXT[]
          CONSTRAINT technology_revisions_recommended_shapes_check CHECK (
            recommended_shape_types <@ ARRAY['system', 'app', 'store', 'component', 'group']::TEXT[]
            AND array_position(recommended_shape_types, NULL) IS NULL
            AND cardinality(recommended_shape_types) BETWEEN 1 AND 5
            AND cardinality(array_positions(recommended_shape_types, 'system')) <= 1
            AND cardinality(array_positions(recommended_shape_types, 'app')) <= 1
            AND cardinality(array_positions(recommended_shape_types, 'store')) <= 1
            AND cardinality(array_positions(recommended_shape_types, 'component')) <= 1
            AND cardinality(array_positions(recommended_shape_types, 'group')) <= 1
          ),
        default_role        TEXT NOT NULL DEFAULT 'other'
          CONSTRAINT technology_revisions_default_role_check CHECK (
            default_role IN (
              'primary', 'language', 'runtime', 'framework', 'library', 'database', 'storage',
              'messaging', 'protocol', 'platform', 'infrastructure', 'tooling', 'other'
            )
          ),
        search_document     TEXT NOT NULL,
        search_compact_document TEXT GENERATED ALWAYS AS (
          regexp_replace(search_document, '[^a-z0-9+#]', '', 'g')
        ) STORED,
        created_by          TEXT NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (technology_id, revision)
      )
    `)
    await client.query(`
      ALTER TABLE technology_revisions
      ADD COLUMN IF NOT EXISTS search_compact_document TEXT GENERATED ALWAYS AS (
        regexp_replace(search_document, '[^a-z0-9+#]', '', 'g')
      ) STORED
    `)
    await client.query(`
      DROP TRIGGER IF EXISTS technology_revisions_no_update_delete ON technology_revisions
    `)
    await client.query(`
      ALTER TABLE technology_revisions
      ADD COLUMN IF NOT EXISTS recommended_shape_types TEXT[] NOT NULL
        DEFAULT ARRAY['system', 'app', 'store', 'component', 'group']::TEXT[]
    `)
    await client.query(`
      ALTER TABLE technology_revisions
      ALTER COLUMN recommended_shape_types
      SET DEFAULT ARRAY['system', 'app', 'store', 'component', 'group']::TEXT[]
    `)
    // A pre-feature catalog has no recommendation metadata. Treat those
    // revisions as compatible with every supported shape before making the
    // one-or-more invariant strict; a clean reseed supplies precise values.
    await client.query(`
      UPDATE technology_revisions
      SET recommended_shape_types = ARRAY['system', 'app', 'store', 'component', 'group']::TEXT[]
      WHERE cardinality(recommended_shape_types) = 0
    `)
    await client.query(`
      ALTER TABLE technology_revisions
      ADD COLUMN IF NOT EXISTS default_role TEXT NOT NULL DEFAULT 'other'
    `)
    await client.query(`
      UPDATE technology_revisions SET default_role = 'other' WHERE default_role IS NULL
    `)
    await client.query(`
      ALTER TABLE technology_revisions ALTER COLUMN default_role SET DEFAULT 'other'
    `)
    await client.query(`
      ALTER TABLE technology_revisions ALTER COLUMN default_role SET NOT NULL
    `)
    await client.query(`
      ALTER TABLE technology_revisions
      DROP CONSTRAINT IF EXISTS technology_revisions_recommended_shapes_check
    `)
    await client.query(`
      ALTER TABLE technology_revisions
      ADD CONSTRAINT technology_revisions_recommended_shapes_check CHECK (
        recommended_shape_types <@ ARRAY['system', 'app', 'store', 'component', 'group']::TEXT[]
        AND array_position(recommended_shape_types, NULL) IS NULL
        AND cardinality(recommended_shape_types) BETWEEN 1 AND 5
        AND cardinality(array_positions(recommended_shape_types, 'system')) <= 1
        AND cardinality(array_positions(recommended_shape_types, 'app')) <= 1
        AND cardinality(array_positions(recommended_shape_types, 'store')) <= 1
        AND cardinality(array_positions(recommended_shape_types, 'component')) <= 1
        AND cardinality(array_positions(recommended_shape_types, 'group')) <= 1
      )
    `)
    await client.query(`
      ALTER TABLE technology_revisions
      DROP CONSTRAINT IF EXISTS technology_revisions_default_role_check
    `)
    await client.query(`
      ALTER TABLE technology_revisions
      ADD CONSTRAINT technology_revisions_default_role_check CHECK (
        default_role IN (
          'primary', 'language', 'runtime', 'framework', 'library', 'database', 'storage',
          'messaging', 'protocol', 'platform', 'infrastructure', 'tooling', 'other'
        )
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_search
      ON technology_revisions (normalized_name, technology_id, revision)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_name_prefix
      ON technology_revisions (normalized_name text_pattern_ops, technology_id, revision)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_search_document_trgm
      ON technology_revisions USING gin (search_document public.gin_trgm_ops)
      WITH (fastupdate = off)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_compact_document_trgm
      ON technology_revisions USING gin (search_compact_document public.gin_trgm_ops)
      WITH (fastupdate = off)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_aliases
      ON technology_revisions USING gin (normalized_aliases)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_category
      ON technology_revisions (category, normalized_name, technology_id, revision)
      WHERE category IS NOT NULL
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_default_role
      ON technology_revisions (default_role, normalized_name, technology_id, revision)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_recommended_shapes
      ON technology_revisions USING gin (recommended_shape_types)
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS technology_revision_workflows (
        technology_id   TEXT NOT NULL,
        revision        INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'in_review', 'changes_requested', 'approved', 'rejected')),
        submitted_by    TEXT,
        submitted_at    TIMESTAMPTZ,
        private_approved_by  TEXT,
        private_approved_at  TIMESTAMPTZ,
        decided_by      TEXT,
        decided_at      TIMESTAMPTZ,
        decision_note   TEXT,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (technology_id, revision),
        FOREIGN KEY (technology_id, revision)
          REFERENCES technology_revisions(technology_id, revision) ON DELETE RESTRICT
      )
    `)
    await client.query(`ALTER TABLE technology_revision_workflows ADD COLUMN IF NOT EXISTS private_approved_by TEXT`)
    await client.query(`ALTER TABLE technology_revision_workflows ADD COLUMN IF NOT EXISTS private_approved_at TIMESTAMPTZ`)
    // Backfill deployments created by an earlier technology-catalog build.
    // Public approval or private approval makes that revision current; drafts
    // remain without a selectable pointer.
    await client.query(`
      UPDATE technology_identities i
      SET current_revision = candidate.revision
      FROM (
        SELECT DISTINCT ON (w.technology_id) w.technology_id, w.revision
        FROM technology_revision_workflows w
        JOIN technology_identities ti ON ti.id = w.technology_id
        WHERE (ti.scope = 'public' AND w.status = 'approved')
           OR (ti.scope = 'org_private' AND w.private_approved_at IS NOT NULL)
        ORDER BY w.technology_id, w.revision DESC
      ) candidate
      WHERE i.id = candidate.technology_id AND i.current_revision IS NULL
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_workflows_status
      ON technology_revision_workflows (status, updated_at DESC)
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS technology_org_policies (
        org_id       TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
        policy       TEXT NOT NULL DEFAULT 'all' CHECK (policy IN ('all', 'none')),
        updated_by   TEXT NOT NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS technology_org_overrides (
        org_id          TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        technology_id   TEXT NOT NULL REFERENCES technology_identities(id) ON DELETE RESTRICT,
        state           TEXT NOT NULL CHECK (state IN ('enabled', 'hidden')),
        updated_by      TEXT NOT NULL,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, technology_id)
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS technology_redirects (
        source_technology_id  TEXT PRIMARY KEY REFERENCES technology_identities(id) ON DELETE RESTRICT,
        target_technology_id  TEXT NOT NULL REFERENCES technology_identities(id) ON DELETE RESTRICT,
        created_by            TEXT NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (source_technology_id <> target_technology_id)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_redirects_target
      ON technology_redirects (target_technology_id)
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS technology_audit (
        id                TEXT PRIMARY KEY,
        actor_user_id     TEXT NOT NULL,
        org_id            TEXT,
        action            TEXT NOT NULL,
        technology_id     TEXT,
        revision          INTEGER,
        detail            JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_audit_org_at
      ON technology_audit (org_id, created_at DESC, id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_audit_technology_at
      ON technology_audit (technology_id, created_at DESC, id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_audit_asset_rate
      ON technology_audit (org_id, actor_user_id, created_at DESC)
      WHERE action = 'technology.asset_uploaded'
    `)

    // One immutable blob can be reused across revisions. Metadata remains
    // tenant-scoped so quota accounting never leaks another organization's
    // catalog activity, while the content hash safely deduplicates disk bytes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS technology_assets (
        org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        sha256        TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
        path          TEXT NOT NULL,
        content_type  TEXT NOT NULL CHECK (content_type IN ('image/svg+xml', 'image/png')),
        bytes         INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 262144),
        reference_count INTEGER NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
        last_referenced_at TIMESTAMPTZ,
        last_uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by    TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, sha256),
        UNIQUE (org_id, path),
        CHECK (
          path = '/assets/technologies/' || sha256 ||
            CASE content_type WHEN 'image/svg+xml' THEN '.svg' ELSE '.png' END
        )
      )
    `)
    await client.query(`
      ALTER TABLE technology_assets
      ADD COLUMN IF NOT EXISTS reference_count INTEGER NOT NULL DEFAULT 0 CHECK (reference_count >= 0)
    `)
    await client.query(`
      ALTER TABLE technology_assets
      ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ
    `)
    await client.query(`
      ALTER TABLE technology_assets
      ADD COLUMN IF NOT EXISTS last_uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    `)
    // Preserve assets referenced by revisions created before reference tracking
    // was introduced. Matching by immutable path is deliberately conservative:
    // a physical blob must never be collected while any revision renders it.
    await client.query(`
      WITH revision_paths AS (
        SELECT technology_id, revision, icon_light_path AS path, created_at
        FROM technology_revisions WHERE icon_light_path IS NOT NULL
        UNION
        SELECT technology_id, revision, icon_dark_path AS path, created_at
        FROM technology_revisions WHERE icon_dark_path IS NOT NULL
      ), referenced AS (
        SELECT path, count(*)::integer AS reference_count, max(created_at) AS last_referenced_at
        FROM revision_paths GROUP BY path
      )
      UPDATE technology_assets a
      SET reference_count = referenced.reference_count,
          last_referenced_at = referenced.last_referenced_at
      FROM referenced
      WHERE a.path = referenced.path AND a.reference_count = 0
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_assets_org_created
      ON technology_assets (org_id, created_at DESC, sha256)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_assets_pending_gc_v2
      ON technology_assets (last_uploaded_at, org_id, sha256)
      WHERE reference_count = 0
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_icon_light
      ON technology_revisions (icon_light_path)
      WHERE icon_light_path IS NOT NULL
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_technology_revisions_icon_dark
      ON technology_revisions (icon_dark_path)
      WHERE icon_dark_path IS NOT NULL
    `)

    await client.query(`
      CREATE OR REPLACE FUNCTION technology_immutable_row() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `)
    for (const [table, trigger] of [
      ['technology_revisions', 'technology_revisions_no_update_delete'],
      ['technology_redirects', 'technology_redirects_no_update_delete'],
      ['technology_audit', 'technology_audit_no_update_delete'],
    ] as const) {
      await client.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${table}`)
      await client.query(`
        CREATE TRIGGER ${trigger}
        BEFORE UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION technology_immutable_row()
      `)
      await client.query(`REVOKE UPDATE, DELETE ON ${table} FROM PUBLIC`)
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
