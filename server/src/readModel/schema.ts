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

import type { Queryable } from './types.js'

/**
 * Create the read-model tables + indexes (idempotent). Full entity in `data`
 * JSONB for exact reconstruction; denormalized columns for indexed search/filter.
 *
 * Every table is keyed by workspace —
 * composite PRIMARY KEY (landscape_id, version_id, id) — so one Postgres instance
 * holds the projected rows for every (landscape, version) a projector has ever
 * cold-built, not just the single default workspace. `org_id` is denormalized
 * alongside (nullable — resolved from `scopes` when available, see projector.ts)
 * so a future RLS policy on `ro_*` can filter by it directly, matching every
 * other resource table.
 *
 *  - ro_objects:     GIN(pg_trgm) on name/description/technology for substring
 *                    search; B-tree on (landscape_id, version_id, parent_id) /
 *                    (landscape_id, version_id, domain_id) for filters.
 *  - ro_connections: B-tree on (landscape_id, version_id, from_id) / (…, to_id)
 *                    for O(degree) adjacency fan-out within a workspace.
 *
 * `pg_trgm` accelerates `col ILIKE '%q%'` (3+ char queries) — the substring search
 * the client does in JS, served as O(result) here. The trigram indexes stay
 * single-column (not workspace-prefixed): search SQL always filters by
 * (landscape_id, version_id) first via the composite PK's leading columns, so the
 * trigram index only needs to narrow within the already-small workspace-filtered
 * row set — a workspace-prefixed GIN would add write cost for no read benefit here.
 */
