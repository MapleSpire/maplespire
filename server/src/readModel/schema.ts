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

import type { PoolClient } from 'pg'
import type { Queryable } from './types.js'
import { PROTOCOL_FENCE_ROWS_SETTING } from './health.js'
import {
  LOCK_ORDER_RULE_SINCE,
  PARTICIPANT_VERSION_SQL,
  PROTOCOL_TAG_PREFIX,
  READ_MODEL_PROTOCOL_VERSION,
} from './protocolParticipant.js'
import { ensureSpotlightSchema } from './spotlightSql.js'
import { ensureModelEpochSchema } from './modelEpochStore.js'

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
 *  - ro_objects:     GIN(pg_trgm) on lower(name) and on search_document (name,
 *                    description and technology) for substring search;
 *                    B-tree on (landscape_id, version_id, parent_id) /
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
  // G4-16f C6b: the heads of the revision the row's projection SAMPLED,
  // written in the statement that writes the watermark (`arrivalWatermark.ts`,
  // `replaceProjectedWatermarks`); NULL when the writer has none, and on
  // every row written before the column. An adopter seeds a shard from the
  // document AT these heads and refuses NULL. GUARDED: this table is written
  // by every projection, and an unguarded ALTER would queue for ACCESS
  // EXCLUSIVE on it at every boot.
  if (!(await currentSchemaHasColumn(db, 'read_model_document_watermarks', 'projected_heads'))) {
    await db.query(`ALTER TABLE read_model_document_watermarks ADD COLUMN IF NOT EXISTS projected_heads TEXT[]`)
  }
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
  // `duplicate_id_count`: how many of `defect_count` are `duplicate-id`
  // defects (an id dropped, the last occurrence kept — `lastOccurrenceById`),
  // written with it and by the same full extractions. Kept apart so the
  // unreadable-document gauge counts documents only
  // (`fleetDefectSummary`). NULL on a row last stamped before it existed.
  // `defect_count` itself still counts both, so every reader that refuses on
  // `defect_count > 0` still refuses on a duplicate.
  //
  // `duplicate_ids_observed_at`: the `defects_observed_at` of the UPDATE that
  // wrote `duplicate_id_count` (`stampProjectionIntegrity` sets both to the
  // same `now()`). A writer that predates the column — the previous
  // release's stamp, on a mixed-version fleet or after a rollback — rewrites `defect_count` and
  // `defects_observed_at` and leaves these two alone, so the pair stops
  // matching and every reader treats `duplicate_id_count` as unknown
  // (`DUPLICATE_IDS_SQL`, projectionIntegrity.ts). No CHECK ties the
  // columns together: that older UPDATE would then fail.
  //
  // One statement for both columns: each ALTER TABLE asks for ACCESS
  // EXCLUSIVE even when the columns exist.
  await db.query(`ALTER TABLE read_model_projection_state
    ADD COLUMN IF NOT EXISTS duplicate_id_count INTEGER,
    ADD COLUMN IF NOT EXISTS duplicate_ids_observed_at TIMESTAMPTZ`)
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
  // T-DIAGDEF: the write-head partial index, PLAIN here
  // only on an empty table; migration 0008 builds it CONCURRENTLY elsewhere.
  await ensureStaticMembershipHeadIndexOnEmptyTable(db)
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
  // ORDINARY-plane overlay head retirements (`ordinaryHeadForwarding.ts`).
  // A row with status `retired` names a write head that is no longer current
  // and the heads (H_r) up to which its content is already published; every
  // later change is forwarded into the current head instead of being projected
  // from the retired one. `forwarded_heads` is how far forwarding has got.
  // No row (a head retired by compaction) keeps the direct projection.
  // `admitted` is a rotation that has not recorded H_r yet and is treated like
  // no row. Its production writer is the phase-3 rotator
  // (`ordinaryHeadRotator.ts`), which only ever writes `retired` WITH H_r.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_ordinary_head_retirements (
      landscape_id      TEXT NOT NULL,
      version_id        TEXT NOT NULL,
      collection        TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      document_id       TEXT NOT NULL,
      retirement_heads  TEXT[],
      forwarded_heads   TEXT[],
      status            TEXT NOT NULL DEFAULT 'admitted'
                        CHECK (status IN ('admitted', 'retired')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, collection, document_id),
      CHECK (status <> 'retired' OR retirement_heads IS NOT NULL)
    )
  `)
  // G4-16b phase 4: a retired head merged into a fold product
  // (`ordinaryChainFold.ts`) is `folded`. It keeps H_r and `forwarded_heads`
  // and keeps forwarding late writes; `folded_into` names the product and
  // `retain_until` how long its document must outlive its last listing.
  // `arrival_watermark` (phase 4 step 4): the highest `automerge_storage`
  // arrival of a folded head the projector has already forwarded past; an
  // arrival beyond it is a late write to carry (`ordinaryFoldedArrivals.ts`).
  await db.query(`
    ALTER TABLE read_model_ordinary_head_retirements
      ADD COLUMN IF NOT EXISTS folded_into TEXT,
      ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS arrival_watermark BIGINT
  `)
  // GUARDED, not dropped and re-added: this runs on every boot, and an ALTER
  // takes ACCESS EXCLUSIVE on a table a rotator or forwarder may hold. The
  // status CHECK is replaced only while its definition lacks `folded`; the
  // folded CHECK is added once, by name. `pg_get_constraintdef` runs in the
  // SELECT list, never in the WHERE: there the planner may call it on another
  // table's constraint, and one being dropped concurrently (another schema's
  // DROP ... CASCADE) fails the whole statement with "could not open relation".
  await db.query(`
    DO $$
    DECLARE
      status_check TEXT;
    BEGIN
      SELECT pg_get_constraintdef(oid) INTO status_check FROM pg_constraint
      WHERE conrelid = to_regclass(current_schema() || '.read_model_ordinary_head_retirements')
        AND conname = 'read_model_ordinary_head_retirements_status_check';
      IF status_check IS NULL OR status_check NOT LIKE '%folded%' THEN
        ALTER TABLE read_model_ordinary_head_retirements
          DROP CONSTRAINT IF EXISTS read_model_ordinary_head_retirements_status_check;
        ALTER TABLE read_model_ordinary_head_retirements
          ADD CONSTRAINT read_model_ordinary_head_retirements_status_check
          CHECK (status IN ('admitted', 'retired', 'folded'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = to_regclass(current_schema() || '.read_model_ordinary_head_retirements')
          AND conname = 'read_model_ordinary_head_retirements_folded_check'
      ) THEN
        ALTER TABLE read_model_ordinary_head_retirements
          ADD CONSTRAINT read_model_ordinary_head_retirements_folded_check
          CHECK ((status = 'folded') = (folded_into IS NOT NULL)
            AND (status = 'folded') = (retain_until IS NOT NULL)
            AND (status <> 'folded' OR retirement_heads IS NOT NULL));
      END IF;
    END $$;
  `)
  // One row per fold product: the authority a projector checks before it
  // accepts a segment marked `foldedFromUrls` (`ordinaryChainFold.ts`).
  // Written with the sources' `folded` rows in ONE transaction, before the
  // ModelMeta change that lists the product.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_ordinary_chain_folds (
      landscape_id         TEXT NOT NULL,
      version_id           TEXT NOT NULL,
      collection           TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      product_document_id  TEXT NOT NULL,
      source_document_ids  TEXT[] NOT NULL CHECK (cardinality(source_document_ids) > 0),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, collection, product_document_id)
    )
  `)
  // The writer reads the LATEST fold of a kind on every pass.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_ordinary_chain_folds_latest
    ON read_model_ordinary_chain_folds (landscape_id, version_id, collection, created_at DESC)`)
  await ensureModelEpochSchema(db)
  // G4-16k: where the compaction's rematerialization scan of each overlay
  // segment stopped (`overlayClearRematerialize.ts`). Durable state, like the
  // protocol tables (not dropped with the read model): losing a row makes the
  // next pass read that segment's whole history again, and a field a
  // colleague set back to the value the clear saw after the server wrote
  // hers is then written again (a known gap: no test covers it).
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_overlay_clear_scans (
      landscape_id   TEXT NOT NULL,
      version_id     TEXT NOT NULL,
      collection     TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      document_id    TEXT NOT NULL,
      scanned_heads  TEXT[] NOT NULL,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, collection, document_id)
    )
  `)
  // The grace period runs from the
  // SERVER's first sighting of each late change, never from its author's
  // clock — recorded here, by change hash, while the change waits.
  await db.query(`ALTER TABLE read_model_overlay_clear_scans ADD COLUMN IF NOT EXISTS late_seen JSONB NOT NULL DEFAULT '{}'::jsonb`)
  // The late changes of a parked segment a pass already
  // dealt with — the segment parks for one entry, not for all of them.
  await db.query(`ALTER TABLE read_model_overlay_clear_scans ADD COLUMN IF NOT EXISTS done_changes TEXT[] NOT NULL DEFAULT '{}'`)
  // G4-16e: what WROTE a retirement row — `rotation` (the rotator,
  // `ordinaryHeadRotator.ts`) or `fold-product` (the fold record gives every
  // product a `retired` row so it can be folded again, `ordinaryChainFold.ts`).
  // The durable rotation rate counts the first only. GUARDED like the CHECKs
  // above: the ALTER and its one-time backfill run once, not on every boot.
  // The backfill names the products still recorded; a product whose record a
  // sweep already removed stays NULL and is counted as a rotation.
  if (!(await currentSchemaHasColumn(db, 'read_model_ordinary_head_retirements', 'origin'))) {
    await db.query(`ALTER TABLE read_model_ordinary_head_retirements
      ADD COLUMN IF NOT EXISTS origin TEXT CHECK (origin IN ('rotation', 'fold-product'))`)
    await db.query(`UPDATE read_model_ordinary_head_retirements row SET origin = 'fold-product'
      FROM read_model_ordinary_chain_folds fold
      WHERE row.origin IS NULL AND row.landscape_id = fold.landscape_id AND row.version_id = fold.version_id
        AND row.collection = fold.collection AND row.document_id = fold.product_document_id`)
  }
  // G4-16f, the ADOPT plane: what a later attach could check instead of
  // rebuilding. Written by the ordinary projector's fenced transactions only
  // (`adoptState.ts`). Separate from `read_model_document_watermarks` on
  // purpose: root, ModelMeta, registry shards and the monolith must never
  // enter that table's EXACT freshness branch (the comment at the cold
  // build's stamp in `projectorService.ts` says why). Zero is a stored
  // refusal, exactly as there.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_adopt_watermarks (
      landscape_id     TEXT NOT NULL,
      version_id       TEXT NOT NULL,
      document_id      TEXT NOT NULL,
      adopt_watermark  BIGINT NOT NULL CHECK (adopt_watermark >= 0),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, document_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_adopt_state (
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL,
      format_version      INT NOT NULL,
      org_id              TEXT,
      topology_digest     TEXT NOT NULL,
      retirements_digest  TEXT NOT NULL,
      folds_digest        TEXT NOT NULL,
      defects             INT NOT NULL CHECK (defects >= 0),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id)
    )
  `)
  // `defects` is the cold build's ModelDefect count — unreadable documents
  // AND `duplicate-id` drops, as `defect_count` (the duplicates are not split
  // out here: nothing reads this column yet, and a refusal keyed on it
  // should refuse on both).
  //
  // ADOPT PLANE v2 (G4-16f C6b, `ADOPT_STATE_VERSION` in `adoptState.ts`):
  // the fence binding, the topology as id lists (text[], order and
  // duplicates kept), the seal and the posture. All nullable with no
  // default: every row written before them reads NULL, which an adopter
  // refuses (`adoptRefusal`). ONE statement, so the columns arrive together
  // or not at all, GUARDED like the ALTERs above (an ALTER takes ACCESS
  // EXCLUSIVE on every boot otherwise). No backfill and no ledger entry:
  // NULL is the correct value for an old row.
  if (!(await currentSchemaHasColumn(db, 'read_model_adopt_state', 'adopt_version'))) {
    await db.query(`ALTER TABLE read_model_adopt_state
      ADD COLUMN IF NOT EXISTS adopt_version INT,
      ADD COLUMN IF NOT EXISTS fence_binding TEXT,
      ADD COLUMN IF NOT EXISTS root_document_id TEXT,
      ADD COLUMN IF NOT EXISTS meta_document_id TEXT,
      ADD COLUMN IF NOT EXISTS object_shard_ids TEXT[],
      ADD COLUMN IF NOT EXISTS connection_shard_ids TEXT[],
      ADD COLUMN IF NOT EXISTS registry_shard_ids TEXT[],
      ADD COLUMN IF NOT EXISTS sealed_ceiling INT,
      ADD COLUMN IF NOT EXISTS posture TEXT`)
  }
  await ensureAdoptProtocolTriggers(db)
  // G4-16f: a DERIVED, rebuildable cache of sealed fold products' entity maps
  // (`sealedProductCache.ts`). A header names the exact durable row versions
  // its entities were decoded from (`rows_digest`); a reader serves it only
  // while the current rows have that digest. The cold build's DELETE does NOT
  // touch these two tables (the documents stay the source; deleting the cache
  // is always safe, keeping it across a cold build is the point).
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_sealed_product_extracts (
      landscape_id         TEXT NOT NULL,
      version_id           TEXT NOT NULL,
      collection           TEXT NOT NULL CHECK (collection IN ('object', 'connection')),
      product_document_id  TEXT NOT NULL,
      rows_digest          TEXT NOT NULL,
      heads                TEXT[] NOT NULL,
      max_arrival_seq      BIGINT NOT NULL,
      extraction_version   INT NOT NULL,
      entity_count         INT NOT NULL CHECK (entity_count >= 0),
      refused_reason       TEXT CHECK (refused_reason IN ('decode-refused', 'not-serializable', 'insert-refused')),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, collection, product_document_id)
    )
  `)
  // A REFUSAL remembered against the exact rows it was decided on
  // (`sealedProductCache.ts`, the writer): a header with `refused_reason` and
  // no entities is never a hit, and the writer does not decode those rows
  // again. Added to a table created earlier on this branch; GUARDED like the
  // CHECKs above (an ALTER takes ACCESS EXCLUSIVE on every boot otherwise).
  if (!(await currentSchemaHasColumn(db, 'read_model_sealed_product_extracts', 'refused_reason'))) {
    await db.query(`ALTER TABLE read_model_sealed_product_extracts ADD COLUMN IF NOT EXISTS refused_reason TEXT
      CHECK (refused_reason IN ('decode-refused', 'not-serializable', 'insert-refused'))`)
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_sealed_product_entities (
      landscape_id         TEXT NOT NULL,
      version_id           TEXT NOT NULL,
      collection           TEXT NOT NULL,
      product_document_id  TEXT NOT NULL,
      entity_id            TEXT NOT NULL,
      value                JSONB NOT NULL,
      PRIMARY KEY (landscape_id, version_id, collection, product_document_id, entity_id),
      FOREIGN KEY (landscape_id, version_id, collection, product_document_id)
        REFERENCES read_model_sealed_product_extracts (landscape_id, version_id, collection, product_document_id)
        ON DELETE CASCADE
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_sealed_product_entities_entity
    ON read_model_sealed_product_entities (landscape_id, version_id, collection, entity_id)`)
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
  // No per-column trigram index on `lower(description)` / `lower(technology)`:
  // `idx_ro_objects_search_trgm` below covers both through `search_document`,
  // and `REDUNDANT_OBJECT_TRIGRAM_INDEXES` says what they cost and who drops
  // them on a database that still has them.
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
  // `IF NOT EXISTS` looks at the name only: an INVALID index (a drop by the
  // withdrawn 0007 cut off by its lock bound, or any interrupted CONCURRENTLY
  // build) is kept as it is, and both readers silently lose it.
  await warnIfSearchIndexInvalid(db)
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

  // Spotlight search (spotlightSql.ts): the accent-fold functions and the
  // stored, folded `spot_*` columns over the tables above. After the tables
  // and the ledger it records its fingerprint in; a no-op once built.
  await ensureSpotlightSchema(db)
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

/**
 * The per-column trigram indexes `ensureReadModelSchema` used to create on
 * `ro_objects`, made redundant by `idx_ro_objects_search_trgm`: the one search
 * that could use them (`roSearch`, `RO_SEARCH_OBJECTS_SQL` in queries.ts) now
 * prefilters on `search_document`. Measured 2026-11-08 on the 85 235-object
 * corpus: inserting it into an empty clone of `ro_objects` took 16.0 s with
 * every index and 9.4 s without these two.
 */
export const REDUNDANT_OBJECT_TRIGRAM_INDEXES = ['idx_ro_objects_desc_trgm', 'idx_ro_objects_tech_trgm'] as const

/**
 * Logs, loudly, an `idx_ro_objects_search_trgm` that exists but is INVALID
 * (`NOT (indisvalid AND indisready)`). The baseline's `CREATE INDEX IF NOT
 * EXISTS` skips it (the check is by name), no plan uses it, and nothing else
 * repairs it — it is not on the 0006 retry's list, because this index is
 * KEPT. Measured consequence when it is unusable: the readers' p95 150-190 ms
 * at 20 searches/s on a 10-workspace database. Reported, not repaired: the repair,
 * `REINDEX INDEX CONCURRENTLY`, is an operator's step outside any transaction
 * and outside the boot (docs/schema-migrations.md). Returns whether it was
 * invalid.
 */
export async function warnIfSearchIndexInvalid(
  db: Queryable,
  log: (line: string) => void = (line) => console.error(line),
): Promise<boolean> {
  const result = await db.query<{ valid: boolean }>(
    `SELECT (x.indisvalid AND x.indisready) AS valid
       FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
      WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = 'idx_ro_objects_search_trgm'`,
  )
  // A connection that answers nothing (a test double) reports nothing.
  if (result?.rows?.[0]?.valid !== false) return false
  log(JSON.stringify({
    event: 'read_model.search_index_invalid',
    index: 'idx_ro_objects_search_trgm',
    effect: 'roSearch and the object explorer filter ro_objects unindexed',
    remedy: 'REINDEX INDEX CONCURRENTLY idx_ro_objects_search_trgm (docs/schema-migrations.md)',
  }))
  return true
}

/** Upper bound of one lock wait of the drop, ms; see `dropRedundantObjectTrigramIndexes`. */
export const REDUNDANT_TRIGRAM_DROP_LOCK_WAIT_MS = 500
/** Attempts per index and per boot, and the pause between two. */
export const REDUNDANT_TRIGRAM_DROP_ATTEMPTS = 3
export const REDUNDANT_TRIGRAM_DROP_RETRY_MS = 1_000

/** `lock_not_available` (`lock_timeout` expired) and `deadlock_detected`. */
const DEFERRABLE_DROP_FAILURES = new Set(['55P03', '40P01'])

/**
 * Drop `REDUNDANT_OBJECT_TRIGRAM_INDEXES` where they still exist. Run by the
 * `0006-ro-objects-drop-redundant-trgm` migration (db/schemaMigrations.ts),
 * which is non-transactional (`DROP INDEX CONCURRENTLY` is refused inside a
 * transaction block) and REPEATABLE, so `client` must be in no transaction.
 * Returns the indexes it had to leave for a later boot.
 *
 * CONCURRENTLY, never a plain `DROP INDEX`: the plain form takes ACCESS
 * EXCLUSIVE on `ro_objects`, which every workspace shares, and while it waits
 * for the longest transaction already on the table every new read and write
 * of every workspace queues behind it. The concurrent form holds SHARE UPDATE
 * EXCLUSIVE, which reads and DML do not conflict with, and waits for the
 * transactions already holding a lock on the table rather than blocking the
 * ones after them (both measured, with the plain form as the control, in
 * `redundantTrigramIndexes.integration.test.ts`).
 *
 * BOUNDED, and a bounded failure is DEFERRED, not thrown. SHARE UPDATE
 * EXCLUSIVE does conflict with `ANALYZE`, and a cold build runs a bounded
 * `ANALYZE ro_objects` INSIDE its write transaction (`analyzeWithinCeiling`).
 * Unbounded, the drop waits for that transaction while the transaction waits
 * for the drop's lock: a deadlock, and PostgreSQL aborts whichever backend's
 * `deadlock_timeout` expires first while the cycle exists. Measured
 * (qa/g416f-trgm-drop-probe.mts, deadlock_timeout 1 s, four runs, the same
 * outcome each time): the `ANALYZE` 200 ms after an unbounded drop began
 * waiting → the DROP got 40P01; 1 500 ms after → the cold build's `ANALYZE`
 * got 40P01, which `analyzeWithinCeiling` does not absorb, so that cold build
 * fails. Each lock wait here is therefore bounded below the server's
 * `deadlock_timeout` (`lock_timeout` = the smaller of
 * `REDUNDANT_TRIGRAM_DROP_LOCK_WAIT_MS` and half of it), so the drop gives up
 * before the detector can choose the cold build — measured with this function
 * (one attempt, two runs) and the `ANALYZE` at 100, 300 and 1 500 ms: it ran each time,
 * and the drop deferred. Both failures it can see
 * are retried `REDUNDANT_TRIGRAM_DROP_ATTEMPTS` times and then left for the
 * next boot (the migration is repeatable): a deferred drop costs what the
 * index cost before, and failing the boot over an optimisation would cost
 * far more. The same bound keeps a boot from waiting behind a long cold
 * build or an idle-in-transaction session while it holds the migration key.
 *
 * A drop that fails part-way leaves the index INVALID but still maintained
 * (`indisvalid` false, `indisready` true — measured by the same probe); the
 * next `DROP INDEX CONCURRENTLY IF EXISTS` removes it (also measured). On a
 * database without the indexes this is two catalog lookups.
 *
 * `lock_timeout` is a SESSION setting here (no transaction to scope it to),
 * on a pooled connection, so the caller's value is restored before return.
 * That is why `client` is ONE checked-out connection and not a `Queryable`: on
 * a pool, the SET, the drops and the restore could each land on another
 * connection, leaving the bound unset where it matters and the caller's value
 * un-restored where it was changed.
 */
export async function dropRedundantObjectTrigramIndexes(
  client: PoolClient,
  options: { attempts?: number; retryMs?: number; log?: (line: string) => void } = {},
): Promise<{ deferred: string[] }> {
  const attempts = options.attempts ?? REDUNDANT_TRIGRAM_DROP_ATTEMPTS
  const retryMs = options.retryMs ?? REDUNDANT_TRIGRAM_DROP_RETRY_MS
  const log = options.log ?? ((line: string) => console.warn(line))
  const { rows } = await client.query<{ lock_timeout: string; deadlock_ms: string }>(
    `SELECT current_setting('lock_timeout') AS lock_timeout,
            (SELECT setting FROM pg_settings WHERE name = 'deadlock_timeout') AS deadlock_ms`,
  )
  const prior = rows[0]!.lock_timeout
  const waitMs = Math.max(1, Math.min(REDUNDANT_TRIGRAM_DROP_LOCK_WAIT_MS, Math.floor(Number(rows[0]!.deadlock_ms) / 2)))
  const deferred: string[] = []
  // When the work threw, a failing restore (an aborted transaction block, a
  // lost connection) must not replace the error that explains it.
  let failed = false
  try {
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [`${waitMs}ms`])
    for (const index of REDUNDANT_OBJECT_TRIGRAM_INDEXES) {
      for (let attempt = 1; ; attempt++) {
        try {
          await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index}`)
          break
        } catch (error) {
          const code = (error as { code?: string }).code
          if (!code || !DEFERRABLE_DROP_FAILURES.has(code)) throw error
          if (attempt >= attempts) {
            deferred.push(index)
            log(JSON.stringify({ event: 'read_model.redundant_trigram_drop_deferred', index, sqlstate: code, attempts, lockWaitMs: waitMs }))
            break
          }
          await new Promise((resolve) => setTimeout(resolve, retryMs))
        }
      }
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [prior]).catch((restoreError: unknown) => {
      if (!failed) throw restoreError
    })
  }
  return { deferred }
}

