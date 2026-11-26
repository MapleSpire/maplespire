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

import * as A from '@automerge/automerge'
import { EpochAdoptKnownDocument, EpochRollContended } from './modelEpochRoll.js'
import { ensureModelEpochOverrideSchema } from './modelEpochOverrides.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * ModelMeta and base-shard EPOCHS (G4-16f) — the DURABLE STATE.
 *
 * Two tables, both protocol state that `dropReadModelSchema` keeps (like the
 * retirement and fold tables):
 *
 *  - `read_model_model_epochs`: one row per epoch of a workspace. `state`
 *    walks `preparing → prepared → repointing → published → retained →
 *    retired` (or `abandoned` from `preparing`/`prepared`). The epoch whose
 *    documents an existing workspace had before its first roll is recorded
 *    once, as epoch 0 of kind `legacy`.
 *  - `read_model_model_epoch_docs`: one row per document an epoch CREATED
 *    (`meta`, `base`) or ADOPTED (a browser's overflow shard, `adopted`).
 *    The legacy documents are recorded under epoch 0 with the role they
 *    play (`meta` or `base`). A document is never recorded twice: a meta-only
 *    epoch CARRIES the base shards it does not recreate, and a carried
 *    document keeps its row and its `superseded_epoch` NULL — it is still
 *    listed by the current epoch, so it is neither a late-write source nor a
 *    retirement candidate. `superseded_epoch`
 *    is set when an epoch is published that no longer lists the document.
 *
 * THE ONE PREDICATE that decides "late-write source": `superseded_epoch IS
 * NOT NULL AND state = 'live'` ({@link listLateWriteSources}). Anything that
 * forwards, retires or answers `epoch-retired` must go through it or through
 * the GC helper below, never re-derive it.
 */

export const MODEL_EPOCH_STATES = [
  'preparing', 'prepared', 'repointing', 'published', 'retained', 'abandoned', 'retired',
] as const
export type ModelEpochState = (typeof MODEL_EPOCH_STATES)[number]

/** Rows whose documents GC must keep. `repointing` included: from S6a on, the
 * new ModelMeta's URL may already have reached a peer by sync,
 * so its documents are never sweepable, whatever happens to the row after. */
export const GC_MARKED_EPOCH_STATES: readonly ModelEpochState[] = [
  'preparing', 'prepared', 'repointing', 'published', 'retained',
]

export const MODEL_EPOCH_KINDS = ['legacy', 'full', 'meta'] as const
export type ModelEpochKind = (typeof MODEL_EPOCH_KINDS)[number]

export const MODEL_EPOCH_DOC_ROLES = ['meta', 'base', 'adopted'] as const
export type ModelEpochDocRole = (typeof MODEL_EPOCH_DOC_ROLES)[number]

/** `live`: readable and (once superseded) forwarded. `retiring`: GC no longer
 * marks it. `pinned`: GC found another root still naming it (a snapshot
 * manifest, an open forward journal) — readable, no longer a source, not
 * counted against N. `retired`: swept; the row stays so a client holding the
 * document is told `epoch-retired`. */
export const MODEL_EPOCH_DOC_STATES = ['live', 'retiring', 'pinned', 'retired'] as const
export type ModelEpochDocState = (typeof MODEL_EPOCH_DOC_STATES)[number]

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ')

export async function ensureModelEpochSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_model_epochs (
      landscape_id          TEXT NOT NULL,
      version_id            TEXT NOT NULL,
      epoch_no              INT NOT NULL CHECK (epoch_no >= 0),
      kind                  TEXT NOT NULL CHECK (kind IN (${sqlList(MODEL_EPOCH_KINDS)})),
      state                 TEXT NOT NULL CHECK (state IN (${sqlList(MODEL_EPOCH_STATES)})),
      predecessor_epoch     INT CHECK (predecessor_epoch IS NULL OR predecessor_epoch < epoch_no),
      meta_url              TEXT,
      cut_heads             JSONB NOT NULL DEFAULT '{}'::jsonb,
      slots                 JSONB NOT NULL DEFAULT '[]'::jsonb,
      server_change_hashes  TEXT[] NOT NULL DEFAULT '{}',
      instance_id           TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at          TIMESTAMPTZ,
      retired_at            TIMESTAMPTZ,
      PRIMARY KEY (landscape_id, version_id, epoch_no),
      CHECK (state NOT IN ('repointing', 'published', 'retained') OR meta_url IS NOT NULL),
      CHECK ((kind = 'legacy') = (predecessor_epoch IS NULL))
    )
  `)
  // At most ONE roll in flight per workspace, and exactly one current epoch:
  // the second roller fails its INSERT (S2) rather than racing.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_read_model_model_epochs_in_flight
    ON read_model_model_epochs (landscape_id, version_id)
    WHERE state IN ('preparing', 'prepared', 'repointing')`)
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_read_model_model_epochs_published
    ON read_model_model_epochs (landscape_id, version_id)
    WHERE state = 'published'`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_model_epoch_docs (
      document_id         TEXT PRIMARY KEY,
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL,
      created_epoch       INT NOT NULL CHECK (created_epoch >= 0),
      role                TEXT NOT NULL CHECK (role IN (${sqlList(MODEL_EPOCH_DOC_ROLES)})),
      slot                INT CHECK (slot IS NULL OR slot >= 0),
      superseded_epoch    INT CHECK (superseded_epoch IS NULL OR superseded_epoch > created_epoch),
      state               TEXT NOT NULL DEFAULT 'live' CHECK (state IN (${sqlList(MODEL_EPOCH_DOC_STATES)})),
      pinned_by           TEXT,
      forward_cursor      TEXT[],
      elem_map            JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_late_write_at  TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((state = 'pinned') = (pinned_by IS NOT NULL)),
      CHECK (state = 'live' OR superseded_epoch IS NOT NULL)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_model_epoch_docs_workspace
    ON read_model_model_epoch_docs (landscape_id, version_id, superseded_epoch)`)
  // The FORWARD JOURNAL: one open row per source while a
  // forward is being written, committed BEFORE any target is written, deleted
  // with the cursor's CAS. `parts` records each target's document id (the one
  // resolved at plan time — a retired head stays the target), its entity
  // paths, whether it is aligned, its planned inserts and its adopted URLs.
  // `owner_instance` + `heartbeat_at` are the lease (R4-b).
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_model_epoch_forwards (
      id                  TEXT PRIMARY KEY,
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL,
      source_document_id  TEXT NOT NULL UNIQUE,
      from_heads          TEXT[] NOT NULL,
      to_heads            TEXT[] NOT NULL,
      parts               JSONB NOT NULL DEFAULT '[]'::jsonb,
      owner_instance      TEXT NOT NULL,
      heartbeat_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_model_epoch_forwards_workspace
    ON read_model_model_epoch_forwards (landscape_id, version_id)`)
  // QUARANTINE: a journal that keeps failing — a
  // deterministic throw, heads that never arrive — is set aside after
  // `FORWARD_QUARANTINE_AFTER_ATTEMPTS` attempts, with an alert. A
  // quarantined journal no longer makes the fold writer, compaction or the
  // roll refuse; its source is not forwarded until an operator releases or
  // discards it (`npm run repair:epoch-forward-quarantine`).
  // The override rows.
  await ensureModelEpochOverrideSchema(db)
  // The CURRENT meta's text mirror is a source of its own; its cursor.
  await db.query(`ALTER TABLE read_model_model_epoch_docs ADD COLUMN IF NOT EXISTS mirror_cursor TEXT[]`)
  // A revival asked by the
  // durable-heads route (`requestLateRetiringRevival`), consumed by the
  // owner's next pass under its fence — durable, and seen by whichever cell
  // owns the workspace, not only the one that answered the route.
  await db.query(`ALTER TABLE read_model_model_epoch_docs ADD COLUMN IF NOT EXISTS revive_requested_at TIMESTAMPTZ`)
  await db.query(`ALTER TABLE read_model_model_epoch_forwards
    ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ`)
  // THE WRITES LOG: per completed (journal, target),
  // the CANONICAL change and the target's heads before it — what the dedupe
  // sweep (`modelEpochForwardDedupe.ts`) compares a later duplicate against.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_model_epoch_forward_writes (
      journal_id          TEXT NOT NULL,
      target_document_id  TEXT NOT NULL,
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL,
      message             TEXT NOT NULL,
      change_hash         TEXT NOT NULL,
      heads_before        TEXT[] NOT NULL,
      paths               JSONB NOT NULL DEFAULT '[]'::jsonb,
      written_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (journal_id, target_document_id)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_model_epoch_forward_writes_workspace
    ON read_model_model_epoch_forward_writes (landscape_id, version_id, written_at)`)
  // NO per-target index (measured): `currentEpochForwardTargets`
  // bounds the rows by `written_at` against a JOINED value (the predecessor's
  // publication), so the planner reads them on the index above (a bitmap
  // range scan) and sorts the few thousand rows per target in memory; a
  // `(landscape_id, version_id, target_document_id, written_at DESC)` index
  // was never chosen (EXPLAIN ANALYZE, 5 000 and 50 000 rows: same plan,
  // same time) and only cost a write per forward. Never shipped: nothing to drop.
  // When the dedupe sweep last checked the row:
  // a sweep that yields at its budget resumes with the least recently checked.
  await db.query(`ALTER TABLE read_model_model_epoch_forward_writes ADD COLUMN IF NOT EXISTS dedupe_checked_at TIMESTAMPTZ`)
  // `epoch:resolve-repointing` records which door resolved a stuck row
  // (either choice is recorded in the row).
  await db.query(`ALTER TABLE read_model_model_epochs ADD COLUMN IF NOT EXISTS resolution TEXT`)
  // BUILT FROM THE CUT: true for a document a
  // roll BUILT from its predecessor's cut (`publish`'s `created`), so element
  // k of each of its sequences at birth IS element k of the source at the
  // cut. False for a document an epoch merely ADOPTED — the root's foreign
  // meta that `--adopt-root` publishes: its positions are not the source's,
  // and the forwarder must never replay a sequence into it by identity
  // (`modelEpochForwarder.ts`, `aligned`).
  await db.query(`ALTER TABLE read_model_model_epoch_docs ADD COLUMN IF NOT EXISTS built_from_cut BOOLEAN NOT NULL DEFAULT true`)
  // THE DISCARD EXPORTS: what an operator's discard
  // of a quarantined journal gave up, written in the discard's own fenced
  // transaction (`modelEpochQuarantine.ts`). Kept: it is the only copy.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_model_epoch_discards (
      journal_id          TEXT PRIMARY KEY,
      landscape_id        TEXT NOT NULL,
      version_id          TEXT NOT NULL,
      source_document_id  TEXT NOT NULL,
      payload             JSONB NOT NULL,
      discarded_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

