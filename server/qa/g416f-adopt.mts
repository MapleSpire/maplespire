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

/**
 * G4-16f C8b — the pieces of the verify-and-adopt bench arms that do not
 * depend on the measuring child (`g416f-measure-child.mts`, which runs at
 * import and so cannot be imported): whether this build accepts
 * `READ_MODEL_ADOPT=on`, the adopt template's plane check, a full `ro_*`
 * dump hash, the edits made through a Repo (by the prime, by the separate
 * writer, and the write injected after the claim), and the boot arm's
 * re-key. Run by no gate; `server/tsconfig.check.json` covers `server/qa`.
 */
import { performance } from 'node:perf_hooks'
import pg from 'pg'
import type { Repo } from '@automerge/automerge-repo'
import { findReadyDocument } from '../src/automergeRepoCompat.js'
import { readModelAdoptMode, type ReadModelAdoptMode } from '../src/readModel/adoptVerify.js'
import { adoptRefusal, readAdoptPlane, type AdoptPlaneRow } from '../src/readModel/adoptState.js'
import type { WorkspaceKey } from '../src/readModel/projector.js'
import type { Queryable } from '../src/readModel/types.js'
import { BASE_OBJECTS, baseObjectId, mulberry32 } from './g416f-model.mjs'

/** `READ_MODEL_ADOPT=on` as this tree's own parser answers it. C6-1 throws
 * ("not available in this build"); C6-2a returns `on`. Never guessed from a
 * version: the parser the server boots with is the one asked. */