/**
 * The write-head membership index (T-DIAGDEF):
 * PARTIAL — `(landscape_id, version_id, entity_id) WHERE membership_kind =
 * 'registry_shard_diagram'` — so it covers only the write-head rows (bounded
 * by the diagrams ever created in heads), not every diagram membership of the
 * table. Both readers use it: `diagramDocVerdict` (one entity) and the
 * retired-row sweep (`GROUP BY entity_id` over a workspace), as checked with
 * EXPLAIN.
 */
export const STATIC_MEMBERSHIP_HEAD_INDEX = 'idx_read_model_static_membership_deltas_head_entity'
/** The FULL index the first version of 0008 built; dropped by the repeatable 0008. */
export const STATIC_MEMBERSHIP_ENTITY_INDEX_V1 = 'idx_read_model_static_membership_deltas_entity'
const STATIC_MEMBERSHIP_HEAD_INDEX_DDL = `ON read_model_static_membership_deltas (landscape_id, version_id, entity_id)
    WHERE membership_kind = 'registry_shard_diagram'`

/**
 * WHERE THE INDEX IS BUILT, decided.
 * `schemaMigrations.ts` says idempotent DDL belongs to the baseline module —
 * and it is idempotent — but a plain `CREATE INDEX` on an EXISTING, large
 * membership table takes a SHARE lock for the whole build and stops every
 * static projection meanwhile (the 0006 lesson). And CONCURRENTLY under the
 * migration key is no better for a boot: the first build reads the whole
 * table twice while every other booting cell waits for the key. So:
 *  - the baseline (`ensureReadModelSchema`) builds it PLAIN only on an EMPTY
 *    table — a new database, an isolated test schema, a fresh seed — where the
 *    lock costs nothing; unchanged;
 *  - everywhere else it is built CONCURRENTLY in the BACKGROUND, after the
 *    server is ready, outside the migration key
 *    ({@link startStaticMembershipHeadIndexBuild}): one build at a time across
 *    the cluster (a session advisory lock, tried, never waited for),
 *    idempotent, bounded, logged; a boot never waits for it;
 *  - migration `0008` is reduced to the CATALOGUE: it reads the index's state
 *    and logs it, nothing more (it stays in the runner so a ledger that
 *    recorded it is not read as "database ahead").
 * NO READER DEPENDS ON IT FOR CORRECTNESS: `diagramDocVerdict`, the
 * retired-row sweep and `reopenUnprojectedDiagramDocuments` return the same
 * rows with or without it — it is only their cost.
 *
 * THIS FUNCTION never reports success over an index that
 * is not VALID. A `CREATE INDEX CONCURRENTLY` cut by `lock_timeout` (55P03,
 * waiting on an old snapshot) or a deadlock (40P01) leaves an INVALID index
 * behind; `CREATE … IF NOT EXISTS` then does nothing and returned "built".
 * Now after each failure the index's validity is RE-READ, an invalid one is
 * dropped (bounded `DROP INDEX CONCURRENTLY`) before the retry, and once the
 * attempts are spent anything but a VALID index is `deferred` and logged.
 * The CREATE waits longer than the DROP (`createWaitMs`: 80 % of
 * `deadlock_timeout` against the DROP's min(500 ms, half of it)) — still
 * below the detector, so a build that meets a cold build's in-transaction
 * `ANALYZE` gives up first rather than have the cold build chosen.
 */