/**
 * Does the workspace have ANY epoch row? The gate of every per-pass epoch
 * statement (the forwarder, the pending-journal check, the step's recovery): a
 * workspace that never rolled — every workspace while `AM_MODEL_EPOCHS` has
 * never been on — pays this one indexed probe and nothing else. False when the
 * table does not exist.
 */
export async function modelEpochRowsExist(db: Queryable, key: WorkspaceKey): Promise<boolean> {
  const { rows: present } = await db.query<{ present: boolean }>(
    `SELECT to_regclass(current_schema() || '.read_model_model_epochs') IS NOT NULL AS present`)
  if (!present[0]?.present) return false
  const { rows } = await db.query<{ any: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2) AS any`,
    [key.landscapeId, key.versionId])
  return rows[0]?.any === true
}

/**
 * Is a forward journal OPEN for the workspace (design R4-a)? While one is,
 * the fold writer, compaction and the roll refuse with
 * `epoch_forward_pending`: each could fold, clear or supersede a document
 * the journal names. A journal lives seconds, so a refusal costs one pass.
 * False when the table does not exist.
 */
export async function modelEpochForwardPending(db: Queryable, key: WorkspaceKey): Promise<boolean> {
  const { rows: present } = await db.query<{ present: boolean }>(
    `SELECT to_regclass(current_schema() || '.read_model_model_epoch_forwards') IS NOT NULL AS present`)
  if (!present[0]?.present) return false
  const { rows } = await db.query<{ open: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM read_model_model_epoch_forwards
                     WHERE landscape_id = $1 AND version_id = $2 AND quarantined_at IS NULL) AS open`,
    [key.landscapeId, key.versionId])
  return rows[0]?.open === true
}

