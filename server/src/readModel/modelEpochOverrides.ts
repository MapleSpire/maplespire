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

import type { ForwardOverride, Path } from '../modelEpochForward.js'
import type { WorkspaceKey } from './projector.js'
import type { Queryable } from './types.js'

/**
 * OVERRIDE ROWS (G4-16f, the server half).
 *
 * The forwarder writes, in the SAME transaction that commits a forward, one
 * row per leaf where the current epoch won ("the current epoch wins"):
 * Marie's offline value, the value that beat it, the target's heads right
 * after the forward, and the ACTORS of the late changes — so the tab that
 * made them (and only it) is offered to re-apply them.
 *
 * Resolution, by BATCH ID: the tab writes the re-apply as one edit
 * whose every change carries `{reapplyBatch: <uuid>}`, then resolves the rows
 * by that id. A crash between the two is recovered by finding the message,
 * never by comparing values (the ABA case). Undoing the batch reverts its
 * rows — re-applied or dismissed, by the same user — to `pending`. Rows are
 * pruned when their source document retires.
 */

export const OVERRIDE_STATES = ['pending', 'reapplied', 'dismissed', 'stale'] as const
export type OverrideState = (typeof OVERRIDE_STATES)[number]

const ENTITY_KIND: Record<string, string> = {
  objects: 'object', connections: 'connection', groups: 'group', domains: 'domain', tags: 'tag', decisionRecords: 'decision-record',
}

export async function ensureModelEpochOverrideSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_model_epoch_overrides (
      id                        TEXT PRIMARY KEY,
      landscape_id              TEXT NOT NULL,
      version_id                TEXT NOT NULL,
      journal_id                TEXT NOT NULL,
      source_doc                TEXT NOT NULL,
      target_doc                TEXT NOT NULL,
      entity_kind               TEXT NOT NULL,
      entity_id                 TEXT,
      path                      JSONB NOT NULL,
      reason                    TEXT NOT NULL,
      late_value                JSONB,
      current_value_at_forward  JSONB,
      current_heads_at_forward  TEXT[] NOT NULL,
      late_actors               TEXT[] NOT NULL,
      state                     TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (${OVERRIDE_STATES.map((s) => `'${s}'`).join(', ')})),
      batch_id                  TEXT,
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at               TIMESTAMPTZ,
      resolved_by               TEXT
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_model_epoch_overrides_workspace
    ON read_model_model_epoch_overrides (landscape_id, version_id, state)`)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_read_model_model_epoch_overrides_batch
    ON read_model_model_epoch_overrides (batch_id) WHERE batch_id IS NOT NULL`)
  // The Automerge actors an AUTHENTICATED user's tabs have asked with, per
  // workspace — so a row one of her tabs (or devices) made is offered in
  // every one of them.
  await db.query(`
    CREATE TABLE IF NOT EXISTS read_model_model_epoch_override_actors (
      landscape_id  TEXT NOT NULL,
      version_id    TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      actor         TEXT NOT NULL,
      seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (landscape_id, version_id, user_id, actor)
    )
  `)
  // The table ties a user to her
  // changes in the documents' history — her rows go with her account. A
  // foreign key, as every other per-user table (`auth/schema.ts`), added
  // once and only where the auth schema exists (a read-model-only test
  // schema has no `users`).
  await db.query(`
    DO $$
    BEGIN
      IF to_regclass(current_schema() || '.users') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'read_model_model_epoch_override_actors_user_fk'
                           AND conrelid = (current_schema() || '.read_model_model_epoch_override_actors')::regclass) THEN
        DELETE FROM read_model_model_epoch_override_actors a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id);
        ALTER TABLE read_model_model_epoch_override_actors
          ADD CONSTRAINT read_model_model_epoch_override_actors_user_fk
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN duplicate_object THEN NULL; -- two processes booting at once
    END
    $$`)
}

/** The most recent actors of one user kept per workspace. */
export const USER_OVERRIDE_ACTORS_MAX = 1_024