export async function ensureStaticMembershipHeadIndex(
  client: PoolClient,
  options: { attempts?: number; retryMs?: number; log?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<{ deferred: string[]; valid: boolean }> {
  const attempts = options.attempts ?? REDUNDANT_TRIGRAM_DROP_ATTEMPTS
  const retryMs = options.retryMs ?? REDUNDANT_TRIGRAM_DROP_RETRY_MS
  const log = options.log ?? ((line: string) => console.warn(line))
  // A stopped build starts no further statement and
  // sleeps no further retry (the statement in flight is cancelled by
  // `StaticMembershipHeadIndexBuilder.stop`).
  const signal = options.signal
  const checkStopped = () => { if (signal?.aborted) throw new HeadIndexBuildStoppedError() }
  const pause = (ms: number) => new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  const { rows } = await client.query<{ lock_timeout: string; deadlock_ms: string }>(
    `SELECT current_setting('lock_timeout') AS lock_timeout,
            (SELECT setting FROM pg_settings WHERE name = 'deadlock_timeout') AS deadlock_ms`,
  )
  const prior = rows[0]!.lock_timeout
  const deadlockMs = Number(rows[0]!.deadlock_ms)
  const dropWaitMs = Math.max(1, Math.min(REDUNDANT_TRIGRAM_DROP_LOCK_WAIT_MS, Math.floor(deadlockMs / 2)))
  const createWaitMs = Math.max(dropWaitMs + 1, Math.floor(deadlockMs * 0.8))
  const deferred: string[] = []
  const setWait = (ms: number) => client.query(`SELECT set_config('lock_timeout', $1, false)`, [`${ms}ms`])
  const validity = async (name: string): Promise<boolean | null> => {
    const { rows: found } = await client.query<{ valid: boolean }>(
      `SELECT index.indisvalid AS valid
         FROM pg_index index
         JOIN pg_class class ON class.oid = index.indexrelid
        WHERE class.relname = $1 AND class.relnamespace = to_regnamespace(current_schema())`,
      [name],
    )
    return found[0] ? found[0].valid : null
  }
  /** One statement under its wait; `false` on a deferrable lock failure. */
  const attempt = async (statement: string, waitMs: number): Promise<{ ok: boolean; code?: string }> => {
    checkStopped()
    await setWait(waitMs)
    try {
      await client.query(statement)
      return { ok: true }
    } catch (error) {
      checkStopped()
      const code = (error as { code?: string }).code
      if (!code || !DEFERRABLE_DROP_FAILURES.has(code)) throw error
      return { ok: false, code }
    }
  }
  let failed = false
  try {
    for (let tries = 1; ; tries++) {
      const dropped = await attempt(`DROP INDEX CONCURRENTLY IF EXISTS ${STATIC_MEMBERSHIP_ENTITY_INDEX_V1}`, dropWaitMs)
      if (dropped.ok) break
      if (tries >= attempts) {
        deferred.push(STATIC_MEMBERSHIP_ENTITY_INDEX_V1)
        log(JSON.stringify({ event: 'read_model.static_membership_index_deferred', index: STATIC_MEMBERSHIP_ENTITY_INDEX_V1, sqlstate: dropped.code, attempts, lockWaitMs: dropWaitMs }))
        break
      }
      await pause(retryMs)
    }
    let lastCode: string | undefined
    for (let tries = 1; tries <= attempts; tries++) {
      // An INVALID index first goes (`IF NOT EXISTS` would keep it and every
      // reader would silently go without it — the lesson of the kept search index).
      if ((await validity(STATIC_MEMBERSHIP_HEAD_INDEX)) === false) {
        const dropped = await attempt(`DROP INDEX CONCURRENTLY IF EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX}`, dropWaitMs)
        if (!dropped.ok) { lastCode = dropped.code; await pause(retryMs); continue }
      }
      const created = await attempt(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX} ${STATIC_MEMBERSHIP_HEAD_INDEX_DDL}`, createWaitMs)
      if (created.ok && (await validity(STATIC_MEMBERSHIP_HEAD_INDEX)) === true) break
      lastCode = created.code
      if (tries < attempts) await pause(retryMs)
    }
    checkStopped()
    const valid = (await validity(STATIC_MEMBERSHIP_HEAD_INDEX)) === true
    if (!valid) {
      deferred.push(STATIC_MEMBERSHIP_HEAD_INDEX)
      log(JSON.stringify({
        event: 'read_model.static_membership_index_deferred', index: STATIC_MEMBERSHIP_HEAD_INDEX,
        sqlstate: lastCode ?? null, state: (await validity(STATIC_MEMBERSHIP_HEAD_INDEX)) === false ? 'invalid' : 'absent',
        attempts, lockWaitMs: createWaitMs,
      }))
    }
    return { deferred, valid }
  } catch (error) {
    failed = true
    throw error
  } finally {
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [prior]).catch((restoreError: unknown) => {
      if (!failed) throw restoreError
    })
  }
}

/** The cluster-wide key of the background build (a session advisory lock,
 * TRIED: a cell that finds it held lets the holder build). */
const STATIC_MEMBERSHIP_HEAD_INDEX_BUILD_KEY ='maplespire:read-model:static-membership-head-index'

/** How often a build that did not end on a VALID index
 * (skipped, deferred, failed) is tried again. */
export const STATIC_MEMBERSHIP_HEAD_INDEX_RETRY_MS = 60 * 60 * 1_000
/** How long a shutdown waits for a stopped build. */
export const STATIC_MEMBERSHIP_HEAD_INDEX_STOP_MS = 1_000

export type StaticMembershipHeadIndexBuildOutcome = 'built' | 'already-valid' | 'deferred' | 'skipped' | 'failed' | 'stopped'

export class HeadIndexBuildStoppedError extends Error {
  constructor() {
    super('static membership head index build stopped')
    this.name = 'HeadIndexBuildStoppedError'
  }
}

export interface StaticMembershipHeadIndexBuildOptions {
  attempts?: number
  retryMs?: number
  log?: (line: string) => void
}

interface HeadIndexBuildControl {
  signal?: AbortSignal
  /** The build's connection and its backend pid once known; null once it is
   * given back. */
  onSession?: (session: { client: PoolClient; pid: number } | null) => void
  /** True once {@link StaticMembershipHeadIndexBuilder.stop} destroyed the
   * connection itself (it must not be released a second time). */
  destroyed?: () => boolean
}

/**
 * ONE background attempt: one across the cluster
 * (`pg_try_advisory_lock` on its own connection; a held key means another cell
 * builds: skipped, logged), idempotent (a valid index: two catalogue reads),
 * bounded ({@link ensureStaticMembershipHeadIndex}), logged
 * (`read_model.static_membership_index_build`). Never rejects.
 *
 * The connection goes back to the pool only when the
 * session is known clean. A build that FAILED, or an unlock that failed,
 * DESTROYS it (`release(error)`): the session ends, and its advisory lock with
 * it — before, `release()` returned to the pool an idle session that could
 * still hold the key, and every later attempt, in every cell, was `skipped`
 * for as long as that connection lived. A STOPPED build destroys it too
 * (the process is leaving; no unlock round trip).
 */
async function buildStaticMembershipHeadIndexOnce(
  pool: { connect(): Promise<PoolClient> },
  options: StaticMembershipHeadIndexBuildOptions,
  control: HeadIndexBuildControl = {},
): Promise<StaticMembershipHeadIndexBuildOutcome> {
  const log = options.log ?? ((line: string) => console.warn(line))
  const key = STATIC_MEMBERSHIP_HEAD_INDEX_BUILD_KEY
  const signal = control.signal
  const checkStopped = () => { if (signal?.aborted) throw new HeadIndexBuildStoppedError() }
  const startedAt = Date.now()
  let client: PoolClient | null = null
  let locked = false
  let failure: Error | undefined
  try {
    client = await pool.connect()
    checkStopped()
    const { rows: backend } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    control.onSession?.({ client, pid: backend[0]!.pid })
    checkStopped()
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key],
    )
    locked = rows[0]?.locked === true
    if (!locked) {
      log(JSON.stringify({ event: 'read_model.static_membership_index_build', outcome: 'skipped', reason: 'another cell builds it' }))
      return 'skipped'
    }
    const { rows: before } = await client.query<{ valid: boolean }>(
      `SELECT index.indisvalid AS valid FROM pg_index index JOIN pg_class class ON class.oid = index.indexrelid
        WHERE class.relname = $1 AND class.relnamespace = to_regnamespace(current_schema())`,
      [STATIC_MEMBERSHIP_HEAD_INDEX],
    )
    const { rows: legacy } = await client.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`, [STATIC_MEMBERSHIP_ENTITY_INDEX_V1],
    )
    if (before[0]?.valid === true && !legacy[0]?.present) return 'already-valid'
    const outcome = await ensureStaticMembershipHeadIndex(client, { attempts: options.attempts, retryMs: options.retryMs, log, signal })
    const result = outcome.valid && !outcome.deferred.length ? 'built' : 'deferred'
    log(JSON.stringify({ event: 'read_model.static_membership_index_build', outcome: result, deferred: outcome.deferred, elapsedMs: Date.now() - startedAt }))
    return result
  } catch (error) {
    if (signal?.aborted) {
      failure = new HeadIndexBuildStoppedError()
      log(JSON.stringify({ event: 'read_model.static_membership_index_build', outcome: 'stopped', elapsedMs: Date.now() - startedAt }))
      return 'stopped'
    }
    failure = error instanceof Error ? error : new Error(String(error))
    log(JSON.stringify({ event: 'read_model.static_membership_index_build', outcome: 'failed', error: failure.message }))
    return 'failed'
  } finally {
    control.onSession?.(null)
    if (client && !control.destroyed?.()) {
      let destroyWith = failure
      if (locked && !destroyWith) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
        } catch (unlockError) {
          destroyWith = unlockError instanceof Error ? unlockError : new Error(String(unlockError))
          log(JSON.stringify({ event: 'read_model.static_membership_index_unlock_failed', error: destroyWith.message, action: 'connection destroyed' }))
        }
      }
      // A STOPPED attempt never gives its connection back
      // clean, whatever its outcome. `stop()` may have sent
      // `pg_cancel_backend(pid)` while this attempt read the catalogue; an
      // `already-valid` or `skipped` attempt ended without noticing, and its
      // connection, back in the pool, then took the cancel in ANOTHER user's
      // query (57014). Destroyed, its backend serves no one any more.
      if (signal?.aborted) destroyWith ??= new HeadIndexBuildStoppedError()
      client.release(destroyWith)
    }
  }
}