/** Strip the `automerge:` prefix (and any query) a URL may carry. */
export function epochDocumentIdOf(url: string): string {
  return url.replace(/^automerge:/, '').split('?')[0]!
}

interface SlotEntry { slot?: unknown; url?: unknown }

/** The document URLs an epoch row names: its ModelMeta and every slot's
 * base shard. Malformed entries are skipped (the caller's `add` validates the
 * URL again), never thrown on: GC calls this while marking. */
export function epochRowDocumentUrls(row: { meta_url: string | null; slots: unknown }): string[] {
  const urls: string[] = []
  if (typeof row.meta_url === 'string') urls.push(row.meta_url)
  if (Array.isArray(row.slots)) {
    for (const entry of row.slots as SlotEntry[]) {
      if (entry && typeof entry.url === 'string') urls.push(entry.url)
    }
  }
  return urls
}

export interface ModelEpochGcRoots {
  /** Document URLs GC must mark: every document a marked epoch row names, and
   * every `live` or `pinned` epoch document. */
  readonly urls: string[]
  /** Retained (superseded, still readable) ModelMetas whose UNION closure GC
   * must also mark: a client holding one asks for what it names. */
  readonly retainedMetaUrls: string[]
}

/**
 * GC's extra roots for epochs. Joined to `versions`, like
 * every other SQL root in `gc.ts`, so a deleted version pins nothing. Empty
 * when the tables do not exist (a database whose read-model schema was never
 * ensured): there is then nothing to protect.
 */