/**
 * The actors to list a SIGNED-IN user's rows by.
 * A row is keyed by the Automerge actors of the late changes, and an actor is
 * per page load × document handle: two tabs of Marie, two devices, have
 * different ones, and each tab saw only its own actors' rows — the rule speaks of
 * MARIE's offline edits. The actors a tab asks with are recorded under the
 * user, and the user's recorded actors are added to them. Claiming an actor
 * gains nothing a reader could not already ask for (actor ids are in every
 * document's history, and the read route is the workspace's read gate).
 * Without a session (AUTH off) there is no user: only what was asked.
 *
 * BOUNDED.
 * Recorded only when `record` (the route passes it for a WRITER: a reader
 * has no rows of its own, and the GET is open to readers), and each record
 * prunes the user's actors in the workspace to the `USER_OVERRIDE_ACTORS_MAX`
 * most recent at once — before, nothing ever deleted a row and a reader
 * could grow the table without end. The table is a workspace-user table
 * (`EPOCH_WORKSPACE_USER_TABLES`: dropped with the workspace) and its rows
 * go with the user's account (a foreign key, `ON DELETE CASCADE`).
 */
export async function overrideActorsOfUser(db: Queryable, key: WorkspaceKey, userId: string, asked: readonly string[], record = true): Promise<string[]> {
  // ISOLATED —
  // the record is a convenience of a read, never its failure. A session still
  // valid for an account just deleted violates the foreign key (23503): it
  // records nothing, silently; any other fault is logged and the rows are
  // listed all the same. `db` is the pool (no transaction to poison).
  if (record && asked.length > 0) await recordOverrideActors(db, key, userId, asked).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== '23503') console.warn('epoch override actors could not be recorded', error)
  })
  const { rows } = await db.query<{ actor: string }>(
    `SELECT actor FROM read_model_model_epoch_override_actors
      WHERE landscape_id = $1 AND version_id = $2 AND user_id = $3
      ORDER BY seen_at DESC, actor LIMIT $4`,
    [key.landscapeId, key.versionId, userId, USER_OVERRIDE_ACTORS_MAX])
  return [...new Set([...asked, ...rows.map((r) => r.actor)])]
}

async function recordOverrideActors(db: Queryable, key: WorkspaceKey, userId: string, asked: readonly string[]): Promise<void> {
  await db.query(
    `INSERT INTO read_model_model_epoch_override_actors (landscape_id, version_id, user_id, actor)
     SELECT $1, $2, $3, a FROM unnest($4::text[]) AS a
     ON CONFLICT (landscape_id, version_id, user_id, actor) DO UPDATE SET seen_at = now()`,
    [key.landscapeId, key.versionId, userId, [...asked]])
  await db.query(
    `DELETE FROM read_model_model_epoch_override_actors
      WHERE landscape_id = $1 AND version_id = $2 AND user_id = $3
        AND actor NOT IN (
          SELECT actor FROM read_model_model_epoch_override_actors
           WHERE landscape_id = $1 AND version_id = $2 AND user_id = $3
           ORDER BY seen_at DESC, actor LIMIT $4)`,
    [key.landscapeId, key.versionId, userId, USER_OVERRIDE_ACTORS_MAX])
}

export interface OverrideInsert {
  journalId: string
  sourceDoc: string
  targetDoc: string
  override: ForwardOverride
  currentHeadsAtForward: string[]
  lateActors: string[]
}

/** The row id is DETERMINISTIC per (journal, target, path): a replayed
 * completion inserts nothing twice. */
export function overrideRowId(journalId: string, targetDoc: string, path: Path): string {
  return `${journalId}:${targetDoc}:${JSON.stringify(path)}`
}

export async function insertOverrides(tx: Queryable, key: WorkspaceKey, rows: readonly OverrideInsert[]): Promise<void> {
  for (const row of rows) {
    const path = row.override.target
    await tx.query(
      `INSERT INTO read_model_model_epoch_overrides
         (id, landscape_id, version_id, journal_id, source_doc, target_doc, entity_kind, entity_id, path, reason,
          late_value, current_value_at_forward, current_heads_at_forward, late_actors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::text[], $14::text[])
       ON CONFLICT (id) DO NOTHING`,
      [overrideRowId(row.journalId, row.targetDoc, path), key.landscapeId, key.versionId, row.journalId, row.sourceDoc, row.targetDoc,
        ENTITY_KIND[String(path[0])] ?? 'meta', path.length > 1 ? String(path[1]) : null, JSON.stringify(path), row.override.reason,
        JSON.stringify(row.override.late ?? null), JSON.stringify(row.override.current ?? null),
        row.currentHeadsAtForward, row.lateActors])
  }
}

export interface OverrideRow {
  id: string
  entityKind: string
  entityId: string | null
  path: Path
  reason: string
  lateValue: unknown
  currentValueAtForward: unknown
  currentHeadsAtForward: string[]
  targetDoc: string
  state: OverrideState
  createdAt: Date
}