/**
 * The head index, built in the BACKGROUND after
 * readiness, outside the migration key — one attempt
 * ({@link buildStaticMembershipHeadIndexOnce}), one per process at a time.
 * Kept for the callers that want a single attempt; the server runs a
 * {@link StaticMembershipHeadIndexBuilder}.
 */
export function startStaticMembershipHeadIndexBuild(
  pool: { connect(): Promise<PoolClient> },
  options: StaticMembershipHeadIndexBuildOptions = {},
): Promise<StaticMembershipHeadIndexBuildOutcome> {
  if (headIndexBuild) return headIndexBuild
  const run = buildStaticMembershipHeadIndexOnce(pool, options)
  headIndexBuild = run
  void run.finally(() => { if (headIndexBuild === run) headIndexBuild = null })
  return run
}
let headIndexBuild: Promise<StaticMembershipHeadIndexBuildOutcome> | null = null

/**
 * The server's background build.
 *
 * IT DOES NOT HOLD THE SHUTDOWN. A `CREATE INDEX CONCURRENTLY` waiting
 * on an old snapshot holds a PRIMARY-pool connection for up to 80 % of
 * `deadlock_timeout` per attempt; `pool.end()` waits for every checked-out
 * connection, so a SIGTERM during a build ran to the 30 s forced exit, code 1,
 * and left an INVALID index. {@link stop} (a traced step of
 * `runGracefulShutdown`, started right after intake, awaited before the pools):
 * no new attempt, no retry timer; the statement in flight is CANCELLED from
 * another connection (`pg_cancel_backend(pid)` — the index is left invalid, the
 * next attempt drops it); the attempt is awaited, bounded
 * ({@link STATIC_MEMBERSHIP_HEAD_INDEX_STOP_MS}); past the bound its
 * connection is DESTROYED, so the pool's end never waits for it.
 *
 * IT IS TRIED AGAIN. An attempt that did not end on a valid index
 * (`skipped`: another cell held the key and may have died; `deferred`: an old
 * snapshot outlasted the bounded attempts; `failed`) used to be the last one
 * until the next boot. Now another attempt is scheduled every
 * `retryIntervalMs` (default {@link STATIC_MEMBERSHIP_HEAD_INDEX_RETRY_MS}), the
 * same tried key, until one ends `built` or `already-valid`; `stop()` ends it.
 */