export async function modelEpochGcRoots(db: Queryable): Promise<ModelEpochGcRoots> {
  const { rows: present } = await db.query<{ epochs: boolean; docs: boolean; forwards: boolean }>(
    `SELECT to_regclass(current_schema() || '.read_model_model_epochs') IS NOT NULL AS epochs,
            to_regclass(current_schema() || '.read_model_model_epoch_docs') IS NOT NULL AS docs,
            to_regclass(current_schema() || '.read_model_model_epoch_forwards') IS NOT NULL AS forwards`,
  )
  const urls: string[] = []
  const retainedMetaUrls: string[] = []
  if (present[0]?.forwards) {
    // Every document an OPEN forward journal names — its source and every
    // recorded target, a retired write head included — so a crash between
    // two targets can never let GC sweep the one still to be written.
    const { rows } = await db.query<{ source_document_id: string; parts: Array<{ documentId?: unknown }> | null }>(
      `SELECT forward.source_document_id, forward.parts
         FROM read_model_model_epoch_forwards forward
         JOIN versions version
           ON version.landscape_id = forward.landscape_id
          AND version.id = forward.version_id`,
    )
    for (const row of rows) {
      urls.push(`automerge:${row.source_document_id}`)
      for (const part of Array.isArray(row.parts) ? row.parts : []) {
        if (part && typeof part.documentId === 'string') urls.push(`automerge:${part.documentId}`)
      }
    }
  }
  // RETIREMENT (`modelEpochRetire.ts`): a document whose row is
  // `retiring` or `retired` is no longer marked through the epoch row that
  // created it — the retained epoch row still names it, and marking it there
  // would keep every retired document for ever.
  //
  // EXCEPT a `retiring` one whose durable heads moved past its forward
  // cursor: a late write landed — or was flushed — between
  // retirement's quiet check and this sweep. It is no longer a source
  // (`loadSources` reads `live` only), so sweeping it would lose that write
  // unforwarded; it is KEPT, and the next retirement pass moves it back to
  // `live`, where the forwarder carries it. Any doubt (storage unreadable)
  // keeps it too.
  const retiring = new Set<string>()
  if (present[0]?.docs) {
    const { rows } = await db.query<{ document_id: string; state: string; forward_cursor: string[] | null }>(
      `SELECT document_id, state, forward_cursor FROM read_model_model_epoch_docs WHERE state IN ('retiring', 'retired')`)
    for (const row of rows) {
      if (row.state === 'retiring') {
        // No storage table at all: nothing is stored, so nothing can be lost.
        const durable = await storageDurableHeads(db, row.document_id)
          .catch((error: { code?: string }) => (error?.code === '42P01' ? null : undefined))
        if (durable === undefined || (durable !== null && !sameHeadSet(durable, row.forward_cursor ?? []))) {
          urls.push(`automerge:${row.document_id}`)
          continue
        }
      }
      retiring.add(row.document_id)
    }
  }
  if (present[0]?.epochs) {
    const { rows } = await db.query<{ meta_url: string | null; slots: unknown }>(
      `SELECT epoch.meta_url, epoch.slots
         FROM read_model_model_epochs epoch
         JOIN versions version
           ON version.landscape_id = epoch.landscape_id
          AND version.id = epoch.version_id
        WHERE epoch.state IN (${sqlList(GC_MARKED_EPOCH_STATES)})`,
    )
    for (const row of rows) urls.push(...epochRowDocumentUrls(row).filter((u) => !retiring.has(epochDocumentIdOf(u))))
  }
  if (present[0]?.docs) {
    const { rows } = await db.query<{ document_id: string; role: ModelEpochDocRole; superseded_epoch: number | null }>(
      `SELECT doc.document_id, doc.role, doc.superseded_epoch
         FROM read_model_model_epoch_docs doc
         JOIN versions version
           ON version.landscape_id = doc.landscape_id
          AND version.id = doc.version_id
        WHERE doc.state IN ('live', 'pinned')`,
    )
    for (const row of rows) {
      const url = `automerge:${row.document_id}`
      urls.push(url)
      if (row.role === 'meta' && row.superseded_epoch !== null) retainedMetaUrls.push(url)
    }
  }
  return { urls, retainedMetaUrls }
}

const sameHeadSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((h, i) => h === [...b].sort()[i])

/** A document as storage holds it: its snapshot and incremental chunks
 * loaded into a fresh document. Null when storage holds none. */
export async function storageDocument(db: Queryable, documentId: string): Promise<A.Doc<unknown> | null> {
  const { rows } = await db.query<{ data: Buffer | Uint8Array }>(
    `SELECT data FROM automerge_storage
      WHERE split_part(key, '/', 1) = $1 AND split_part(key, '/', 2) IN ('snapshot', 'incremental')
      ORDER BY split_part(key, '/', 2) DESC, key`,
    [documentId])
  if (rows.length === 0) return null
  let doc = A.init<unknown>()
  for (const row of rows) doc = A.loadIncremental(doc, new Uint8Array(row.data))
  return doc
}

/** The DURABLE heads of a document ({@link storageDocument}). Null when
 * storage holds none. */
export async function storageDurableHeads(db: Queryable, documentId: string): Promise<string[] | null> {
  const doc = await storageDocument(db, documentId)
  return doc ? [...A.getHeads(doc)] : null
}

/** A fenced transaction runner: runs `fn` inside one transaction whose write
 * fence and ownership the caller's implementation asserts first (the pattern
 * of `assertPlaneAndOwnership`, `staticDeltaProjector.ts`). */
export type FencedTransaction = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>

interface EpochRowDb {
  epoch_no: number
  kind: ModelEpochKind
  state: ModelEpochState
  meta_url: string | null
  cut_heads: Record<string, string[]> | null
  slots: Array<{ slot: number; url: string }> | null
  published_at: Date | null
}

const toSnapshot = (row: EpochRowDb) => ({
  epochNo: row.epoch_no,
  kind: row.kind,
  state: row.state,
  metaUrl: row.meta_url,
  cutHeads: row.cut_heads ?? {},
  slots: Array.isArray(row.slots) ? row.slots : [],
  publishedAt: row.published_at,
})

const EPOCH_COLUMNS = 'epoch_no, kind, state, meta_url, cut_heads, slots, published_at'