export function adoptOnSupport(): { supported: true } | { supported: false; reason: string } {
  try {
    const mode = readModelAdoptMode({ READ_MODEL_ADOPT: 'on' }) as string
    if (mode === 'on') return { supported: true }
    return { supported: false, reason: `READ_MODEL_ADOPT=on parses as ${JSON.stringify(mode)} in this build` }
  } catch (error) {
    return { supported: false, reason: `READ_MODEL_ADOPT=on refused by this build: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The `on` mode as the attach option takes it. A cast: on a tree where the
 * type has no `on` (C6-1) this value is never passed — `adoptOnSupport`
 * gates every caller. */
export const ADOPT_ON = 'on' as unknown as ReadModelAdoptMode

/** The adopt row an adopter would read first (`readAdoptPlane`) and its
 * pre-mutex refusal (`adoptRefusal`): null means the template can adopt as
 * far as the fast check sees. */
export async function adoptTemplateCheck(db: Queryable, key: WorkspaceKey): Promise<{ refusal: string | null; plane: AdoptPlaneRow | null }> {
  const plane = await readAdoptPlane(db, key)
  return { refusal: adoptRefusal(plane), plane: plane ?? null }
}

/** The fields of a plane worth a record line (the id lists as counts). */
export function planeSummary(plane: AdoptPlaneRow | null): Record<string, unknown> | null {
  if (!plane) return null
  return {
    formatVersion: plane.formatVersion, adoptVersion: plane.adoptVersion,
    bound: plane.fenceBinding !== null && plane.fenceBinding === plane.writeFence,
    objectShards: plane.objectShardIds?.length ?? null, connectionShards: plane.connectionShardIds?.length ?? null,
    registryShards: plane.registryShardIds?.length ?? null, sealedCeiling: plane.sealedCeiling, posture: plane.posture,
    defects: plane.defects,
  }
}

export interface RoDump {
  /** md5 over the per-table hashes, in table order. */
  hash: string
  rows: number
  tables: Record<string, { rows: number; hash: string }>
  /** `ro_*` tables with no `landscape_id`/`version_id` (not dumped). */
  skipped: string[]
  /** Columns left out: bookkeeping timestamps, which differ between two
   * builds of the same rows. */
  excludedColumns: string[]
  ms: number
}

/**
 * A FULL dump hash of the workspace's `ro_*` rows: every `ro_*` table of the
 * schema that carries `landscape_id` and `version_id`, every column but the
 * timestamp ones, one md5 per row (`row(...)::text`), sorted, then md5 of
 * them. Equal hashes = equal row sets, content included (not only the id sets
 * the stamp digests certify).
 */
export async function roDump(db: Queryable, key: WorkspaceKey): Promise<RoDump> {
  const started = performance.now()
  const { rows: columns } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.table_name LIKE 'ro\\_%'
      ORDER BY c.table_name, c.ordinal_position`)
  const byTable = new Map<string, Array<{ name: string; type: string }>>()
  for (const row of columns) {
    const list = byTable.get(row.table_name) ?? []
    list.push({ name: row.column_name, type: row.data_type })
    byTable.set(row.table_name, list)
  }
  const tables: RoDump['tables'] = {}
  const skipped: string[] = []
  const excludedColumns: string[] = []
  let total = 0
  for (const [table, cols] of [...byTable.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const names = new Set(cols.map((col) => col.name))
    if (!names.has('landscape_id') || !names.has('version_id')) { skipped.push(table); continue }
    const kept = cols.filter((col) => {
      const timestamp = col.type.startsWith('timestamp')
      if (timestamp) excludedColumns.push(`${table}.${col.name}`)
      return !timestamp
    })
    // Identifiers come from the catalogue, quoted.
    const list = kept.map((col) => `"${col.name.replace(/"/g, '""')}"`).join(', ')
    const { rows } = await db.query<{ n: string; h: string }>(
      `SELECT count(*)::text AS n, md5(coalesce(string_agg(r, '' ORDER BY r COLLATE "C"), '')) AS h
         FROM (SELECT md5(row(${list})::text) AS r FROM "${table}" WHERE landscape_id = $1 AND version_id = $2) s`,
      [key.landscapeId, key.versionId])
    tables[table] = { rows: Number(rows[0]!.n), hash: rows[0]!.h }
    total += Number(rows[0]!.n)
  }
  const { rows: combined } = await db.query<{ h: string }>('SELECT md5($1) AS h',
    [Object.entries(tables).map(([table, entry]) => `${table}:${entry.hash}`).join('\n')])
  return { hash: combined[0]!.h, rows: total, tables, skipped, excludedColumns, ms: Math.round(performance.now() - started) }
}

/** Which tables differ between two dumps (by hash or presence). */
export function dumpDiff(a: RoDump, b: RoDump): Array<{ table: string; a: { rows: number; hash: string } | null; b: { rows: number; hash: string } | null }> {
  const names = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort()
  return names
    .filter((name) => a.tables[name]?.hash !== b.tables[name]?.hash)
    .map((name) => ({ table: name, a: a.tables[name] ?? null, b: b.tables[name] ?? null }))
}

export type AdoptEditKind = 'object' | 'connection' | 'meta'
export const ADOPT_EDIT_KINDS: readonly AdoptEditKind[] = ['object', 'connection', 'meta']
export interface AdoptEdit { seq: number; kind: AdoptEditKind; id: string; op: string; want: string; visibleMs?: number | null }

type EditShard = { objects?: Record<string, Record<string, unknown>>; connections?: Record<string, Record<string, unknown>> }
type EditMeta = {
  editsObjectShardUrl: string; editsConnectionShardUrl?: string; connectionShardUrls?: string[]
  groups?: Record<string, Record<string, unknown>>
}

const VISIBLE_SQL: Record<AdoptEditKind, string> = {
  object: 'SELECT name AS v FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  connection: 'SELECT label AS v FROM ro_connections WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
  meta: 'SELECT name AS v FROM ro_groups WHERE landscape_id = $1 AND version_id = $2 AND id = $3',
}

/** ms from `t0` until the edit's row carries its value; null after `timeoutMs`. */
export async function waitVisible(db: Queryable, key: WorkspaceKey, edit: AdoptEdit, t0: number, timeoutMs = 30_000, pollMs = 1): Promise<number | null> {
  for (;;) {
    const { rows } = await db.query<{ v: string | null }>(VISIBLE_SQL[edit.kind], [key.landscapeId, key.versionId, edit.id])
    const now = performance.now()
    if (rows[0]?.v === edit.want) return now - t0
    if (now - t0 > timeoutMs) return null
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * `count` edits through `repo`, interleaved object / connection / meta, each
 * a SUFFIX on the current value (` ~<tag>-<seq>`), so a witness name prefix
 * (`<id> r<rev> `) is kept. Objects are base ids drawn from `seed`, never one
 * in `exclude` (the witness sample); connections are drawn from the
 * `ro_connections` rows; meta adds a group. An object or connection absent
 * from the current write head is written whole (its `ro_*` data with the new
 * value), as a client's first overlay write is; one already there gets a
 * field edit. Rows are read on `db` (the kept or projected rows: the source of
 * the current value). With `visible`, each edit is awaited in its `ro_*` row
 * before the next (`visibleMs`).
 */
export async function makeAdoptEdits(repo: Repo, db: Queryable, key: WorkspaceKey, metaUrl: string, options: {
  count: number; seed: number; tag: string; exclude: ReadonlySet<string>
  visible?: { db: Queryable; timeoutMs: number }
}): Promise<{ edits: AdoptEdit[]; failures: string[] }> {
  const random = mulberry32(options.seed)
  const used = new Set<string>()
  const edits: AdoptEdit[] = []
  const failures: string[] = []
  const ws = [key.landscapeId, key.versionId]
  const metaHandle = await findReadyDocument<EditMeta>(repo, metaUrl)
  const { rows: connCount } = await db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM ro_connections WHERE landscape_id = $1 AND version_id = $2', ws)
  const connections = Number(connCount[0]!.n)
  for (let seq = 0; seq < options.count; seq += 1) {
    const kind = ADOPT_EDIT_KINDS[seq % ADOPT_EDIT_KINDS.length]!
    let edit: AdoptEdit
    let t0: number
    if (kind === 'object') {
      let id = ''
      for (let guard = 0; guard < 10_000; guard += 1) {
        const candidate = baseObjectId(Math.floor(random() * BASE_OBJECTS))
        if (!options.exclude.has(candidate) && !used.has(candidate)) { id = candidate; break }
      }
      used.add(id)
      const { rows } = await db.query<{ name: string; data: Record<string, unknown> }>(
        'SELECT name, data FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = $3', [...ws, id])
      if (!rows.length) { failures.push(`edit ${options.tag}: object ${id} has no ro_objects row`); continue }
      const want = `${rows[0]!.name} ~${options.tag}-${seq}`
      const head = await findReadyDocument<EditShard>(repo, metaHandle.doc()!.editsObjectShardUrl)
      const whole = head.doc()?.objects?.[id] ? null : { ...rows[0]!.data, name: want }
      edit = { seq, kind, id, op: whole ? 'whole' : 'field', want }
      t0 = performance.now()
      head.change((doc) => {
        if (!doc.objects) doc.objects = {}
        if (whole) doc.objects[id] = whole
        else doc.objects[id]!.name = want
      })
    } else if (kind === 'connection') {
      if (connections === 0) { failures.push(`edit ${options.tag}: no ro_connections row to edit`); continue }
      let row: { id: string; label: string; data: Record<string, unknown> } | undefined
      for (let guard = 0; guard < 100 && !row; guard += 1) {
        const { rows } = await db.query<{ id: string; label: string; data: Record<string, unknown> }>(
          `SELECT id, label, data FROM ro_connections WHERE landscape_id = $1 AND version_id = $2
            ORDER BY id COLLATE "C" LIMIT 1 OFFSET $3`, [...ws, Math.floor(random() * connections)])
        if (rows[0] && !used.has(rows[0].id)) row = rows[0]
      }
      if (!row) { failures.push(`edit ${options.tag}: no unused connection drawn`); continue }
      used.add(row.id)
      const id = row.id
      const want = `${row.label} ~${options.tag}-${seq}`
      const meta = metaHandle.doc()!
      // The connection write head; a corpus without one gets the edit in the
      // listed shard that holds the connection.
      let headUrl = meta.editsConnectionShardUrl
      if (!headUrl) {
        for (const url of meta.connectionShardUrls ?? []) {
          const shard = await findReadyDocument<EditShard>(repo, url)
          if (shard.doc()?.connections?.[id]) { headUrl = url; break }
        }
      }
      if (!headUrl) { failures.push(`edit ${options.tag}: no shard holds connection ${id}`); continue }
      const head = await findReadyDocument<EditShard>(repo, headUrl)
      const whole = head.doc()?.connections?.[id] ? null : { ...row.data, label: want }
      edit = { seq, kind, id, op: whole ? 'whole' : 'field', want }
      t0 = performance.now()
      head.change((doc) => {
        if (!doc.connections) doc.connections = {}
        if (whole) doc.connections[id] = whole
        else doc.connections[id]!.label = want
      })
    } else {
      const id = `g-${options.tag}-${seq}`
      const want = `group ${options.tag} ${seq}`
      edit = { seq, kind, id, op: 'add-group', want }
      t0 = performance.now()
      metaHandle.change((meta) => {
        if (!meta.groups) meta.groups = {}
        meta.groups[id] = { id, name: want, objectIds: [] }
      })
    }
    if (options.visible) {
      const ms = await waitVisible(options.visible.db, key, edit, t0, options.visible.timeoutMs)
      edit.visibleMs = ms === null ? null : Math.round(ms * 100) / 100
      if (ms === null) failures.push(`edit ${options.tag}: ${kind} ${edit.id} not visible within ${options.visible.timeoutMs} ms`)
    }
    edits.push(edit)
  }
  return { edits, failures }
}

/** How many of `edits` their `ro_*` rows carry now (one read each). */
export async function editsVisibleNow(db: Queryable, key: WorkspaceKey, edits: readonly AdoptEdit[]): Promise<{ visible: number; total: number; missing: string[] }> {
  const missing: string[] = []
  for (const edit of edits) {
    const { rows } = await db.query<{ v: string | null }>(VISIBLE_SQL[edit.kind], [key.landscapeId, key.versionId, edit.id])
    if (rows[0]?.v !== edit.want) missing.push(`${edit.kind} ${edit.id}`)
  }
  return { visible: edits.length - missing.length, total: edits.length, missing: missing.slice(0, 10) }
}

/**
 * The boot arm's RE-KEY (`g416f-measure-child.mts`, `bootArm`): the corpus
 * becomes the default workspace. On its OWN connection, never a pool's:
 * every connection of `guardIdleClientErrors`'s pools carries the protocol
 * participant marker, and on such a connection the adopt protocol's statement
 * triggers enforce THE LOCK ORDER (`schema.ts`, `ADOPT_PROTOCOL_TOUCHED_BODY`)
 * and raise on a retirement or fold row moved without its fence row held. A
 * plain client is a non-participant: the triggers re-stamp without the check.
 * `read_model_adopt_state` is re-keyed FIRST, so each protocol table's
 * re-stamp lands on the new key's adopt row (re-keyed after, the old key's
 * row would be stamped with the digests of an empty set, then moved); and
 * the new key is re-stamped once more at the end, explicitly, when the
 * function exists. The adopt row's own digests (topology, ids) carry no
 * landscape id. Foreign keys between re-keyed tables are dropped and added
 * back around the updates (see below).
 */
export async function rekeyForBoot(connectionString: string, schema: string, from: WorkspaceKey, to: WorkspaceKey, rootUrl: string,
  options: { analyze?: boolean } = {}): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString, options: `-c search_path=${schema}` })
  await client.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO landscapes (id, name, default_version_id) VALUES ($1, $2, $3)', [to.landscapeId, 'Default', to.versionId])
    await client.query('UPDATE versions SET landscape_id = $1 WHERE landscape_id = $2', [to.landscapeId, from.landscapeId])
    const { rows: found } = await client.query<{ name: string }>(
      `SELECT c.table_name AS name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = current_schema() AND c.column_name = 'landscape_id' AND c.table_name NOT IN ('versions')`)
    const first = ['read_model_adopt_state', 'read_model_projection_state']
    const tables = [...first.filter((name) => found.some((row) => row.name === name)),
      ...found.map((row) => row.name).filter((name) => !first.includes(name)).sort()]
    // A foreign key between two re-keyed tables (the sealed-product cache's
    // entities → extracts; static documents → workspaces) has no ON UPDATE
    // CASCADE and is not deferrable: whichever side moves first breaks it.
    // On this throwaway copy, such keys are dropped for the re-key and added
    // back, VALIDATED, from their own definitions before the commit.
    const { rows: foreignKeys } = await client.query<{ table_name: string; name: string; definition: string }>(
      `SELECT c.conrelid::regclass::text AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace
          AND c.conrelid::regclass::text = ANY($1::text[]) AND c.confrelid::regclass::text = ANY($1::text[])`,
      [tables])
    for (const fk of foreignKeys) await client.query(`ALTER TABLE ${fk.table_name} DROP CONSTRAINT "${fk.name}"`)
    for (const name of tables) {
      // Table names come from the catalogue, not from input.
      await client.query(`UPDATE "${name}" SET landscape_id = $1 WHERE landscape_id = $2`, [to.landscapeId, from.landscapeId])
    }
    // Verbatim: a key the schema added `NOT VALID` comes back `NOT VALID`;
    // every other is validated here, against the re-keyed rows.
    for (const fk of foreignKeys) {
      await client.query(`ALTER TABLE ${fk.table_name} ADD CONSTRAINT "${fk.name}" ${fk.definition}`)
    }
    await client.query('DELETE FROM landscapes WHERE id = $1', [from.landscapeId])
    await client.query(`INSERT INTO automerge_meta (key, value) VALUES ('root_url', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [rootUrl])
    // The corpus's `scopes` is a four-column STUB (it only answers the
    // projector's org lookup). `ensureRbacSchema` skips an existing table and
    // then indexes `parent_id` on it: measured, boot dies on 42703. It is
    // empty, so dropping it lets index.ts create the real one.
    await client.query('DROP TABLE IF EXISTS scopes')
    const { rows: fn } = await client.query<{ present: boolean }>(
      `SELECT to_regprocedure(current_schema() || '.read_model_adopt_protocol_restamp(text,text)') IS NOT NULL AS present`)
    let restamped = false
    if (fn[0]?.present) {
      await client.query('SELECT read_model_adopt_protocol_restamp($1, $2)', [to.landscapeId, to.versionId])
      restamped = true
    }
    // The stored protocol digests against the protocol rows as they now
    // stand under the new key (null: no adopt row or no digest function).
    let digestsCurrent: boolean | null = null
    if (restamped) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT s.retirements_digest = d.retirements AND s.folds_digest = d.folds AS ok
           FROM read_model_adopt_state s, read_model_adopt_protocol_digests($1, $2) d
          WHERE s.landscape_id = $1 AND s.version_id = $2`, [to.landscapeId, to.versionId])
      digestsCurrent = rows[0]?.ok ?? null
    }
    await client.query('COMMIT')
    // THE PLANNER'S VIEW OF THE MOVE (G4-16f bootdiag, 2026-11-09). The
    // UPDATEs above move every row to the new key, and the copy's statistics
    // still say the old one (`pg_stats.most_common_vals` = {l-g416f}): a
    // statement planned before autovacuum's next analyze estimates ~1 row
    // for the new key. Measured on the bench machine, mid 3y: the adopt B2 winners
    // statement (`readSealedWinners`, 110 463 entity rows, 28 631 winners)
    // planned a nested loop rescanning every entity row per winner and ran
    // for minutes (readiness ~500 s; high 3y never ready in 600 s), against
    // 318 ms once analyzed. A server on its own key has statistics for it,
    // so this boot arm analyzes what it moved; `analyze: false` reproduces
    // the stale-statistics boot.
    let analyzeMs: number | null = null
    if (options.analyze !== false) {
      const analyzeStarted = performance.now()
      // What still exists: `scopes` (re-keyed above) was dropped.
      const { rows: present } = await client.query<{ name: string }>(
        `SELECT name FROM unnest($1::text[]) AS t(name) WHERE to_regclass(quote_ident(name)) IS NOT NULL`,
        [['landscapes', 'versions', ...tables]])
      for (const { name } of present) await client.query(`ANALYZE "${name}"`)
      analyzeMs = Math.round(performance.now() - analyzeStarted)
    }
    return { tables: tables.length + 2, order: tables.slice(0, 3), restamped, digestsCurrent, foreignKeysReAdded: foreignKeys.map((fk) => `${fk.table_name}.${fk.name}`), analyzeMs }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await client.end().catch(() => undefined)
  }
}