export class StaticMembershipHeadIndexBuilder {
  private readonly abort = new AbortController()
  private current: Promise<StaticMembershipHeadIndexBuildOutcome> | null = null
  private session: { client: PoolClient; pid: number } | null = null
  private destroyed = false
  /** False from an attempt's start to its outcome. */
  private settled = true
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Every finished attempt, in order (logged as well). */
  readonly outcomes: StaticMembershipHeadIndexBuildOutcome[] = []

  constructor(
    private readonly pool: {
      connect(): Promise<PoolClient>
      query(text: string, values?: unknown[]): Promise<unknown>
    },
    private readonly options: StaticMembershipHeadIndexBuildOptions & { retryIntervalMs?: number } = {},
  ) {}

  get stopped(): boolean { return this.abort.signal.aborted }

  /** The first attempt; the retries follow from it. */
  start(): void { void this.runOnce() }

  runOnce(): Promise<StaticMembershipHeadIndexBuildOutcome> {
    if (this.current) return this.current
    if (this.stopped) return Promise.resolve('stopped')
    this.destroyed = false
    this.settled = false
    const run = buildStaticMembershipHeadIndexOnce(this.pool, this.options, {
      signal: this.abort.signal,
      onSession: (session) => { this.session = session },
      destroyed: () => this.destroyed,
    }).then((outcome) => {
      this.settled = true
      this.outcomes.push(outcome)
      this.scheduleRetry(outcome)
      return outcome
    })
    this.current = run
    void run.finally(() => { if (this.current === run) this.current = null })
    return run
  }

  private scheduleRetry(outcome: StaticMembershipHeadIndexBuildOutcome): void {
    if (this.stopped || outcome === 'built' || outcome === 'already-valid' || outcome === 'stopped') return
    const delayMs = this.options.retryIntervalMs ?? STATIC_MEMBERSHIP_HEAD_INDEX_RETRY_MS
    this.timer = setTimeout(() => { this.timer = null; void this.runOnce() }, delayMs)
    this.timer.unref?.()
  }

