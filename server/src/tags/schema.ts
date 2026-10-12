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

export async function ensureTagSchema(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public')
    await client.query(`
      CREATE TABLE IF NOT EXISTS tag_groups (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT,
        icon_key TEXT,
        sort_key TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'archived')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (org_id, id)
      )
    `)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_groups_active_name
      ON tag_groups (org_id, normalized_name) WHERE lifecycle_status = 'active'
    `)
    await client.query(`
      WITH ranked AS (
        SELECT id, lpad((row_number() OVER (PARTITION BY org_id ORDER BY sort_key, id) * 1024)::text, 18, '0') AS rank
        FROM tag_groups WHERE sort_key !~ '^[0-9]{18}$'
      )
      UPDATE tag_groups g SET sort_key = ranked.rank FROM ranked WHERE ranked.id = g.id
    `)
    await client.query('ALTER TABLE tag_groups DROP CONSTRAINT IF EXISTS tag_groups_sort_key_check')
    await client.query(`
      ALTER TABLE tag_groups ADD CONSTRAINT tag_groups_sort_key_check CHECK (sort_key ~ '^[0-9]{18}$')
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tag_groups_order
      ON tag_groups (org_id, lifecycle_status, sort_key, id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tag_groups_search_trgm
      ON tag_groups USING gin (normalized_name public.gin_trgm_ops) WITH (fastupdate = off)
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        color TEXT NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
        sort_key TEXT NOT NULL,
        lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'archived', 'merged')),
        canonical_tag_id TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (org_id, id),
        FOREIGN KEY (org_id, group_id) REFERENCES tag_groups(org_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (org_id, canonical_tag_id) REFERENCES tags(org_id, id) ON DELETE RESTRICT,
        CHECK ((lifecycle_status = 'merged') = (canonical_tag_id IS NOT NULL)),
        CHECK (canonical_tag_id IS NULL OR canonical_tag_id <> id)
      )
    `)
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_active_value
      ON tags (org_id, group_id, normalized_value) WHERE lifecycle_status = 'active'
    `)
    await client.query(`
      WITH ranked AS (
        SELECT id, lpad((row_number() OVER (PARTITION BY org_id, group_id ORDER BY sort_key, id) * 1024)::text, 18, '0') AS rank
        FROM tags WHERE sort_key !~ '^[0-9]{18}$'
      )
      UPDATE tags t SET sort_key = ranked.rank FROM ranked WHERE ranked.id = t.id
    `)
    await client.query('ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_sort_key_check')
    await client.query(`
      ALTER TABLE tags ADD CONSTRAINT tags_sort_key_check CHECK (sort_key ~ '^[0-9]{18}$')
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tags_order
      ON tags (org_id, group_id, lifecycle_status, sort_key, id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tags_search_trgm
      ON tags USING gin (normalized_value public.gin_trgm_ops) WITH (fastupdate = off)
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tag_redirects (
        source_tag_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        target_tag_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (org_id, source_tag_id) REFERENCES tags(org_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (org_id, target_tag_id) REFERENCES tags(org_id, id) ON DELETE RESTRICT,
        CHECK (source_tag_id <> target_tag_id)
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_tag_settings (
        org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
        allow_member_tag_creation BOOLEAN NOT NULL DEFAULT true,
        allow_editor_tag_group_creation BOOLEAN NOT NULL DEFAULT false,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_by TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tag_idempotency_keys (
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        actor_user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed')),
        response_body JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
        PRIMARY KEY (org_id, actor_user_id, idempotency_key),
        CHECK ((state = 'completed') = (response_body IS NOT NULL AND completed_at IS NOT NULL))
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tag_idempotency_expiry ON tag_idempotency_keys (expires_at)
    `)
    // Shared, non-durable counters provide a distributed fallback when Redis
    // is not installed. Losing them on a database restart only opens a fresh
    // rate window; no catalog or audit data is lost.
    await client.query(`
      CREATE UNLOGGED TABLE IF NOT EXISTS tag_rate_limit_buckets (
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('actor', 'org')),
        scope_id TEXT NOT NULL,
        bucket TEXT NOT NULL CHECK (bucket IN ('read', 'mutation')),
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
        PRIMARY KEY (org_id, scope_kind, scope_id, bucket, window_start)
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tag_rate_limit_expiry ON tag_rate_limit_buckets (window_start)
    `)
    // Privacy-minimized, client-reported outbox operations. No Tag value,
    // Group name, local catalog ID, document ID, or Automerge payload is stored.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tag_operation_events (
        id TEXT PRIMARY KEY CHECK (id ~ '^tagop_client_[0-9a-f]{32}$'),
        org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        actor_user_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('queued', 'replay_succeeded', 'attention', 'discarded', 'reconciled')),
        item_kind TEXT NOT NULL CHECK (item_kind IN ('tag', 'group')),
        reason_code TEXT CHECK (reason_code ~ '^[a-z0-9_:-]{1,80}$'),
        age_ms BIGINT NOT NULL CHECK (age_ms BETWEEN 0 AND 3024000000),
        attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1000),
        occurred_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tag_operation_events_org_time
      ON tag_operation_events (org_id, occurred_at DESC, id)
    `)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tag_operation_events_org_type_time
      ON tag_operation_events (org_id, event_type, occurred_at DESC)
    `)
    await client.query(`
      CREATE OR REPLACE FUNCTION tag_redirects_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'tag_redirects is append-only: % is not permitted', TG_OP;
      END;
      $$ LANGUAGE plpgsql
    `)
    await client.query('DROP TRIGGER IF EXISTS tag_redirects_no_update_delete ON tag_redirects')
    await client.query(`
      CREATE TRIGGER tag_redirects_no_update_delete
      BEFORE UPDATE OR DELETE ON tag_redirects
      FOR EACH ROW EXECUTE FUNCTION tag_redirects_immutable()
    `)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