/** The roll's row operations (`modelEpochRoll.ts` `EpochRowStore`) over
 * PostgreSQL. Every write runs in `fenced`; reads too, so a cell that lost
 * the workspace cannot even plan from rows it no longer owns. */
export function sqlEpochRowStore(fenced: FencedTransaction, key: WorkspaceKey) {
  const ws = [key.landscapeId, key.versionId]
  const one = async (tx: Queryable, where: string): Promise<ReturnType<typeof toSnapshot> | null> => {
    const { rows } = await tx.query<EpochRowDb & Record<string, unknown>>(
      `SELECT ${EPOCH_COLUMNS} FROM read_model_model_epochs
        WHERE landscape_id = $1 AND version_id = $2 AND ${where}`, ws)
    return rows[0] ? toSnapshot(rows[0]) : null
  }
  return {
    published: () => fenced((tx) => one(tx, `state = 'published'`)),
    inFlight: () => fenced((tx) => one(tx, `state IN ('preparing', 'prepared', 'repointing')`)),
    forwardPending: () => fenced((tx) => modelEpochForwardPending(tx, key)),
    maxEpochNo: () => fenced(async (tx) => {
      const { rows } = await tx.query<{ max: number | null }>(
        `SELECT MAX(epoch_no) AS max FROM read_model_model_epochs WHERE landscape_id = $1 AND version_id = $2`, ws)
      return rows[0]?.max ?? -1
    }),
    recordLegacy: (metaUrl: string, baseUrls: string[]) => fenced(async (tx) => {
      await tx.query(
        `INSERT INTO read_model_model_epochs (landscape_id, version_id, epoch_no, kind, state, meta_url, slots, published_at)
         VALUES ($1, $2, 0, 'legacy', 'published', $3, $4::jsonb, now())
         ON CONFLICT DO NOTHING`,
        [...ws, metaUrl, JSON.stringify(baseUrls.map((url, slot) => ({ slot, url })))])
      const docs = [{ url: metaUrl, role: 'meta', slot: null as number | null }, ...baseUrls.map((url, slot) => ({ url, role: 'base', slot }))]
      for (const doc of docs) {
        await tx.query(
          `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, slot)
           VALUES ($1, $2, $3, 0, $4, $5) ON CONFLICT (document_id) DO NOTHING`,
          [epochDocumentIdOf(doc.url), ...ws, doc.role, doc.slot])
      }
    }),
    insertPreparing: (row: { epochNo: number; kind: ModelEpochKind; predecessor: number; cutHeads: Record<string, string[]>; instanceId: string }) =>
      fenced(async (tx) => {
        try {
          await tx.query(
            `INSERT INTO read_model_model_epochs
               (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, cut_heads, instance_id)
             VALUES ($1, $2, $3, $4, 'preparing', $5, $6::jsonb, $7)`,
            [...ws, row.epochNo, row.kind, row.predecessor, JSON.stringify(row.cutHeads), row.instanceId])
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new EpochRollContended(`model epoch ${row.epochNo}: another roll is in flight or won`)
          }
          throw error
        }
      }),
    recordSlots: (epochNo: number, slots: Array<{ slot: number; url: string }>) => fenced(async (tx) => {
      await tx.query(
        `UPDATE read_model_model_epochs SET slots = $4::jsonb, updated_at = now()
          WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3 AND state = 'preparing'`,
        [...ws, epochNo, JSON.stringify(slots)])
    }),
    recordMeta: (epochNo: number, metaUrl: string) => fenced(async (tx) => {
      await tx.query(
        `UPDATE read_model_model_epochs SET meta_url = $4, updated_at = now()
          WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3 AND state = 'preparing'`,
        [...ws, epochNo, metaUrl])
    }),
    setState: (epochNo: number, from: ModelEpochState[], to: ModelEpochState) => fenced(async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE read_model_model_epochs SET state = $5, updated_at = now()
          WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3 AND state = ANY($4::text[])`,
        [...ws, epochNo, from, to])
      return (rowCount ?? 0) === 1
    }),
    publish: (args: { epochNo: number; predecessor: number; created: Array<{ url: string; role: 'meta' | 'base'; slot: number | null }>; superseded: Array<{ url: string; cutHeads: string[] }> }) =>
      fenced(async (tx) => {
        await tx.query(
          `UPDATE read_model_model_epochs SET state = 'retained', updated_at = now()
            WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3 AND state = 'published'`,
          [...ws, args.predecessor])
        await tx.query(
          `UPDATE read_model_model_epochs SET state = 'published', published_at = COALESCE(published_at, now()), updated_at = now()
            WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3 AND state IN ('repointing', 'published')`,
          [...ws, args.epochNo])
        for (const doc of args.created) {
          await tx.query(
            `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, slot)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (document_id) DO NOTHING`,
            [epochDocumentIdOf(doc.url), ...ws, args.epochNo, doc.role, doc.slot])
        }
        for (const doc of args.superseded) {
          // A shard this epoch was cut from may have no row yet — one that
          // joined the predecessor after its own roll (a browser's overflow
          // shard the forwarder had not adopted): recorded now, as the
          // predecessor's, so it is a late-write source like the rest.
          await tx.query(
            `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role)
             VALUES ($1, $2, $3, $4, 'adopted') ON CONFLICT (document_id) DO NOTHING`,
            [epochDocumentIdOf(doc.url), ...ws, args.predecessor])
          await tx.query(
            `UPDATE read_model_model_epoch_docs
                SET superseded_epoch = $4, forward_cursor = COALESCE(forward_cursor, $5::text[]), updated_at = now()
              WHERE document_id = $1 AND landscape_id = $2 AND version_id = $3 AND superseded_epoch IS NULL`,
            [epochDocumentIdOf(doc.url), ...ws, args.epochNo, doc.cutHeads])
        }
      }),
    recordResolution: (epochNo: number, resolution: 'repoint' | 'adopt-root') => fenced(async (tx) => {
      await tx.query(
        `UPDATE read_model_model_epochs SET resolution = $4, updated_at = now()
          WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3`,
        [...ws, epochNo, resolution])
    }),
    adoptRoot: (args: {
      stuck: number; predecessor: number; epochNo: number; metaUrl: string; cutHeads: Record<string, string[]>
      docs: Array<{ url: string; role: 'meta' | 'base' | 'adopted'; slot: number | null; createdEpoch: number; supersededCursor: string[] | null }>
    }) => fenced(async (tx) => {
      // Defence in depth for `resolveStuckRepointing`'s own refusal: a meta
      // already recorded is never adopted again.
      const { rows: known } = await tx.query(
        'SELECT 1 FROM read_model_model_epoch_docs WHERE document_id = $1 FOR UPDATE', [epochDocumentIdOf(args.metaUrl)])
      if (known.length > 0) throw new EpochAdoptKnownDocument(args.metaUrl)
      const stuck = await tx.query(
        `UPDATE read_model_model_epochs SET state = 'retained', resolution = 'adopt-root', updated_at = now()
          WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3 AND state = 'repointing'`,
        [...ws, args.stuck])
      if ((stuck.rowCount ?? 0) !== 1) throw new Error(`model epoch ${args.stuck}: no longer repointing`)
      const predecessor = await tx.query(
        `UPDATE read_model_model_epochs SET state = 'retained', updated_at = now()
          WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3 AND state = 'published'`,
        [...ws, args.predecessor])
      if ((predecessor.rowCount ?? 0) !== 1) throw new Error(`model epoch ${args.predecessor}: no longer published`)
      await tx.query(
        `INSERT INTO read_model_model_epochs
           (landscape_id, version_id, epoch_no, kind, state, predecessor_epoch, meta_url, cut_heads, published_at, resolution)
         VALUES ($1, $2, $3, 'meta', 'published', $4, $5, $6::jsonb, now(), 'adopt-root')`,
        [...ws, args.epochNo, args.stuck, args.metaUrl, JSON.stringify(args.cutHeads)])
      for (const doc of args.docs) {
        // THE ADOPTED META was never built from any source's cut: recorded
        // `built_from_cut = false` (and forced so, should it already have a
        // row), so the forwarder takes the non-aligned path into it.
        const adopted = epochDocumentIdOf(doc.url) === epochDocumentIdOf(args.metaUrl)
        await tx.query(
          `INSERT INTO read_model_model_epoch_docs (document_id, landscape_id, version_id, created_epoch, role, slot, built_from_cut)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (document_id) DO UPDATE SET built_from_cut = read_model_model_epoch_docs.built_from_cut AND EXCLUDED.built_from_cut`,
          [epochDocumentIdOf(doc.url), ...ws, doc.createdEpoch, doc.role, doc.slot, !adopted])
        if (doc.supersededCursor) {
          await tx.query(
            `UPDATE read_model_model_epoch_docs
                SET superseded_epoch = $4, forward_cursor = COALESCE(forward_cursor, $5::text[]), updated_at = now()
              WHERE document_id = $1 AND landscape_id = $2 AND version_id = $3 AND superseded_epoch IS NULL`,
            [epochDocumentIdOf(doc.url), ...ws, args.epochNo, doc.supersededCursor])
        }
      }
    }),
    isEpochDocument: (url: string) => fenced(async (tx) => {
      const { rows } = await tx.query(
        'SELECT 1 FROM read_model_model_epoch_docs WHERE document_id = $1 AND landscape_id = $2 AND version_id = $3',
        [epochDocumentIdOf(url), ...ws])
      return rows.length > 0
    }),
    recordServerChangeHashes: (epochNo: number, hashes: string[]) => fenced(async (tx) => {
      await tx.query(
        `UPDATE read_model_model_epochs
            SET server_change_hashes = ARRAY(SELECT DISTINCT unnest(server_change_hashes || $4::text[])), updated_at = now()
          WHERE landscape_id = $1 AND version_id = $2 AND epoch_no = $3`,
        [...ws, epochNo, hashes])
    }),
  }
}

/**
 * What stops a PROMOTION: a roll in flight, plus every
 * superseded epoch document still `live` (a late-write source, whose writes
 * only the epoch forwarder carries — the static plane does not run it).
 * Zero when the tables do not exist. Throws on any other failure: the caller
 * reads a throw as "unknown", never as zero.
 */
export async function countModelEpochBlockers(db: Queryable, key: WorkspaceKey): Promise<number> {
  const { rows: present } = await db.query<{ epochs: boolean; docs: boolean }>(
    `SELECT to_regclass(current_schema() || '.read_model_model_epochs') IS NOT NULL AS epochs,
            to_regclass(current_schema() || '.read_model_model_epoch_docs') IS NOT NULL AS docs`,
  )
  if (!present[0]?.epochs || !present[0]?.docs) return 0
  const { rows } = await db.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM read_model_model_epochs
               WHERE landscape_id = $1 AND version_id = $2 AND state IN ('preparing', 'prepared', 'repointing'))
           + (SELECT count(*) FROM read_model_model_epoch_docs
               WHERE landscape_id = $1 AND version_id = $2 AND superseded_epoch IS NOT NULL AND state = 'live'))::text AS n`,
    [key.landscapeId, key.versionId])
  return Number(rows[0]?.n ?? 0)
}

/** The late-write SOURCES of a workspace: superseded, still `live`. A carried
 * document (superseded_epoch NULL) is never one. */
export async function listLateWriteSources(
  db: Queryable,
  key: WorkspaceKey,
): Promise<Array<{ documentId: string; role: ModelEpochDocRole; supersededEpoch: number; forwardCursor: string[] | null }>> {
  const { rows } = await db.query<{
    document_id: string; role: ModelEpochDocRole; superseded_epoch: number; forward_cursor: string[] | null
  }>(
    `SELECT document_id, role, superseded_epoch, forward_cursor
       FROM read_model_model_epoch_docs
      WHERE landscape_id = $1 AND version_id = $2
        AND superseded_epoch IS NOT NULL AND state = 'live'
      ORDER BY superseded_epoch, document_id`,
    [key.landscapeId, key.versionId],
  )
  return rows.map((row) => ({
    documentId: row.document_id,
    role: row.role,
    supersededEpoch: row.superseded_epoch,
    forwardCursor: row.forward_cursor,
  }))
}