  /** `idle`: nothing ran; `stopped`: the attempt ended on its own check;
   * `cancelled`: its statement was cancelled and it ended within the bound;
   * `destroyed`: past the bound, its connection was destroyed. */
  async stop(waitMs = STATIC_MEMBERSHIP_HEAD_INDEX_STOP_MS): Promise<'idle' | 'stopped' | 'cancelled' | 'destroyed'> {
    this.abort.abort()
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const run = this.current
    if (!run) return 'idle'
    const deadline = Date.now() + waitMs
    const within = <T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms))
        promise.then(
          (value) => { clearTimeout(timer); resolve({ done: true, value }) },
          () => { clearTimeout(timer); resolve({ done: false }) },
        )
      })
    let how: 'stopped' | 'cancelled' = 'stopped'
    const session = this.session
    // Never for an attempt already over, nor for a
    // connection it already gave up (its `finally` clears the session first).
    // The guarantee does not rest on this check — between it and the cancel's
    // arrival the attempt can still end: a stopped attempt DESTROYS its
    // connection (`buildStaticMembershipHeadIndexOnce`), so the pid the cancel
    // names serves no other user of the pool.
    if (session && !this.settled && this.session === session) {
      // From ANOTHER connection: the build's own is busy in its statement.
      const cancel = await within(this.pool.query('SELECT pg_cancel_backend($1)', [session.pid]), (deadline - Date.now()) / 2)
      if (cancel.done) how = 'cancelled'
    }
    if ((await within(run, deadline - Date.now())).done) return how
    const late = this.session
    if (late && !this.destroyed) {
      this.destroyed = true
      late.client.release(new HeadIndexBuildStoppedError())
    }
    return 'destroyed'
  }
}

/** Migration `0008`'s body: the CATALOGUE only —
 * the index's state, read and logged; the build runs in the background. */