/** The PENDING rows whose late actors intersect `actors` (the tab's own). */
export async function listOverridesForActors(db: Queryable, key: WorkspaceKey, actors: readonly string[]): Promise<OverrideRow[]> {
  if (actors.length === 0) return []
  const { rows } = await db.query<{
    id: string; entity_kind: string; entity_id: string | null; path: Path; reason: string; late_value: unknown
    current_value_at_forward: unknown; current_heads_at_forward: string[]; target_doc: string; state: OverrideState; created_at: Date
  }>(
    `SELECT id, entity_kind, entity_id, path, reason, late_value, current_value_at_forward, current_heads_at_forward,
            target_doc, state, created_at
       FROM read_model_model_epoch_overrides
      WHERE landscape_id = $1 AND version_id = $2 AND state = 'pending' AND late_actors && $3::text[]
      ORDER BY created_at, id`,
    [key.landscapeId, key.versionId, [...actors]])
  return rows.map((r) => ({
    id: r.id, entityKind: r.entity_kind, entityId: r.entity_id, path: r.path, reason: r.reason, lateValue: r.late_value,
    currentValueAtForward: r.current_value_at_forward, currentHeadsAtForward: r.current_heads_at_forward,
    targetDoc: r.target_doc, state: r.state, createdAt: r.created_at,
  }))
}

export type ResolveRequest =
  | { batchId: string; reapplied: string[]; dismissed: string[] }
  | { revert: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseResolveRequest(body: unknown): ResolveRequest | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const ids = (v: unknown) => Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string' && x.length <= 512) ? v as string[] : null
  if (typeof b.revert === 'string') return UUID.test(b.revert) ? { revert: b.revert } : null
  if (typeof b.batchId !== 'string' || !UUID.test(b.batchId)) return null
  const reapplied = ids(b.reapplied ?? [])
  const dismissed = ids(b.dismissed ?? [])
  if (!reapplied || !dismissed) return null
  return { batchId: b.batchId, reapplied, dismissed }
}

/**
 * Resolve rows in ONE transaction. Both `reapplied` and `dismissed` rows take
 * the batch id (a dismissal can be undone too), so a revert
 * finds exactly them; only `pending` rows move (a second resolve of the same
 * batch is a no-op). A revert returns the batch's rows to `pending` — only
 * the rows THIS user resolved (`resolved_by`): a batch id is not a
 * credential, and another writer's resolution is not undone by naming it.
 */
export async function resolveOverrides(
  tx: Queryable, key: WorkspaceKey, request: ResolveRequest, resolvedBy: string | null,
): Promise<{ reapplied: number; dismissed: number; reverted: number }> {
  const ws = [key.landscapeId, key.versionId]
  if ('revert' in request) {
    const { rowCount } = await tx.query(
      `UPDATE read_model_model_epoch_overrides
          SET state = 'pending', batch_id = NULL, resolved_at = NULL, resolved_by = NULL
        WHERE landscape_id = $1 AND version_id = $2 AND batch_id = $3 AND state IN ('reapplied', 'dismissed')
          AND resolved_by IS NOT DISTINCT FROM $4`,
      [...ws, request.revert, resolvedBy])
    return { reapplied: 0, dismissed: 0, reverted: rowCount ?? 0 }
  }
  const reapplied = request.reapplied.length === 0 ? 0 : (await tx.query(
    `UPDATE read_model_model_epoch_overrides
        SET state = 'reapplied', batch_id = $4, resolved_at = now(), resolved_by = $5
      WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[]) AND state = 'pending'`,
    [...ws, request.reapplied, request.batchId, resolvedBy])).rowCount ?? 0
  const dismissed = request.dismissed.length === 0 ? 0 : (await tx.query(
    `UPDATE read_model_model_epoch_overrides
        SET state = 'dismissed', batch_id = $4, resolved_at = now(), resolved_by = $5
      WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[]) AND state = 'pending'`,
    [...ws, request.dismissed, request.batchId, resolvedBy])).rowCount ?? 0
  return { reapplied, dismissed, reverted: 0 }
}

/** Retirement prunes the rows of a retired source (the end of the window). */
export async function pruneOverridesOfRetiredSources(tx: Queryable, key: WorkspaceKey): Promise<number> {
  const { rowCount } = await tx.query(
    `DELETE FROM read_model_model_epoch_overrides o
      WHERE o.landscape_id = $1 AND o.version_id = $2
        AND EXISTS (SELECT 1 FROM read_model_model_epoch_docs d WHERE d.document_id = o.source_doc AND d.state = 'retired')`,
    [key.landscapeId, key.versionId])
  return rowCount ?? 0
}