export async function ensureReadModelSchema(db: Queryable): Promise<void> {
  await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`)

  // MIGRATION: ro_* is a DERIVED projection (never authoritative), so a legacy
  // (pre-workspace-keying) install — ro_objects present WITHOUT landscape_id — is handled by
  // dropping and recreating rather than an ALTER+backfill: there is no row data
  // worth preserving, and every existing projector immediately cold-builds the
  // replacement on its next `ensure()`.
  if (await hasLegacySchema(db)) {
    console.log(
      '[read-model] legacy (pre-workspace) ro_* schema detected — dropping and recreating; ' +
        'the projector will cold-build every workspace it serves from scratch'
    )
    await dropReadModelSchema(db)
  }

  // Operational state for each workspace projector. This table intentionally
  // contains no model payload: only generations, timestamps and a bounded
  // error code are retained so org administrators can distinguish a healthy
  // projection from backlog, eviction and failure without exposing workspace
  // content. `projector_instance_id` makes detach compare-and-set safe when an
  // old projector stops after a replacement has already attached.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_projection_state (
      landscape_id          TEXT NOT NULL,
      version_id            TEXT NOT NULL,
      org_id                TEXT,
      observed_generation   BIGINT NOT NULL DEFAULT 0 CHECK (observed_generation >= 0),
      projected_generation  BIGINT NOT NULL DEFAULT 0 CHECK (projected_generation >= 0),
      source_changed_at      TIMESTAMPTZ,
      projection_started_at TIMESTAMPTZ,
      last_projected_at      TIMESTAMPTZ,
      last_duration_ms       INTEGER CHECK (last_duration_ms IS NULL OR last_duration_ms >= 0),
      last_error_at          TIMESTAMPTZ,
      last_error_generation BIGINT,
      last_error_code        TEXT CONSTRAINT read_model_projection_state_error_code_bounded
                             CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 64),
      consecutive_failures   INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
      projector_attached     BOOLEAN NOT NULL DEFAULT false,
      projector_instance_id  TEXT,
      -- The ROW-WRITE fence (plan §2quinquies, NC-2): the instance whose cold
      -- build most recently rebuilt this workspace's ro_* rows. Claimed inside
      -- the cold build's own transaction, asserted FOR UPDATE by every
      -- projection transaction before it commits. NOT projector_instance_id —
      -- that column has a second writer (StaticDeltaProjector.reloadDescriptors)
      -- and a CAS on it failed deterministically once already (health.ts N11).
      write_fence            TEXT,
      last_projection_kind   TEXT CONSTRAINT read_model_projection_state_kind_valid
                             CHECK (last_projection_kind IS NULL OR last_projection_kind IN (
        'cold_build', 'object_shard', 'connection_shard', 'registry', 'metadata', 'monolith'
      )),
      -- Degraded state: the workspace still serves its last coherent read model
      -- while one subsystem could not complete its projection. Sticky until a
      -- full successful projection clears it, so a partially-projected
      -- workspace can never report itself healthy.
      degraded_since         TIMESTAMPTZ,
      degraded_kind          TEXT,
      degraded_error_code    TEXT CONSTRAINT read_model_projection_state_degraded_code_bounded
                             CHECK (degraded_error_code IS NULL OR char_length(degraded_error_code) <= 64),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id),
      CHECK (projected_generation <= observed_generation)
    )
  `)
  // The arrival clock the watermark rows are minted from. Owned by db.ts's
  // initSchema in production; ensured here TOO because the read model consumes
  // it on every projection pass and its DB-gated suites run against isolated
  // schemas that never call initSchema. Idempotent either way.
  await db.query(`CREATE SEQUENCE IF NOT EXISTS automerge_arrival_seq`)
  // Per-DOCUMENT projected arrival watermarks. Each row says
  // "every durable arrival of this document with arrival_seq ≤
  // projected_watermark is reflected in ro_*" — recorded in the SAME
  // transaction as the projection rows, per document rather than per workspace
  // on purpose: a per-workspace value would let one kind's completion vouch
  // for another kind's backlog.
  // Zero explicitly refuses a certificate, including the legacy timestamp
  // fallback. A verified ordinary projection replaces it with its exact
  // prepared watermark; a mismatch can invalidate an older positive value.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_document_watermarks (
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL,
      document_id         TEXT NOT NULL,
      projected_watermark BIGINT NOT NULL CHECK (projected_watermark >= 0),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, document_id)
    )
  `)
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.read_model_projection_state')
          AND conname = 'read_model_projection_state_error_code_bounded'
      ) THEN
        ALTER TABLE read_model_projection_state
          ADD CONSTRAINT read_model_projection_state_error_code_bounded
          CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 64);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.read_model_projection_state')
          AND conname = 'read_model_projection_state_kind_valid'
      ) THEN
        ALTER TABLE read_model_projection_state
          ADD CONSTRAINT read_model_projection_state_kind_valid
          CHECK (last_projection_kind IS NULL OR last_projection_kind IN (
            'cold_build', 'object_shard', 'connection_shard', 'registry', 'metadata', 'monolith'
          ));
      END IF;
    END $$;
  `)
  // Degraded-state columns, added after the table shipped.
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS degraded_since TIMESTAMPTZ`)
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS degraded_kind TEXT`)
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS degraded_error_code TEXT`)
  // The row-write fence, added after the table shipped. Nullable, no
  // DEFAULT: NULL means "no fenced cold build has claimed this workspace yet",
  // and the first projector to attach after this migration claims it.
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS write_fence TEXT`)
  // What one projection knew about itself, written in the same
  // transaction as its rows (see projectionIntegrity.ts).
  //
  // `content_digest` is per kind: {"object":{"n":11935,"x":"…","g":42}, …}. `g`
  // is the generation it was computed at and is load-bearing — a digest whose
  // `g` is behind `projected_generation` describes a read model that has since
  // changed, and comparing it would manufacture a false mismatch.
  //
  // `defect_count` is set ONLY by a full extraction, so a per-shard projection
  // cannot report its narrow view as the workspace's. Nullable rather than
  // DEFAULT 0: a workspace never fully extracted has never been looked at,
  // and that is not the same fact as "looked at, found nothing".
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS content_digest JSONB`)
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS defect_count INTEGER`)
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS defect_summary TEXT`)
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS defects_observed_at TIMESTAMPTZ`)
  // Constraints separately, in this file's own idiom rather than inline on the
  // ADD COLUMN. `ADD COLUMN IF NOT EXISTS … CONSTRAINT …` skips the CONSTRAINT
  // silently whenever the column already exists — harmless the first time these
  // ship, a trap on the next database that already has the column.
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.read_model_projection_state')
          AND conname = 'read_model_projection_state_defect_count_bounded'
      ) THEN
        ALTER TABLE read_model_projection_state
          ADD CONSTRAINT read_model_projection_state_defect_count_bounded
          CHECK (defect_count IS NULL OR defect_count >= 0);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.read_model_projection_state')
          AND conname = 'read_model_projection_state_defect_summary_bounded'
      ) THEN
        ALTER TABLE read_model_projection_state
          ADD CONSTRAINT read_model_projection_state_defect_summary_bounded
          CHECK (defect_summary IS NULL OR char_length(defect_summary) <= 1000);
      END IF;
    END $$;
  `)
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.read_model_projection_state')
          AND conname = 'read_model_projection_state_degraded_code_bounded'
      ) THEN
        ALTER TABLE read_model_projection_state
          ADD CONSTRAINT read_model_projection_state_degraded_code_bounded
          CHECK (degraded_error_code IS NULL OR char_length(degraded_error_code) <= 64);
      END IF;
    END $$;
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_projection_state_org
    ON read_model_projection_state (org_id, updated_at DESC)`)

  // Immutable, pre-materialized benchmark snapshots do not need an Automerge
  // projector. Interactive read routes may serve these rows immediately instead
  // of rebuilding hundreds of thousands of entities on every server restart.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_static_workspaces (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      source       TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_static_documents (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      document_id TEXT NOT NULL,
      kind         TEXT NOT NULL,
      entity_id    TEXT,
      PRIMARY KEY (landscape_id, version_id, document_id)
    )
  `)
  await db.query(`ALTER TABLE read_model_static_documents
    ADD COLUMN IF NOT EXISTS entity_id TEXT`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_static_documents_document
    ON read_model_static_documents (document_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_static_documents_entity
    ON read_model_static_documents (landscape_id, version_id, kind, entity_id)`)

  // THE ALLOW-LIST'S PARENT IS THE PLANE AUTHORITY. Without this foreign key,
  // `read_model_static_documents` is a second registry of "this workspace is
  // static" with no link back to `read_model_static_workspaces`: after a
  // demotion, a rotation could still write allow-list rows, which re-attached
  // the static projector, which rotated again. With it, such a write (including
  // the ON CONFLICT DO UPDATE form) is refused with 23503.
  //
  // NOT VALID, so boot cannot wedge: `ensureReadModelSchema` runs on every
  // start, and validating against a database that already holds an orphan
  // would fail with 23503. NOT VALID still refuses a new orphan and still
  // cascades on delete; it only skips the initial scan, so legacy orphans
  // survive untouched. Those belong to `npm run fsck`
  // (`static-allow-list-orphaned`) and to the demotion door, which sweeps the
  // allow-list explicitly — never to a DELETE at boot against rows nobody has
  // looked at. (`fsckAllWorkspaces` enumerates from `versions`, so an orphan
  // whose `versions` row is gone is not detected.)
  //
  // Other properties that were checked:
  //  - NOT VALID is still enforced on UPDATE of a KEY column; the production
  //    UPDATEs of this table (`realignPerformanceFixture`'s `SET kind`, the
  //    projector's `entity_id` backfill) are non-key, so orphans do not make
  //    them fail.
  //  - Backup/restore survives: `pg_dump` emits the constraint `NOT VALID`, so
  //    `pg_restore --exit-on-error --single-transaction` (`backupRestore.ts`)
  //    does not abort on a legacy orphan.
  //  - Every child INSERT takes FOR KEY SHARE on the parent tuple. A demotion
  //    (DELETE of the parent) BLOCKS a child insert; an uncommitted NEW parent
  //    makes the child insert fail 23503 under READ COMMITTED rather than wait,
  //    so a rotation racing a first-time promotion fails and retries.
  //  - The RI check fires at END of statement, so an `INSERT … ON CONFLICT DO
  //    UPDATE` with a MIXED batch of new and existing rows locks allow-list
  //    rows first and the parent last (D → S), deadlocking against a demotion
  //    (S → D). `registerStaticReadModelDocumentsInTransaction` therefore takes
  //    the workspace row `FOR KEY SHARE` first (S → W → D), with
  //    `isDeadlockVictim` as a legible backstop.
  //  - The refusing write paths (`rotateOverlayHead`, `foldOverlayChain`, the
  //    recovery walks) reach SQL only after creating documents and mutating
  //    ModelMeta, so a refusal rolls back SQL but leaves an unreferenced
  //    document (an accepted leak). Conversely a stream of allow-list writes
  //    can starve a demotion until its lock timeout (55P03).
  //
  // The shape of the DDL block below matters too:
  //
  // 1. The probe resolves the table the SAME WAY the action does — bare, through
  //    `search_path` — and NOT through `current_schema()`. Every other statement
  //    in this function is unqualified, so on a connection opened with
  //    `search_path=<mine>,public` (which `scripts/read-model-load-gate.ts` does)
  //    the `CREATE TABLE IF NOT EXISTS` above finds `public`'s table and creates
  //    nothing in `<mine>`. A probe asking `current_schema()` would then see no
  //    constraint, while the `ALTER TABLE` it guards resolves to `public` — so
  //    the block would silently alter the shared schema on the first run and
  //    raise 42710 on every run after that. A guard and its action must name
  //    the same object by the same rule.
  // 2. `EXCEPTION WHEN duplicate_object`, because a check followed by an ALTER
  //    is not atomic and this function does NOT run only under the migration
  //    ledger's advisory lock — `projectorService.ts` calls it on every projector
  //    attach, at runtime. Two concurrent attaches can both pass the probe, and
  //    the loser of the ALTER would raise 42710 and fail the attach.
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass('read_model_static_documents')
          AND conname = 'read_model_static_documents_workspace_fk'
      ) THEN
        ALTER TABLE read_model_static_documents
          ADD CONSTRAINT read_model_static_documents_workspace_fk
          FOREIGN KEY (landscape_id, version_id)
          REFERENCES read_model_static_workspaces (landscape_id, version_id)
          ON DELETE CASCADE NOT VALID;
      END IF;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `)

  await db.query(`ALTER TABLE read_model_static_workspaces
    ADD COLUMN IF NOT EXISTS base_version_id TEXT`)

  // Sparse static drafts capture a parent entity only when the parent is about
  // to change. If no row exists, the parent's current value is still the exact
  // fork-point value. This is copy-on-write at relational scale: draft creation
  // stays O(1), while three-way merge remains exact for every touched entity.
  await db.query(`
    CREATE TABLE IF NOT EXISTS draft_sparse_base_entities (
      landscape_id    TEXT NOT NULL,
      draft_version_id TEXT NOT NULL,
      entity_kind     TEXT NOT NULL CHECK (entity_kind IN (
        'object', 'connection', 'group', 'diagram', 'decision_record'
      )),
      entity_id       TEXT NOT NULL,
      data            JSONB,
      existed         BOOLEAN NOT NULL,
      captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, draft_version_id, entity_kind, entity_id),
      CHECK ((existed AND data IS NOT NULL) OR (NOT existed AND data IS NULL))
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_draft_sparse_base_parent
    ON draft_sparse_base_entities (landscape_id, draft_version_id, entity_kind)`)

  // Static performance workspaces keep their generated Automerge baseline
  // immutable. These compact last-write-wins tables retain only the currently
  // effective override/tombstone for a touched entity or membership. The ro_*
  // tables remain the transactionally materialized query plane, so interactive
  // reads never union a 200k/300k baseline with an unbounded event history.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_static_entity_deltas (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      entity_kind  TEXT NOT NULL CHECK (entity_kind IN (
        'object', 'connection', 'group', 'diagram', 'decision_record'
      )),
      entity_id    TEXT NOT NULL,
      data         JSONB,
      tombstone    BOOLEAN NOT NULL DEFAULT false,
      generation   BIGINT NOT NULL CHECK (generation >= 0),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, entity_kind, entity_id),
      CHECK ((tombstone AND data IS NULL) OR (NOT tombstone AND data IS NOT NULL))
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_static_entity_deltas_generation
    ON read_model_static_entity_deltas (landscape_id, version_id, generation)`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_static_membership_deltas (
      landscape_id   TEXT NOT NULL,
      version_id     TEXT NOT NULL,
      membership_kind TEXT NOT NULL CHECK (membership_kind IN (
        'diagram_object', 'diagram_group', 'diagram_connection',
        'group_object', 'connection_flow', 'registry_shard_diagram'
      )),
      owner_id       TEXT NOT NULL,
      entity_id      TEXT NOT NULL,
      auxiliary_id  TEXT NOT NULL DEFAULT '',
      tombstone      BOOLEAN NOT NULL DEFAULT false,
      generation     BIGINT NOT NULL CHECK (generation >= 0),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (
        landscape_id, version_id, membership_kind, owner_id, entity_id, auxiliary_id
      )
    )
  `)
  // `registry_shard_diagram` was added to the kinds above later. `CREATE TABLE IF NOT
  // EXISTS` leaves an EXISTING database on the old CHECK, so every insert of the
  // new kind would fail a constraint on exactly the deployments that already
  // carry data. Same drop-and-re-add shape as the overlay batch-ack status
  // check below.
  await db.query(`
    DO $$
    BEGIN
      ALTER TABLE read_model_static_membership_deltas
        DROP CONSTRAINT IF EXISTS read_model_static_membership_deltas_membership_kind_check;
      ALTER TABLE read_model_static_membership_deltas
        ADD CONSTRAINT read_model_static_membership_deltas_membership_kind_check
        CHECK (membership_kind IN (
          'diagram_object', 'diagram_group', 'diagram_connection',
          'group_object', 'connection_flow', 'registry_shard_diagram'
        ));
    END $$;
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_static_membership_deltas_generation
    ON read_model_static_membership_deltas (landscape_id, version_id, generation)`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_diagram_render_generations (
      landscape_id      TEXT NOT NULL,
      version_id        TEXT NOT NULL,
      diagram_id        TEXT NOT NULL,
      render_generation BIGINT NOT NULL CHECK (render_generation >= 0),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, diagram_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_static_document_state (
      landscape_id       TEXT NOT NULL,
      version_id         TEXT NOT NULL,
      document_id        TEXT NOT NULL,
      source_updated_at  TIMESTAMPTZ NOT NULL,
      projected_generation BIGINT NOT NULL CHECK (projected_generation >= 0),
      projected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, document_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_static_document_state_source
    ON read_model_static_document_state (landscape_id, version_id, source_updated_at)`)
  // Durable hand-off from Automerge storage to the static delta projector.
  // PostgresStorageAdapter increments revision in the SAME transaction as a
  // snapshot/incremental chunk write. The projector advances projected_revision
  // only with its ro_* publication, so a crash in either direction is replayable.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_static_document_queue (
      landscape_id       TEXT NOT NULL,
      version_id         TEXT NOT NULL,
      document_id        TEXT NOT NULL,
      revision           BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      projected_revision BIGINT NOT NULL DEFAULT 0 CHECK (projected_revision >= 0),
      enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      projected_at       TIMESTAMPTZ,
      PRIMARY KEY (landscape_id, version_id, document_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_static_document_queue_pending
    ON read_model_static_document_queue (landscape_id, version_id, enqueued_at)
    WHERE revision > projected_revision`)
  // Protocol-v2 acknowledgement and history state for bounded overlay heads.
  // Batch acknowledgement is committed with the read-model projection, never
  // inferred from a browser-local repo.flush(). Historical snapshots are the
  // three-way merge base when an offline client returns on a retired head.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_overlay_segments (
      landscape_id          TEXT NOT NULL,
      version_id            TEXT NOT NULL,
      collection            TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      document_id           TEXT NOT NULL,
      segment_url           TEXT NOT NULL,
      is_current            BOOLEAN NOT NULL DEFAULT false,
      admitted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      retired_at            TIMESTAMPTZ,
      retain_until          TIMESTAMPTZ,
      last_projected_revision BIGINT NOT NULL DEFAULT 0 CHECK (last_projected_revision >= 0),
      last_projected_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (landscape_id, version_id, collection, document_id)
    )
  `)
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_read_model_overlay_segments_current
    ON read_model_overlay_segments (landscape_id, version_id, collection)
    WHERE is_current`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_overlay_segments_retention
    ON read_model_overlay_segments (retain_until)
    WHERE NOT is_current`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_overlay_rotations (
      landscape_id       TEXT NOT NULL,
      version_id         TEXT NOT NULL,
      collection         TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      old_document_id    TEXT NOT NULL,
      new_document_id    TEXT NOT NULL,
      new_segment_url    TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'admitted'
                         CHECK (status IN ('admitted', 'published', 'superseded')),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at       TIMESTAMPTZ,
      PRIMARY KEY (landscape_id, version_id, collection, new_document_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_overlay_rotations_recovery
    ON read_model_overlay_rotations (status, created_at)
    WHERE status = 'admitted'`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_overlay_batch_acks (
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL,
      batch_id            TEXT NOT NULL,
      document_id         TEXT NOT NULL,
      collection          TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      status              TEXT NOT NULL CHECK (status IN (
        'forwarding', 'forwarding_conflict', 'projected', 'forwarded', 'conflict'
      )),
      source_revision     BIGINT NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
      projected_generation BIGINT NOT NULL DEFAULT 0 CHECK (projected_generation >= 0),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, batch_id)
    )
  `)
  await db.query(`
    DO $$
    BEGIN
      ALTER TABLE read_model_overlay_batch_acks
        DROP CONSTRAINT IF EXISTS read_model_overlay_batch_acks_status_check;
      ALTER TABLE read_model_overlay_batch_acks
        ADD CONSTRAINT read_model_overlay_batch_acks_status_check
        CHECK (status IN (
          'forwarding', 'forwarding_conflict', 'projected', 'forwarded', 'conflict'
        ));
    END $$;
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_overlay_batch_acks_document
    ON read_model_overlay_batch_acks (landscape_id, version_id, document_id, status)`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_overlay_conflicts (
      id                   BIGSERIAL PRIMARY KEY,
      landscape_id         TEXT NOT NULL,
      version_id           TEXT NOT NULL,
      collection           TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      entity_id            TEXT NOT NULL,
      historical_document_id TEXT NOT NULL,
      current_document_id  TEXT NOT NULL,
      batch_ids            TEXT[] NOT NULL DEFAULT '{}',
      conflict_paths       TEXT[] NOT NULL DEFAULT '{}',
      base_value           JSONB,
      historical_value     JSONB,
      current_value        JSONB,
      forwarded_value      JSONB,
      status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at          TIMESTAMPTZ
    )
  `)
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_read_model_overlay_conflicts_open
    ON read_model_overlay_conflicts (
      landscape_id, version_id, collection, entity_id,
      historical_document_id, current_document_id
    ) WHERE status = 'open'`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_overlay_entity_bases (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      collection   TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      document_id  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      data         JSONB,
      existed      BOOLEAN NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, collection, document_id, entity_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_overlay_entity_bases_document
    ON read_model_overlay_entity_bases (
      landscape_id, version_id, collection, document_id
    )`)
  await db.query(`
    DELETE FROM read_model_static_document_queue queue
    USING read_model_static_documents document
    WHERE document.landscape_id = queue.landscape_id
      AND document.version_id = queue.version_id
      AND document.document_id = queue.document_id
      AND document.kind NOT IN ('model-meta', 'object-overlay', 'connection-overlay', 'diagram')
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_decision_records (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      id           TEXT NOT NULL,
      data         JSONB NOT NULL,
      PRIMARY KEY (landscape_id, version_id, id)
    )
  `)
  const needsDecisionRecordScalarBackfill = !(await currentSchemaHasColumn(db, 'ro_decision_records', 'title'))
  await db.query(`ALTER TABLE ro_decision_records
    ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT ''`)
  await db.query(`ALTER TABLE ro_decision_records
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT ''`)
  await db.query(`ALTER TABLE ro_decision_records
    ADD COLUMN IF NOT EXISTS created_at TEXT NOT NULL DEFAULT ''`)
  await db.query(`ALTER TABLE ro_decision_records
    ADD COLUMN IF NOT EXISTS updated_at TEXT NOT NULL DEFAULT ''`)
  await db.query(`ALTER TABLE ro_decision_records
    ADD COLUMN IF NOT EXISTS adr_number INTEGER`)
  await db.query(`ALTER TABLE ro_decision_records
    ADD COLUMN IF NOT EXISTS normalized_title TEXT GENERATED ALWAYS AS (lower(title)) STORED`)
  await db.query(`ALTER TABLE ro_decision_records
    ADD COLUMN IF NOT EXISTS search_document TEXT GENERATED ALWAYS AS (
      lower(title || ' ' || COALESCE(data->>'summary', '') || ' ' || COALESCE(data->>'content', ''))
    ) STORED`)
  if (needsDecisionRecordScalarBackfill) {
    await db.query(`UPDATE ro_decision_records
      SET title = COALESCE(data->>'title', ''), status = COALESCE(data->>'status', ''),
          created_at = COALESCE(data->>'createdAt', ''), updated_at = COALESCE(data->>'updatedAt', ''),
          adr_number = CASE WHEN (data->>'number') ~ '^[0-9]+$' THEN (data->>'number')::integer END`)
  }
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_decision_records_title_trgm
    ON ro_decision_records USING gin (normalized_title public.gin_trgm_ops)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_decision_records_search_trgm
    ON ro_decision_records USING gin (search_document public.gin_trgm_ops)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_decision_records_related
    ON ro_decision_records USING gin (data jsonb_path_ops)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_decision_records_created_c_page
    ON ro_decision_records (
      landscape_id, version_id, created_at COLLATE "C" DESC, id COLLATE "C" DESC
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_decision_records_status_created_c_page
    ON ro_decision_records (
      landscape_id, version_id, status, created_at COLLATE "C" DESC, id COLLATE "C" DESC
    )`)

  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_change_events (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      generation   BIGINT NOT NULL CHECK (generation >= 0),
      change_kind  TEXT NOT NULL CHECK (change_kind IN ('objects', 'connections', 'reset')),
      payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, generation)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_change_events_workspace
    ON read_model_change_events (landscape_id, version_id, generation)`)

  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_objects (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      id          TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      technology  TEXT NOT NULL DEFAULT '',
      domain_id   TEXT,
      parent_id   TEXT,
      effective_parent_id TEXT,
      scope       TEXT,
      status      TEXT,
      data        JSONB NOT NULL,
      PRIMARY KEY (landscape_id, version_id, id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_parent ON ro_objects (landscape_id, version_id, parent_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_domain ON ro_objects (landscape_id, version_id, domain_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_name_trgm ON ro_objects USING gin (lower(name) public.gin_trgm_ops)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_desc_trgm ON ro_objects USING gin (lower(description) public.gin_trgm_ops)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_tech_trgm ON ro_objects USING gin (lower(technology) public.gin_trgm_ops)`)
  await db.query(`ALTER TABLE ro_objects
    ADD COLUMN IF NOT EXISTS normalized_name TEXT GENERATED ALWAYS AS (lower(name)) STORED`)
  await db.query(`ALTER TABLE ro_objects
    ADD COLUMN IF NOT EXISTS effective_parent_id TEXT`)
  await db.query(`ALTER TABLE ro_objects
    ADD COLUMN IF NOT EXISTS tree_sort_order INTEGER GENERATED ALWAYS AS (
      CASE type WHEN 'system' THEN 1 WHEN 'actor' THEN 2 WHEN 'app' THEN 3
        WHEN 'store' THEN 4 WHEN 'component' THEN 5 ELSE 9 END
    ) STORED`)
  await db.query(`ALTER TABLE ro_objects
    ADD COLUMN IF NOT EXISTS search_document TEXT
      GENERATED ALWAYS AS (lower(name || ' ' || description || ' ' || technology)) STORED`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_tree_name
    ON ro_objects (landscape_id, version_id, parent_id, normalized_name text_pattern_ops, id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_name_prefix
    ON ro_objects (landscape_id, version_id, normalized_name text_pattern_ops, id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_effective_tree
    ON ro_objects (
      landscape_id, version_id, effective_parent_id, tree_sort_order,
      normalized_name text_pattern_ops, id
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_effective_name_c_page
    ON ro_objects (
      landscape_id, version_id, effective_parent_id,
      normalized_name COLLATE "C", id COLLATE "C"
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_search_trgm
    ON ro_objects USING gin (search_document public.gin_trgm_ops)`)
  // The C4 parent with dangling links repaired to NULL: `parent_id` when that
  // parent row exists, else NULL. The Model Viewer's levels follow it — unlike
  // `effective_parent_id` it ignores Group membership, and unlike raw
  // `parent_id` an object whose parent was deleted is a root instead of being
  // reachable at no level. Maintained by `refreshEffectiveParents` in
  // projector.ts; rows that predate the column are backfilled once by the
  // `0005-ro-objects-c4-parent` migration (`backfillC4ParentIds` below).
  await db.query(`ALTER TABLE ro_objects
    ADD COLUMN IF NOT EXISTS c4_parent_id TEXT`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_objects_c4_name_c_page
    ON ro_objects (
      landscape_id, version_id, c4_parent_id,
      normalized_name COLLATE "C", id COLLATE "C"
    )`)

  // One row per governed technology usage. Deliberately no FK to the central
  // catalogue: shard delivery can precede catalogue metadata and historical
  // references to retired/redirected technologies must stay queryable.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_object_technologies (
      landscape_id     TEXT NOT NULL,
      version_id       TEXT NOT NULL,
      org_id           TEXT,
      object_id        TEXT NOT NULL,
      usage_id         TEXT NOT NULL,
      technology_id    TEXT NOT NULL,
      catalog_revision INTEGER NOT NULL,
      used_version     TEXT,
      role             TEXT,
      snapshot         JSONB NOT NULL,
      PRIMARY KEY (landscape_id, version_id, object_id, usage_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_object_technologies_lookup
    ON ro_object_technologies (landscape_id, version_id, technology_id, object_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_object_technologies_object
    ON ro_object_technologies (landscape_id, version_id, object_id)`)

  // Group technology postings mirror object postings. Keeping the tables
  // separate preserves the existing object-filter query plan while giving
  // diagram/group filters an indexed path with no JSONB scan.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_group_technologies (
      landscape_id     TEXT NOT NULL,
      version_id       TEXT NOT NULL,
      org_id           TEXT,
      group_id         TEXT NOT NULL,
      usage_id         TEXT NOT NULL,
      technology_id    TEXT NOT NULL,
      catalog_revision INTEGER NOT NULL,
      used_version     TEXT,
      role             TEXT,
      snapshot         JSONB NOT NULL,
      PRIMARY KEY (landscape_id, version_id, group_id, usage_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_group_technologies_lookup
    ON ro_group_technologies (landscape_id, version_id, technology_id, group_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_group_technologies_group
    ON ro_group_technologies (landscape_id, version_id, group_id)`)

  // Sparse, ordered governed Tag assignments. No catalogue FK: a projected
  // shard may arrive before metadata and merged/archived identities remain
  // valid historical references until canonical resolution at query time.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_object_tags (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      object_id    TEXT NOT NULL,
      tag_id       TEXT NOT NULL,
      ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
      PRIMARY KEY (landscape_id, version_id, object_id, tag_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_object_tags_lookup
    ON ro_object_tags (landscape_id, version_id, tag_id, object_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_object_tags_object
    ON ro_object_tags (landscape_id, version_id, object_id, ordinal)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_object_tags_org_usage
    ON ro_object_tags (org_id, tag_id, object_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_object_tags_org_usage_page
    ON ro_object_tags (org_id, tag_id, landscape_id, version_id, object_id)`)

  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_group_tags (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      group_id     TEXT NOT NULL,
      tag_id       TEXT NOT NULL,
      ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
      PRIMARY KEY (landscape_id, version_id, group_id, tag_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_group_tags_lookup
    ON ro_group_tags (landscape_id, version_id, tag_id, group_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_group_tags_group
    ON ro_group_tags (landscape_id, version_id, group_id, ordinal)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_group_tags_org_usage
    ON ro_group_tags (org_id, tag_id, group_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_group_tags_org_usage_page
    ON ro_group_tags (org_id, tag_id, landscape_id, version_id, group_id)`)

  // One row per object/team association. This keeps the Teams filter facet an
  // index-only query instead of expanding JSONB across every object on each view.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_object_teams (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      object_id    TEXT NOT NULL,
      team_id      TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, object_id, team_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_object_teams_facet
    ON ro_object_teams (landscape_id, version_id, team_id)`)

  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_connections (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      id      TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id   TEXT NOT NULL,
      label   TEXT NOT NULL DEFAULT '',
      kind    TEXT,
      data    JSONB NOT NULL,
      PRIMARY KEY (landscape_id, version_id, id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_conn_from ON ro_connections (landscape_id, version_id, from_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_conn_to ON ro_connections (landscape_id, version_id, to_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_conn_label_trgm ON ro_connections USING gin (lower(label) public.gin_trgm_ops)`)
  await db.query(`ALTER TABLE ro_connections
    ADD COLUMN IF NOT EXISTS normalized_label TEXT GENERATED ALWAYS AS (lower(label)) STORED`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connections_name_page
    ON ro_connections (landscape_id, version_id, normalized_label, id)`)
  // ConnectionExplorer orders with explicit C collation for stable signed
  // keyset cursors. The legacy default-collation index cannot satisfy that
  // ORDER BY and made PostgreSQL scan/sort all 300k rows (including temp IO)
  // for a 50-row page. Keep a separately named migration-safe covering order.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connections_name_c_page
    ON ro_connections (
      landscape_id, version_id, normalized_label COLLATE "C", id COLLATE "C"
    )`)

  // Groups are small + not sharded (inline in ModelMeta on the client), so they
  // sync as a full set. Stored for lookupMany / connection-endpoint name resolution.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_groups (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      id   TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      data JSONB NOT NULL,
      PRIMARY KEY (landscape_id, version_id, id)
    )
  `)
  await db.query(`ALTER TABLE ro_groups
    ADD COLUMN IF NOT EXISTS normalized_name TEXT GENERATED ALWAYS AS (lower(name)) STORED`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_groups_name_prefix
    ON ro_groups (landscape_id, version_id, normalized_name text_pattern_ops, id)`)

  // Normalized group membership keeps root/child navigation O(page) and avoids
  // probing every group's JSON objectIds array for each disclosure click.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_group_objects (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      group_id     TEXT NOT NULL,
      object_id    TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, group_id, object_id)
    )
  `)
  const needsEffectiveParentBackfill = !(await currentSchemaHasColumn(db, 'ro_objects', 'effective_parent_id'))
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_group_objects_object
    ON ro_group_objects (landscape_id, version_id, object_id, group_id)`)
  // One indexed parent relation powers both roots and disclosure children.
  // Existing rows are repaired idempotently after the membership table exists;
  // normal projector writes maintain this column incrementally.
  if (needsEffectiveParentBackfill) {
    await db.query(`
      UPDATE ro_objects object
      SET effective_parent_id = membership.group_id
      FROM (
        SELECT landscape_id, version_id, object_id, min(group_id) AS group_id
        FROM ro_group_objects GROUP BY landscape_id, version_id, object_id
      ) membership
      WHERE object.landscape_id = membership.landscape_id
        AND object.version_id = membership.version_id
        AND object.id = membership.object_id
    `)
    await db.query(`
      UPDATE ro_objects object
      SET effective_parent_id = CASE WHEN EXISTS (
        SELECT 1 FROM ro_objects parent
        WHERE parent.landscape_id = object.landscape_id
          AND parent.version_id = object.version_id AND parent.id = object.parent_id
      ) THEN object.parent_id ELSE NULL END
      WHERE NOT EXISTS (
        SELECT 1 FROM ro_group_objects membership
        WHERE membership.landscape_id = object.landscape_id
          AND membership.version_id = object.version_id AND membership.object_id = object.id
      )
    `)
  }

  // Diagram registry (DiagramMeta) for relatedDiagrams — reference (object_ids
  // contains the object), detail (parent_object_id = object), parent
  // (parent_object_id = object's parent). GIN(object_ids) for the @> membership
  // test; B-tree(landscape_id, version_id, parent_object_id) for detail/parent.
  // `data` is the diagram stub.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_diagrams (
      landscape_id     TEXT NOT NULL,
      version_id       TEXT NOT NULL,
      org_id           TEXT,
      id               TEXT NOT NULL,
      parent_object_id TEXT,
      object_ids       TEXT[] NOT NULL DEFAULT '{}',
      data             JSONB NOT NULL,
      PRIMARY KEY (landscape_id, version_id, id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagrams_parent ON ro_diagrams (landscape_id, version_id, parent_object_id)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagrams_objects ON ro_diagrams USING gin (object_ids)`)

  // Diagram membership is queried for at most one result page, but a normalized
  // covering index is substantially cheaper and gives stable plans at 100k+.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_diagram_objects (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      diagram_id   TEXT NOT NULL,
      object_id    TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, diagram_id, object_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagram_objects_object
    ON ro_diagram_objects (landscape_id, version_id, object_id, diagram_id)`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_diagram_groups (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      diagram_id   TEXT NOT NULL,
      group_id     TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, diagram_id, group_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagram_groups_group
    ON ro_diagram_groups (landscape_id, version_id, group_id, diagram_id)`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_diagram_connections (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      diagram_id   TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, diagram_id, connection_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagram_connections_connection
    ON ro_diagram_connections (landscape_id, version_id, connection_id, diagram_id)`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_connection_flows (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      diagram_id   TEXT NOT NULL,
      flow_id      TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, diagram_id, flow_id, connection_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connection_flows_connection
    ON ro_connection_flows (landscape_id, version_id, connection_id, flow_id)`)

  // Flow names and the objects each flow's steps touch (a process step's
  // object, a message step's sender and receiver), so the Details panel can
  // answer "which flows use this object" without opening every DiagramDoc.
  // Both are replaced per diagram, exactly like ro_connection_flows.
  //
  // ro_diagram_flow_index is the COVERAGE witness: a row means this diagram's
  // flows were projected by a writer that maintains the two tables above. A
  // diagram projected before they existed has flow rows nowhere, and there is
  // no SQL backfill (flows live only in DiagramDocs), so an answer over a
  // diagram without a witness row is reported incomplete, never as zero.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_flows (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      diagram_id   TEXT NOT NULL,
      flow_id      TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (landscape_id, version_id, diagram_id, flow_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_flow_objects (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      diagram_id   TEXT NOT NULL,
      flow_id      TEXT NOT NULL,
      object_id    TEXT NOT NULL,
      PRIMARY KEY (landscape_id, version_id, diagram_id, flow_id, object_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_flow_objects_object
    ON ro_flow_objects (landscape_id, version_id, object_id, diagram_id, flow_id)`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_diagram_flow_index (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      diagram_id   TEXT NOT NULL,
      index_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (landscape_id, version_id, diagram_id)
    )
  `)

  // Compact, scalar projections for the highest-volume list/explorer paths.
  // These rows are derived and replay-safe: projector writes maintain them and
  // the INSERTs below backfill an older read model once on upgrade.
  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_diagram_summaries (
      landscape_id       TEXT NOT NULL,
      version_id         TEXT NOT NULL,
      org_id             TEXT,
      diagram_id         TEXT NOT NULL,
      name               TEXT NOT NULL DEFAULT '',
      normalized_name    TEXT GENERATED ALWAYS AS (lower(name)) STORED,
      type               TEXT NOT NULL DEFAULT '',
      domain_id          TEXT,
      parent_object_id   TEXT,
      object_count       INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0),
      connection_count   INTEGER NOT NULL DEFAULT 0 CHECK (connection_count >= 0),
      group_count        INTEGER NOT NULL DEFAULT 0 CHECK (group_count >= 0),
      preview_object_ids TEXT[] NOT NULL DEFAULT '{}',
      preview_object_types TEXT[] NOT NULL DEFAULT '{}',
      data               JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (landscape_id, version_id, diagram_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagram_summaries_name_trgm
    ON ro_diagram_summaries USING gin (normalized_name public.gin_trgm_ops)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagram_summaries_name_c_page
    ON ro_diagram_summaries (
      landscape_id, version_id, normalized_name COLLATE "C", diagram_id COLLATE "C"
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagram_summaries_type_c_page
    ON ro_diagram_summaries (
      landscape_id, version_id, type, normalized_name COLLATE "C", diagram_id COLLATE "C"
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_diagram_summaries_domain_c_page
    ON ro_diagram_summaries (
      landscape_id, version_id, domain_id, normalized_name COLLATE "C", diagram_id COLLATE "C"
    )`)

  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_connection_stats (
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL,
      org_id              TEXT,
      connection_id       TEXT NOT NULL,
      diagram_count       INTEGER NOT NULL DEFAULT 0 CHECK (diagram_count >= 0),
      flow_count          INTEGER NOT NULL DEFAULT 0 CHECK (flow_count >= 0),
      from_name           TEXT NOT NULL DEFAULT '',
      normalized_from_name TEXT GENERATED ALWAYS AS (lower(from_name)) STORED,
      from_icon           TEXT,
      from_type           TEXT,
      from_domain_id      TEXT,
      to_name             TEXT NOT NULL DEFAULT '',
      normalized_to_name  TEXT GENERATED ALWAYS AS (lower(to_name)) STORED,
      to_icon             TEXT,
      to_type             TEXT,
      to_domain_id        TEXT,
      PRIMARY KEY (landscape_id, version_id, connection_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connection_stats_sender_c_page
    ON ro_connection_stats (
      landscape_id, version_id, normalized_from_name COLLATE "C", connection_id COLLATE "C"
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connection_stats_receiver_c_page
    ON ro_connection_stats (
      landscape_id, version_id, normalized_to_name COLLATE "C", connection_id COLLATE "C"
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connection_stats_diagram_c_page
    ON ro_connection_stats (
      landscape_id, version_id, diagram_count, connection_id COLLATE "C"
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connection_stats_flow_c_page
    ON ro_connection_stats (
      landscape_id, version_id, flow_count, connection_id COLLATE "C"
    )`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connection_stats_from_name_trgm
    ON ro_connection_stats USING gin (normalized_from_name public.gin_trgm_ops)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ro_connection_stats_to_name_trgm
    ON ro_connection_stats USING gin (normalized_to_name public.gin_trgm_ops)`)

  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_object_child_stats (
      landscape_id TEXT NOT NULL,
      version_id   TEXT NOT NULL,
      org_id       TEXT,
      object_id    TEXT NOT NULL,
      child_count  INTEGER NOT NULL DEFAULT 0 CHECK (child_count >= 0),
      PRIMARY KEY (landscape_id, version_id, object_id)
    )
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS ro_workspace_stats (
      landscape_id         TEXT NOT NULL,
      version_id           TEXT NOT NULL,
      org_id               TEXT,
      object_count         BIGINT NOT NULL DEFAULT 0 CHECK (object_count >= 0),
      connection_count     BIGINT NOT NULL DEFAULT 0 CHECK (connection_count >= 0),
      diagram_count        BIGINT NOT NULL DEFAULT 0 CHECK (diagram_count >= 0),
      decision_record_count BIGINT NOT NULL DEFAULT 0 CHECK (decision_record_count >= 0),
      group_count          BIGINT NOT NULL DEFAULT 0 CHECK (group_count >= 0),
      root_object_count    BIGINT NOT NULL DEFAULT 0 CHECK (root_object_count >= 0),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id)
    )
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  const migration = await db.query<{ applied: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM read_model_schema_migrations WHERE name = $1
     ) AS applied`,
    ['phase5-derived-read-model-v1'],
  )
  if (!migration.rows[0]?.applied) {
    await backfillDerivedReadModel(db)
    await db.query(
      `INSERT INTO read_model_schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING`,
      ['phase5-derived-read-model-v1'],
    )
  }
}

/** Every workspace's `c4_parent_id`, repaired in place. Run once by the
 * `0005-ro-objects-c4-parent` migration (server/src/db/schemaMigrations.ts),
 * which upgrades rows written before the column existed (all NULL — every
 * object would read as a root).
 *
 * WRITES ONLY WRONG ROWS — both statements are guarded — so re-running it is
 * safe, and on a consistent table it is a read-only pass. That is the remedy
 * for the one writer the migration cannot fence: an OLD-code cell still
 * serving during a rolling deploy writes `ro_objects` without this column,
 * after the migration has been recorded. A workspace it served is repaired
 * when a new-code cell takes it over — ordinary ones by the cold build every
 * projector start runs, static ones by this function scoped to the workspace,
 * once per attach (`StaticDeltaProjector.repairC4ParentsOnAttach`, through
 * `repairWorkspaceC4ParentIds`). Costs measured with
 * server/scripts/measure-viewer-level-c4.ts. */
export async function backfillC4ParentIds(
  db: Queryable,
  workspace?: { landscapeId: string; versionId: string },
): Promise<void> {
  // Scoped to one workspace by the tests and the measurement script; every
  // workspace for the migration, whose runner passes the client alone. Collects
  // no ids: the migration rewrites up to every row of the table.
  await repairC4ParentStatements(db, workspace, false)
}

/** `backfillC4ParentIds` scoped to ONE workspace, returning the ids of the
 * rows it changed — the static projector publishes them on the change feed so
 * a browser cache holding the drifted `c4ParentId` refetches them. Empty on a
 * consistent workspace (both statements write only wrong rows). The two
 * statements' row sets are disjoint (a parent that exists vs one that does
 * not) as long as nothing deletes a parent between them — true under the
 * projection mutex and ownership fence the caller holds; `appendReadModelChange`
 * dedupes the list either way. */
export function repairWorkspaceC4ParentIds(
  db: Queryable,
  workspace: { landscapeId: string; versionId: string },
): Promise<string[]> {
  return repairC4ParentStatements(db, workspace, true)
}

async function repairC4ParentStatements(
  db: Queryable,
  workspace: { landscapeId: string; versionId: string } | undefined,
  collect: boolean,
): Promise<string[]> {
  const params = workspace ? [workspace.landscapeId, workspace.versionId] : []
  const scoped = workspace ? 'AND object.landscape_id = $1 AND object.version_id = $2' : ''
  const returning = collect ? 'RETURNING object.id' : ''
  const attached = await db.query<{ id: string }>(`
    UPDATE ro_objects object
    SET c4_parent_id = parent.id
    FROM ro_objects parent
    WHERE parent.landscape_id = object.landscape_id
      AND parent.version_id = object.version_id
      AND parent.id = object.parent_id
      AND object.c4_parent_id IS DISTINCT FROM parent.id
      ${scoped}
    ${returning}
  `, params)
  const dangling = await db.query<{ id: string }>(`
    UPDATE ro_objects object
    SET c4_parent_id = NULL
    WHERE object.c4_parent_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ro_objects parent
        WHERE parent.landscape_id = object.landscape_id
          AND parent.version_id = object.version_id
          AND parent.id = object.parent_id
      )
      ${scoped}
    ${returning}
  `, params)
  return collect ? [...attached.rows, ...dangling.rows].map((row) => row.id) : []
}

async function backfillDerivedReadModel(db: Queryable): Promise<void> {
  await db.query(`
    INSERT INTO ro_diagram_summaries (
      landscape_id, version_id, org_id, diagram_id, name, type, domain_id,
      parent_object_id, object_count, connection_count, group_count,
      preview_object_ids, preview_object_types, data
    )
    SELECT diagram.landscape_id, diagram.version_id, diagram.org_id, diagram.id,
           COALESCE(diagram.data->>'name', ''), COALESCE(diagram.data->>'type', ''),
           NULLIF(diagram.data->>'domainId', ''), diagram.parent_object_id,
           cardinality(diagram.object_ids),
           jsonb_array_length(COALESCE(diagram.data->'connectionIds', '[]'::jsonb)),
           jsonb_array_length(COALESCE(diagram.data->'groupIds', '[]'::jsonb)),
           diagram.object_ids[1:12],
           COALESCE((
             SELECT array_agg(COALESCE(object.type, '') ORDER BY member.ordinality)
             FROM unnest(diagram.object_ids[1:12]) WITH ORDINALITY member(object_id, ordinality)
             LEFT JOIN ro_objects object
               ON object.landscape_id = diagram.landscape_id
              AND object.version_id = diagram.version_id AND object.id = member.object_id
           ), '{}'::text[]),
           diagram.data - 'layouts' - 'comments' - 'flows' - 'checkpoints'
                          - 'objectIds' - 'connectionIds' - 'groupIds'
    FROM ro_diagrams diagram
    ON CONFLICT (landscape_id, version_id, diagram_id) DO NOTHING
  `)
  await db.query(`
    INSERT INTO ro_connection_stats (
      landscape_id, version_id, org_id, connection_id, diagram_count, flow_count,
      from_name, from_icon, from_type, from_domain_id,
      to_name, to_icon, to_type, to_domain_id
    )
    SELECT connection.landscape_id, connection.version_id, connection.org_id, connection.id,
           COALESCE(diagrams.total, 0), COALESCE(flows.total, 0),
           COALESCE(from_object.name, from_group.name, ''),
           COALESCE(from_object.data->>'icon', from_group.data->>'icon'),
           COALESCE(from_object.type, 'group'),
           COALESCE(from_object.domain_id, from_group.data->>'domainId'),
           COALESCE(to_object.name, to_group.name, ''),
           COALESCE(to_object.data->>'icon', to_group.data->>'icon'),
           COALESCE(to_object.type, 'group'),
           COALESCE(to_object.domain_id, to_group.data->>'domainId')
    FROM ro_connections connection
    LEFT JOIN ro_objects from_object ON from_object.landscape_id = connection.landscape_id
      AND from_object.version_id = connection.version_id AND from_object.id = connection.from_id
    LEFT JOIN ro_groups from_group ON from_group.landscape_id = connection.landscape_id
      AND from_group.version_id = connection.version_id AND from_group.id = connection.from_id
    LEFT JOIN ro_objects to_object ON to_object.landscape_id = connection.landscape_id
      AND to_object.version_id = connection.version_id AND to_object.id = connection.to_id
    LEFT JOIN ro_groups to_group ON to_group.landscape_id = connection.landscape_id
      AND to_group.version_id = connection.version_id AND to_group.id = connection.to_id
    LEFT JOIN (
      SELECT landscape_id, version_id, connection_id, count(*)::integer AS total
      FROM ro_diagram_connections GROUP BY landscape_id, version_id, connection_id
    ) diagrams ON diagrams.landscape_id = connection.landscape_id
      AND diagrams.version_id = connection.version_id AND diagrams.connection_id = connection.id
    LEFT JOIN (
      SELECT landscape_id, version_id, connection_id, count(DISTINCT (diagram_id, flow_id))::integer AS total
      FROM ro_connection_flows GROUP BY landscape_id, version_id, connection_id
    ) flows ON flows.landscape_id = connection.landscape_id
      AND flows.version_id = connection.version_id AND flows.connection_id = connection.id
    ON CONFLICT (landscape_id, version_id, connection_id) DO NOTHING
  `)
  await db.query(`
    INSERT INTO ro_object_child_stats (landscape_id, version_id, org_id, object_id, child_count)
    SELECT child.landscape_id, child.version_id, max(child.org_id),
           child.effective_parent_id, count(*)::integer
    FROM ro_objects child
    WHERE child.effective_parent_id IS NOT NULL
    GROUP BY child.landscape_id, child.version_id, child.effective_parent_id
    ON CONFLICT (landscape_id, version_id, object_id) DO NOTHING
  `)
  await db.query(`
    INSERT INTO ro_workspace_stats (
      landscape_id, version_id, org_id, object_count, connection_count,
      diagram_count, decision_record_count, group_count, root_object_count
    )
    SELECT workspace.landscape_id, workspace.version_id, max(workspace.org_id),
           (SELECT count(*) FROM ro_objects row WHERE row.landscape_id = workspace.landscape_id AND row.version_id = workspace.version_id),
           (SELECT count(*) FROM ro_connections row WHERE row.landscape_id = workspace.landscape_id AND row.version_id = workspace.version_id),
           (SELECT count(*) FROM ro_diagrams row WHERE row.landscape_id = workspace.landscape_id AND row.version_id = workspace.version_id),
           (SELECT count(*) FROM ro_decision_records row WHERE row.landscape_id = workspace.landscape_id AND row.version_id = workspace.version_id),
           (SELECT count(*) FROM ro_groups row WHERE row.landscape_id = workspace.landscape_id AND row.version_id = workspace.version_id),
           (SELECT count(*) FROM ro_objects row WHERE row.landscape_id = workspace.landscape_id AND row.version_id = workspace.version_id AND row.effective_parent_id IS NULL)
    FROM (
      SELECT landscape_id, version_id, org_id FROM ro_objects
      UNION ALL SELECT landscape_id, version_id, org_id FROM ro_connections
      UNION ALL SELECT landscape_id, version_id, org_id FROM ro_diagrams
      UNION ALL SELECT landscape_id, version_id, org_id FROM ro_decision_records
      UNION ALL SELECT landscape_id, version_id, org_id FROM ro_groups
    ) workspace
    GROUP BY workspace.landscape_id, workspace.version_id
    ON CONFLICT (landscape_id, version_id) DO NOTHING
  `)
}

/** True if `ro_objects` exists IN THE CONNECTION'S OWN `current_schema()`
 * (the first search_path entry — where `CREATE TABLE IF NOT EXISTS` always
 * lands) but predates the workspace-keying migration (no landscape_id
 * column). Deliberately schema-qualified rather than an unqualified
 * `information_schema`/`to_regclass` scan (which resolves through the WHOLE
 * search_path): this must agree exactly with what `dropReadModelSchema` is
 * about to drop, or a same-named `ro_objects` sitting in a LATER search_path
 * schema (e.g. `public`, already migrated) could be read here while a
 * different, still-legacy one in `current_schema()` goes undetected — or vice
 * versa, wrongly flagging an already-migrated table as legacy because a
 * legacy one exists further down the path. */
async function hasLegacySchema(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.ro_objects') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM pg_attribute
         WHERE attrelid = to_regclass(current_schema() || '.ro_objects')
           AND attname = 'landscape_id' AND NOT attisdropped
       ) AS exists`
  )
  return rows[0]?.exists ?? false
}

async function currentSchemaHasColumn(
  db: Queryable,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = to_regclass(current_schema() || '.' || $1)
         AND attname = $2 AND NOT attisdropped
     ) AS exists`,
    [table, column],
  )
  return rows[0]?.exists ?? false
}

/** Drop the read-model tables (used by self-heal rebuild paths + tests + the
 * legacy-schema migration above).
 *
 * Every DROP is qualified against `current_schema()` (the connection's own
 * FIRST search_path entry — where `CREATE TABLE IF NOT EXISTS` always lands,
 * see `ensureReadModelSchema`'s doc comment) via a `DO` block, rather than a
 * bare `DROP TABLE IF EXISTS ro_objects`. A bare DROP resolves through the
 * WHOLE search_path: `hasLegacySchema` only inspects `ro_objects`, so on a
 * fresh isolated schema where `ro_objects` is legacy but `ro_connections` /
 * `ro_groups` / `ro_diagrams` don't exist there YET, a bare drop of those
 * three would fall through and destroy the SAME-NAMED tables in a later
 * search_path entry (e.g. `public`) instead of doing nothing — exactly the
 * kind of cross-schema data loss this migration must never risk. */
export async function dropReadModelSchema(db: Queryable): Promise<void> {
  await db.query(`
    DO $$
    DECLARE s text := current_schema();
    BEGIN
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_object_technologies', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_group_technologies', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_object_tags', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_group_tags', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_object_teams', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_group_objects', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_diagram_objects', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_diagram_groups', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_diagram_connections', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_connection_flows', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_flows', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_flow_objects', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_diagram_flow_index', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_diagram_summaries', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_connection_stats', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_object_child_stats', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_workspace_stats', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_decision_records', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.read_model_schema_migrations', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_objects', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_connections', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_groups', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.ro_diagrams', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.read_model_change_events', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.read_model_projection_state', s);
    END $$;
  `)
}