export async function reportStaticMembershipHeadIndex(
  client: PoolClient,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<'valid' | 'invalid' | 'absent'> {
  const { rows } = await client.query<{ valid: boolean }>(
    `SELECT index.indisvalid AS valid FROM pg_index index JOIN pg_class class ON class.oid = index.indexrelid
      WHERE class.relname = $1 AND class.relnamespace = to_regnamespace(current_schema())`,
    [STATIC_MEMBERSHIP_HEAD_INDEX],
  )
  const state = !rows[0] ? 'absent' : rows[0].valid ? 'valid' : 'invalid'
  if (state !== 'valid') {
    log(JSON.stringify({ event: 'read_model.static_membership_index_state', index: STATIC_MEMBERSHIP_HEAD_INDEX, state, note: 'built in the background after readiness' }))
  }
  return state
}

/** The baseline half (see {@link ensureStaticMembershipHeadIndex}): PLAIN, and
 * only on an empty membership table, where its lock costs nothing. */
async function ensureStaticMembershipHeadIndexOnEmptyTable(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ empty: boolean }>(
    'SELECT NOT EXISTS (SELECT 1 FROM read_model_static_membership_deltas) AS empty',
  )
  if (!rows[0]?.empty) return
  await db.query(`CREATE INDEX IF NOT EXISTS ${STATIC_MEMBERSHIP_HEAD_INDEX} ${STATIC_MEMBERSHIP_HEAD_INDEX_DDL}`)
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

/** The body of `read_model_adopt_protocol_digests(landscape, version)`: the
 * workspace's retirement and fold rows, each as one JSON array line, sorted
 * by key in byte order, joined by newlines, sha256 in hex — the empty set
 * hashes the empty string. Every column but the bookkeeping timestamps
 * (`created_at`, `updated_at`); `retain_until` as epoch microseconds, never
 * as text (its rendering depends on the session's TimeZone/DateStyle). */
const ADOPT_PROTOCOL_DIGESTS_BODY = `
  SELECT
    encode(sha256(convert_to(coalesce((
      SELECT string_agg(jsonb_build_array(collection, document_id, status, retirement_heads, forwarded_heads,
               folded_into, (extract(epoch FROM retain_until) * 1000000)::bigint::text, arrival_watermark::text,
               origin)::text, chr(10) ORDER BY collection COLLATE "C", document_id COLLATE "C")
        FROM read_model_ordinary_head_retirements
       WHERE landscape_id = p_landscape AND version_id = p_version), ''), 'UTF8')), 'hex'),
    encode(sha256(convert_to(coalesce((
      SELECT string_agg(jsonb_build_array(collection, product_document_id, source_document_ids)::text,
               chr(10) ORDER BY collection COLLATE "C", product_document_id COLLATE "C")
        FROM read_model_ordinary_chain_folds
       WHERE landscape_id = p_landscape AND version_id = p_version), ''), 'UTF8')), 'hex')
`

/** The body of `read_model_adopt_protocol_restamp(landscape, version)`: the
 * fence row FIRST (`adoptState.ts`, THE LOCK ORDER), then the adopt row,
 * then the digests in a NEW statement — under READ COMMITTED each statement
 * of a PL/pgSQL function takes its own snapshot, so the digests see every
 * protocol write committed before the adopt row lock was granted. No adopt
 * row: nothing (only a cold build writes one) — and the digests are not
 * computed. The `UPDATE … FROM read_model_adopt_protocol_digests(…)` alone
 * happens not to compute them either: measured with EXPLAIN ANALYZE on the
 * aged-corpus shape, the planner puts the adopt
 * row's index scan outside the function scan, which then runs zero times.
 * That is a plan, not a guarantee (a function scan is estimated at one row
 * and may be chosen as the outer side), so `FOUND` after the row lock
 * decides instead. */
const ADOPT_PROTOCOL_RESTAMP_BODY = `
BEGIN
  PERFORM 1 FROM read_model_projection_state
    WHERE landscape_id = p_landscape AND version_id = p_version FOR UPDATE;
  PERFORM 1 FROM read_model_adopt_state
    WHERE landscape_id = p_landscape AND version_id = p_version FOR UPDATE;
  IF FOUND THEN
    UPDATE read_model_adopt_state AS state
       SET retirements_digest = digests.retirements, folds_digest = digests.folds, updated_at = now()
      FROM read_model_adopt_protocol_digests(p_landscape, p_version) AS digests
     WHERE state.landscape_id = p_landscape AND state.version_id = p_version;
  END IF;
END
`

/** The body of the statement trigger function: every workspace the
 * statement touched (its transition table), in key order; a TRUNCATE
 * (tests only) re-stamps every adopt row.
 *
 * THE LOCK ORDER, enforced (`adoptState.ts`) on a participant connection
 * (`protocolParticipant.ts`): before re-stamping a touched workspace, the
 * statement's transaction must already hold that workspace's
 * `read_model_projection_state` row — recorded, in the statement that took
 * it, in the transaction-local `PROTOCOL_FENCE_ROWS_SETTING`
 * (`assertReadModelWriteFence`, `health.ts`). A write made before it (or
 * without it) RAISES here, at its own statement, every time — not only when
 * another transaction happens to hold the row, which is all a `FOR UPDATE
 * NOWAIT` in the re-stamp could detect: an uncontended misordered writer
 * would pass it. The entry `<xid>:*` admits every workspace for that one
 * transaction; only test fixtures write it (`testing/protocolFixture.ts`). */
const ADOPT_PROTOCOL_TRIGGER_BODY = `
DECLARE
  touched RECORD;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    FOR touched IN SELECT landscape_id, version_id FROM read_model_adopt_state ORDER BY 1, 2 LOOP
      PERFORM read_model_adopt_protocol_restamp(touched.landscape_id, touched.version_id);
    END LOOP;
  ELSIF TG_OP = 'INSERT' THEN
    FOR touched IN SELECT DISTINCT landscape_id, version_id FROM adopt_protocol_new ORDER BY 1, 2 LOOP
      PERFORM read_model_adopt_protocol_touched(touched.landscape_id, touched.version_id, TG_OP, TG_TABLE_NAME);
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR touched IN SELECT DISTINCT landscape_id, version_id FROM adopt_protocol_old ORDER BY 1, 2 LOOP
      PERFORM read_model_adopt_protocol_touched(touched.landscape_id, touched.version_id, TG_OP, TG_TABLE_NAME);
    END LOOP;
  ELSE
    FOR touched IN SELECT landscape_id, version_id FROM adopt_protocol_new
                   UNION SELECT landscape_id, version_id FROM adopt_protocol_old ORDER BY 1, 2 LOOP
      PERFORM read_model_adopt_protocol_touched(touched.landscape_id, touched.version_id, TG_OP, TG_TABLE_NAME);
    END LOOP;
  END IF;
  RETURN NULL;
END
`

/** The body of `read_model_adopt_protocol_touched(landscape, version, op,
 * table)`: THE LOCK ORDER's check for one workspace a protocol statement
 * touched (see the trigger body above), then its re-stamp. A workspace with
 * NO `read_model_projection_state` row has no row to order against and is
 * not checked: no production writer can reach that state and write (each
 * asserts the fence, which fails closed on a missing row), so only a test
 * fixture seeding rows by hand does. A connection whose participant
 * version (`protocolParticipant.ts`, `PARTICIPANT_VERSION_SQL`: the marker
 * parsed as an integer, 0 when absent, empty or not 1-9 digits) is below
 * `LOCK_ORDER_RULE_SINCE` is not checked either — a process of a version
 * that does not know the protocol: its digests are kept, its order is its
 * own. A HIGHER version is checked by this rule (a later version keeps
 * every earlier rule: the forward contract in `protocolParticipant.ts`). An
 * entry counts only when it carries THIS transaction's id
 * (`PROTOCOL_FENCE_ROWS_SETTING`'s doc comment, `health.ts`). */
const ADOPT_PROTOCOL_TOUCHED_BODY = `
DECLARE
  held TEXT := coalesce(current_setting('${PROTOCOL_FENCE_ROWS_SETTING}', true), '') || ',';
  mine TEXT := ',' || pg_current_xact_id()::text || ':';
  participant INTEGER := ${PARTICIPANT_VERSION_SQL};
BEGIN
  IF participant >= ${LOCK_ORDER_RULE_SINCE}
     AND held NOT LIKE '%' || mine || '*,%'
     AND held NOT LIKE '%' || mine || md5(jsonb_build_array(p_landscape, p_version)::text) || ',%'
     AND EXISTS (SELECT 1 FROM read_model_projection_state
                  WHERE landscape_id = p_landscape AND version_id = p_version) THEN
    RAISE EXCEPTION 'read-model lock order: % on % of %/% without its read_model_projection_state row held first',
        p_op, p_table, p_landscape, p_version
      USING HINT = 'take it with assertReadModelWriteFence before the first protocol write (adoptState.ts, THE LOCK ORDER)';
  END IF;
  PERFORM read_model_adopt_protocol_restamp(p_landscape, p_version);
END
`

/** The version tag this version puts on every protocol function body it
 * installs (`protocolParticipant.ts`, THE FORWARD CONTRACT). */
const PROTOCOL_FUNCTION_TAG = `${PROTOCOL_TAG_PREFIX}${READ_MODEL_PROTOCOL_VERSION}`
/** The function's tagged protocol version in SQL: the tag's digits, 0 for an
 * untagged body (one installed before tags existed) or no function. ANCHORED:
 * the comment must be exactly one tag and nothing else. A comment carrying
 * two tags, or a tag inside other text, is not a tag this protocol wrote
 * (only `ensureFunction` writes it, alone) and reads as untagged, so it is
 * replaced — never read as a higher version that would freeze the body. */
const taggedVersionSql = (oid: string) =>
  `coalesce(substring(obj_description(${oid}, 'pg_proc') FROM '^${PROTOCOL_TAG_PREFIX}([0-9]{1,9})$')::integer, 0)`
/** Signatures whose higher-version body this process has already reported
 * keeping (once per process: this runs on every boot). */
const keptHigherVersion = new Set<string>()

/**
 * Create or replace a protocol function, tagged with this version.
 *
 *  - A body tagged with a HIGHER version is NEVER replaced (a rollback from
 *    a later version keeps the later bodies, which must accept everything
 *    this version's connections do: `protocolParticipant.ts`, THE FORWARD
 *    CONTRACT). Reported once per process.
 *  - The same body with this version's tag: nothing — this runs on every
 *    boot, and two boots replacing the same function at once can fail with
 *    "tuple concurrently updated".
 *  - Otherwise (no function, an older or untagged body, or this version's
 *    tag on a DIFFERENT body — a build of the same version that changed it)
 *    the body is replaced and tagged, in one `DO` block under a
 *    transaction-scoped advisory lock that re-reads the tag: two boots that
 *    both missed the fast path replace one after the other, and a later
 *    version that tagged it in between is not overwritten (a later version
 *    must take the same lock, and write its tag in the same transaction as
 *    its body; the key is part of the contract).
 */
async function ensureFunction(db: Queryable, signature: string, body: string, create: string): Promise<void> {
  const { rows } = await db.query<{ src: string | null; tagged: number }>(
    `SELECT p.prosrc AS src, ${taggedVersionSql('f.oid')} AS tagged
       FROM (SELECT to_regprocedure(current_schema() || '.' || $1) AS oid) f
       LEFT JOIN pg_proc p ON p.oid = f.oid`,
    [signature],
  )
  const found = rows[0]
  if (found && found.tagged > READ_MODEL_PROTOCOL_VERSION) {
    if (!keptHigherVersion.has(signature)) {
      keptHigherVersion.add(signature)
      console.log(`[read-model] ${signature} is tagged ${PROTOCOL_TAG_PREFIX}${found.tagged}, above this version's `
        + `${READ_MODEL_PROTOCOL_VERSION}: kept, not replaced (protocolParticipant.ts, the forward contract)`)
    }
    return
  }
  if (found?.src === body && found.tagged === READ_MODEL_PROTOCOL_VERSION) return
  if (create.includes('$ensure$') || create.includes('$create$') || signature.includes("'")) {
    throw new Error(`ensureFunction(${signature}): the statement cannot be embedded in its DO block`)
  }
  await db.query(`
    DO $ensure$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('maplespire:read-model-protocol-functions', 0));
      IF ${taggedVersionSql(`to_regprocedure(current_schema() || '.${signature}')`)} > ${READ_MODEL_PROTOCOL_VERSION} THEN
        RETURN;
      END IF;
      EXECUTE $create$${create}$create$;
      EXECUTE format('COMMENT ON FUNCTION %I.%s IS %L', current_schema(), '${signature}', '${PROTOCOL_FUNCTION_TAG}');
    END $ensure$
  `)
}

/** One statement trigger, created only when absent (never dropped and
 * recreated on boot: DROP TRIGGER takes ACCESS EXCLUSIVE on a table a
 * rotator or forwarder may hold); a concurrent boot that created it first
 * is not an error. */
async function ensureAdoptProtocolTrigger(
  db: Queryable,
  table: 'read_model_ordinary_head_retirements' | 'read_model_ordinary_chain_folds',
  event: 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE',
): Promise<void> {
  const name = `read_model_adopt_protocol_${table === 'read_model_ordinary_chain_folds' ? 'folds' : 'retirements'}_${event.toLowerCase()}`
  const referencing = event === 'INSERT' ? 'REFERENCING NEW TABLE AS adopt_protocol_new'
    : event === 'UPDATE' ? 'REFERENCING NEW TABLE AS adopt_protocol_new OLD TABLE AS adopt_protocol_old'
      : event === 'DELETE' ? 'REFERENCING OLD TABLE AS adopt_protocol_old' : ''
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger
                      WHERE tgrelid = to_regclass(current_schema() || '.${table}') AND tgname = '${name}') THEN
        CREATE TRIGGER ${name} AFTER ${event} ON ${table} ${referencing}
          FOR EACH STATEMENT EXECUTE FUNCTION read_model_adopt_protocol_refresh();
      END IF;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `)
}

/**
 * THE ADOPT PROTOCOL DIGESTS, maintained by the database (G4-16f,
 * `adoptState.ts`): after every statement that changes a retirement or fold
 * row, in that statement's transaction, the adopt row of every workspace it
 * touched gets the digests of the tables as they now stand. One trigger per
 * table and event because PostgreSQL refuses transition tables on a trigger
 * with more than one event (measured, postgres:16-alpine, 2026-11-07:
 * "transition tables cannot be specified for triggers with more than one
 * event"). Each is pinned by its own arm in `adoptState.integration.test.ts`.
 *
 * RELEASE NOTE — the mixed-version window (a rolling deploy, or a rollback,
 * with processes of two versions on one database). The predecessor that
 * matters is the previous release (read from the source of each of its
 * writers, 2026-11-08). It has no adopt plane and never creates, replaces or
 * drops these functions or triggers. Its protocol writers are of two kinds:
 *  - FENCE FIRST, outside the projection mutex: the rotator
 *    (`rotateOrdinaryHead`) and the fold writer's record, abandon and sweep
 *    (`ordinaryChainFoldWriter.ts`) each run `assertTransactionAuthority`
 *    (the fence row FOR UPDATE) before their first protocol write;
 *  - WRITE FIRST, under the per-workspace projection advisory mutex
 *    (`withReadModelProjectionTransaction`, which both versions take): only
 *    the forward commit (`forwardRetiredHead`'s `commitForwardedHeads`) and
 *    the folded-arrival advances (`commitFoldedArrival`,
 *    `commitDetachedWatermarks`) write the row, then assert the fence.
 * Once this version has booted on a database the triggers stay installed
 * through any rollback, and a boot of this version REPLACES their bodies
 * when they differ from its own — bounded by the version tags
 * (`ensureFunction`): never a body tagged with a higher version. So they are
 * written to be safe for a process that does not know them:
 *  - they ENFORCE the lock order only on a connection whose participant
 *    version (`protocolParticipant.ts`, set on every connection of this
 *    version's pools by `guardIdleClientErrors`) is at least
 *    `LOCK_ORDER_RULE_SINCE`. A previous-release process never sets it, so none of
 *    its writes is refused (pinned by `adoptState.integration.test.ts`,
 *    MIXED VERSION); a writer of this version that omits the fence still is
 *    (LOCK ORDER 2), and one whose connection lost its marker is refused by
 *    the fence assertion itself (`ReadModelProtocolMarkerError`, LOST
 *    MARKER);
 *  - they still re-stamp the digests on a previous-release write (taking
 *    the fence row, then the adopt row, inside that transaction), so the
 *    digests are correct when this version comes back;
 *  - the residual, a 40P01: since the write-first writers run under the
 *    mutex both versions take, a cycle needs a writer OUTSIDE the mutex —
 *    the fold record, the sweep or abandon, or the compaction settle's
 *    `commitForwardedHeadsBatch` (this version: fence first, then the row) —
 *    holding the fence row and wanting a retirement row that a
 *    previous-release forward or folded-arrival advance holds while it waits for the fence
 *    row. PostgreSQL detects it after `deadlock_timeout` and aborts one
 *    transaction, which rolls back whole; the fold writer, the forwarder and
 *    the folded-arrival poll try again on their next pass. The compaction
 *    settle has NO retry loop on 40P01: its error ends that compaction pass,
 *    as its CAS failure does, and the next compaction run recovers. The SAME
 *    cycle exists in the previous release alone (its fence-first fold record
 *    against its write-first forward), so the window adds no new kind of
 *    failure. (`adoptState.integration.test.ts`, MIXED VERSION 2, drives the
 *    previous release's order against this version's: one 40P01, one commit, the
 *    digests kept. Measured: with the production mutex, 1000/1000
 *    first-try commits and 0 × 40P01; without it, 6+2 writers × 60
 *    iterations met 40P01s that were retried to success, digests intact.)
 *  - the previous release alone, after a rollback, with the triggers still
 *    installed: the re-stamp takes the fence row FOR UPDATE inside the
 *    statement that writes, so a previous-release write-first writer now
 *    acquires the fence at its FIRST protocol write instead of at its
 *    assertion. That creates no cycle between previous-release writers that
 *    did not exist before (reasoned from the writers listed above, not
 *    measured): the fence-first writers already hold the fence before any
 *    row, so for them it is a re-entrant lock, then the adopt row, which no
 *    previous-release code otherwise touches; the write-first writers keep
 *    the order row-then-fence they had, and now
 *    hold FEWER rows when they ask for the fence (one, rather than every
 *    row of a multi-advance `commitDetachedWatermarks`), and they are
 *    serialised with each other by the mutex. The only cycle — a
 *    fence-first writer such as `recordOrdinaryChainFold` (several source
 *    rows updated under the fence) wanting a row a previous-release
 *    forwarder holds — is the one the previous release already had, with a
 *    narrower window.
 *  - the tags are a contract with every later version: it must write the
 *    `COMMENT` tag in the same transaction as the body replacement, under
 *    the same advisory-lock key (`maplespire:read-model-protocol-functions`,
 *    re-reading the tag under it), as `ensureFunction` does; the tag is read
 *    anchored (exactly `maplespire-protocol=<digits>`). Operators must never
 *    `COMMENT ON` these functions. Earlier, unreleased G4-16f builds replaced
 *    the bodies without re-tagging them; this version treats what they left
 *    as older and replaces it.
 */
async function ensureAdoptProtocolTriggers(db: Queryable): Promise<void> {
  await ensureFunction(db, 'read_model_adopt_protocol_digests(text,text)', ADOPT_PROTOCOL_DIGESTS_BODY,
    `CREATE OR REPLACE FUNCTION read_model_adopt_protocol_digests(p_landscape TEXT, p_version TEXT,
       OUT retirements TEXT, OUT folds TEXT) LANGUAGE sql STABLE AS $$${ADOPT_PROTOCOL_DIGESTS_BODY}$$`)
  await ensureFunction(db, 'read_model_adopt_protocol_restamp(text,text)', ADOPT_PROTOCOL_RESTAMP_BODY,
    `CREATE OR REPLACE FUNCTION read_model_adopt_protocol_restamp(p_landscape TEXT, p_version TEXT)
       RETURNS void LANGUAGE plpgsql AS $$${ADOPT_PROTOCOL_RESTAMP_BODY}$$`)
  await ensureFunction(db, 'read_model_adopt_protocol_touched(text,text,text,text)', ADOPT_PROTOCOL_TOUCHED_BODY,
    `CREATE OR REPLACE FUNCTION read_model_adopt_protocol_touched(p_landscape TEXT, p_version TEXT, p_op TEXT, p_table TEXT)
       RETURNS void LANGUAGE plpgsql AS $$${ADOPT_PROTOCOL_TOUCHED_BODY}$$`)
  await ensureFunction(db, 'read_model_adopt_protocol_refresh()', ADOPT_PROTOCOL_TRIGGER_BODY,
    `CREATE OR REPLACE FUNCTION read_model_adopt_protocol_refresh()
       RETURNS trigger LANGUAGE plpgsql AS $$${ADOPT_PROTOCOL_TRIGGER_BODY}$$`)
  await ensureAdoptProtocolTrigger(db, 'read_model_ordinary_head_retirements', 'INSERT')
  await ensureAdoptProtocolTrigger(db, 'read_model_ordinary_head_retirements', 'UPDATE')
  await ensureAdoptProtocolTrigger(db, 'read_model_ordinary_head_retirements', 'DELETE')
  await ensureAdoptProtocolTrigger(db, 'read_model_ordinary_head_retirements', 'TRUNCATE')
  await ensureAdoptProtocolTrigger(db, 'read_model_ordinary_chain_folds', 'INSERT')
  await ensureAdoptProtocolTrigger(db, 'read_model_ordinary_chain_folds', 'UPDATE')
  await ensureAdoptProtocolTrigger(db, 'read_model_ordinary_chain_folds', 'DELETE')
  await ensureAdoptProtocolTrigger(db, 'read_model_ordinary_chain_folds', 'TRUNCATE')
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
      EXECUTE format('DROP TABLE IF EXISTS %I.read_model_adopt_watermarks', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.read_model_adopt_state', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.read_model_sealed_product_entities', s);
      EXECUTE format('DROP TABLE IF EXISTS %I.read_model_sealed_product_extracts', s);
      -- The protocol tables (retirements, folds) are durable state and stay;
      -- their adopt triggers read the two tables dropped above, so they go
      -- too (CASCADE on the trigger function drops the eight triggers), or
      -- every protocol write would fail 42P01 until the next ensure. The
      -- next ensureReadModelSchema creates them again.
      EXECUTE format('DROP FUNCTION IF EXISTS %I.read_model_adopt_protocol_refresh() CASCADE', s);
      EXECUTE format('DROP FUNCTION IF EXISTS %I.read_model_adopt_protocol_touched(text, text, text, text)', s);
      EXECUTE format('DROP FUNCTION IF EXISTS %I.read_model_adopt_protocol_restamp(text, text)', s);
      EXECUTE format('DROP FUNCTION IF EXISTS %I.read_model_adopt_protocol_digests(text, text)', s);
    END $$;
  `)
}
