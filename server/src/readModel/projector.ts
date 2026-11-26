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

import type {
  Queryable, ObjectInput, ConnectionInput, GroupInput, DiagramInput, FlowInput, TechnologyUsageInput,
} from './types.js'
import {
  adjustWorkspaceCount,
  adjustRootObjectCount,
  analyzeWithinCeiling,
  countExistingIds,
  rebuildReadModelDerivedStats,
  refreshConnectionStats,
  refreshConnectionStatsForEndpoints,
  refreshDiagramSummaries,
  refreshObjectChildStats,
} from './derivedStats.js'
import pg from 'pg'
import { withAtomicStatements } from './queryableShape.js'
import { timedPhase, type RowWriteTimings } from './rowWriteTimings.js'
import { recordIdSetDelta } from './contentDigest.js'

/**
 * The projector: materialize the read-model rows from model entities. Pure row
 * mappers (denormalized columns + full entity in `data`) + idempotent,
 * replay-safe DB writes. Reused for the one-time cold build and per-shard
 * incremental updates (an object never moves shards, so a shard delta is local).
 *
 * Every row belongs to exactly one workspace (`WorkspaceKey` = landscapeId +
 * versionId), carried as the leading columns of the composite PK — every read/
 * write here takes a `WorkspaceKey` and scopes its SQL by it, so concurrently
 * projected workspaces never collide (see projectorService.ts's `ProjectorFleet`).
 */

export interface WorkspaceKey {
  landscapeId: string
  versionId: string
}

export interface ObjectRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  id: string
  type: string
  name: string
  description: string
  technology: string
  domain_id: string | null
  parent_id: string | null
  effective_parent_id: string | null
  c4_parent_id: string | null
  scope: string | null
  status: string | null
  data: ObjectInput
}

export interface ConnectionRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  id: string
  from_id: string
  to_id: string
  label: string
  kind: string | null
  data: ConnectionInput
}

export interface ObjectTechnologyRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  object_id: string
  usage_id: string
  technology_id: string
  catalog_revision: number
  used_version: string | null
  role: string | null
  snapshot: TechnologyUsageInput['snapshot']
}

export interface GroupTechnologyRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  group_id: string
  usage_id: string
  technology_id: string
  catalog_revision: number
  used_version: string | null
  role: string | null
  snapshot: TechnologyUsageInput['snapshot']
}

export interface ObjectTeamRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  object_id: string
  team_id: string
}

export interface ObjectTagRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  object_id: string
  tag_id: string
  ordinal: number
}

export interface GroupTagRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  group_id: string
  tag_id: string
  ordinal: number
}

function orderedTagIds(
  carrier: Pick<ObjectInput, 'tagAssignments' | 'tagOrder'> | Pick<GroupInput, 'tagAssignments' | 'tagOrder'>
): string[] {
  const assignments = carrier.tagAssignments ?? {}
  const assignedIds = Object.entries(assignments)
    .filter(([mapKey, assignment]) => !!mapKey && assignment?.tagId === mapKey)
    .map(([mapKey]) => mapKey)
  const assigned = new Set(assignedIds)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const tagId of carrier.tagOrder ?? []) {
    if (assigned.has(tagId) && !seen.has(tagId)) {
      ordered.push(tagId)
      seen.add(tagId)
    }
  }
  for (const tagId of assignedIds.sort()) {
    if (!seen.has(tagId)) ordered.push(tagId)
  }
  return ordered
}

export function objectTagRows(
  key: WorkspaceKey,
  orgId: string | null,
  object: ObjectInput
): ObjectTagRowValues[] {
  return orderedTagIds(object).map((tagId, ordinal) => ({
    landscape_id: key.landscapeId,
    version_id: key.versionId,
    org_id: orgId,
    object_id: object.id,
    tag_id: tagId,
    ordinal,
  }))
}

export function groupTagRows(
  key: WorkspaceKey,
  orgId: string | null,
  group: GroupInput
): GroupTagRowValues[] {
  return orderedTagIds(group).map((tagId, ordinal) => ({
    landscape_id: key.landscapeId,
    version_id: key.versionId,
    org_id: orgId,
    group_id: group.id,
    tag_id: tagId,
    ordinal,
  }))
}

export function objectTeamRows(
  key: WorkspaceKey,
  orgId: string | null,
  object: ObjectInput
): ObjectTeamRowValues[] {
  const teamIds = [...new Set([...(object.ownerTeamIds ?? []), ...(object.teamIds ?? [])]
    .filter((teamId): teamId is string => typeof teamId === 'string' && teamId.length > 0))]
  return teamIds.map((teamId) => ({
    landscape_id: key.landscapeId,
    version_id: key.versionId,
    org_id: orgId,
    object_id: object.id,
    team_id: teamId,
  }))
}

interface TechnologyPostingCore {
  usage_id: string
  technology_id: string
  catalog_revision: number
  used_version: string | null
  role: string | null
  snapshot: TechnologyUsageInput['snapshot']
}

/** Normalize governed usages into postings. Partial invalid CRDT values are
 * ignored by this derived projection; validation belongs to the write path. */
function technologyPostingCoreRows(
  carrier: Pick<ObjectInput, 'technologyUsages'> | Pick<GroupInput, 'technologyUsages'>
): TechnologyPostingCore[] {
  const rows: TechnologyPostingCore[] = []
  for (const [mapKey, usage] of Object.entries(carrier.technologyUsages ?? {})) {
    if (!usage || typeof usage !== 'object') continue
    const usageId = typeof usage.id === 'string' && usage.id ? usage.id : mapKey
    if (!usageId || typeof usage.technologyId !== 'string' || !usage.technologyId) continue
    if (!Number.isInteger(usage.catalogRevision) || usage.catalogRevision < 1) continue
    if (!usage.snapshot || typeof usage.snapshot.name !== 'string') continue
    rows.push({
      usage_id: usageId,
      technology_id: usage.technologyId,
      catalog_revision: usage.catalogRevision,
      used_version: typeof usage.usedVersion === 'string' ? usage.usedVersion : null,
      role: typeof usage.role === 'string' ? usage.role : null,
      snapshot: usage.snapshot,
    })
  }
  return rows
}

export function objectTechnologyRows(
  key: WorkspaceKey,
  orgId: string | null,
  object: ObjectInput
): ObjectTechnologyRowValues[] {
  return technologyPostingCoreRows(object).map((row) => ({
    landscape_id: key.landscapeId,
    version_id: key.versionId,
    org_id: orgId,
    object_id: object.id,
    ...row,
  }))
}

export function groupTechnologyRows(
  key: WorkspaceKey,
  orgId: string | null,
  group: GroupInput
): GroupTechnologyRowValues[] {
  return technologyPostingCoreRows(group).map((row) => ({
    landscape_id: key.landscapeId,
    version_id: key.versionId,
    org_id: orgId,
    group_id: group.id,
    ...row,
  }))
}

/** An object's searchable technology text — the deprecated singular `technology`
 * plus every `technologies[].name`, space-joined. Must match the client's
 * `objectTechnologyText` so search parity holds. */
export function technologyText(o: { technology?: string; technologies?: { name?: string }[] }): string {
  const parts: string[] = []
  if (o.technology) parts.push(o.technology)
  for (const t of o.technologies ?? []) if (t?.name) parts.push(t.name)
  return parts.join(' ')
}

/** Map an object to its row — denormalized columns for indexing + the verbatim
 * entity in `data` so `object(id)` reconstructs it byte-for-byte. The `technology`
 * column denormalizes both `technology` + `technologies[]` so search (through
 * `search_document` and its trigram index) covers either representation. */
export function objectToRow(key: WorkspaceKey, orgId: string | null, o: ObjectInput): ObjectRowValues {
  return {
    landscape_id: key.landscapeId,
    version_id: key.versionId,
    org_id: orgId,
    id: o.id,
    type: o.type ?? '',
    name: o.name ?? '',
    description: o.description ?? '',
    technology: technologyText(o),
    domain_id: o.domainId ?? null,
    parent_id: o.parentId ?? null,
    effective_parent_id: o.parentId ?? null,
    c4_parent_id: o.parentId ?? null,
    scope: o.scope ?? null,
    status: o.status ?? null,
    data: o,
  }
}

export function connectionToRow(key: WorkspaceKey, orgId: string | null, c: ConnectionInput): ConnectionRowValues {
  return {
    landscape_id: key.landscapeId,
    version_id: key.versionId,
    org_id: orgId,
    id: c.id,
    from_id: c.fromId,
    to_id: c.toId,
    label: c.label ?? '',
    kind: c.kind ?? null,
    data: c,
  }
}

export interface GroupRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  id: string
  name: string
  data: GroupInput
}

export function groupToRow(key: WorkspaceKey, orgId: string | null, g: GroupInput): GroupRowValues {
  return { landscape_id: key.landscapeId, version_id: key.versionId, org_id: orgId, id: g.id, name: g.name ?? '', data: g }
}

export interface DiagramRowValues {
  landscape_id: string
  version_id: string
  org_id: string | null
  id: string
  parent_object_id: string | null
  object_ids: string[]
  data: DiagramInput
}

export function diagramToRow(key: WorkspaceKey, orgId: string | null, d: DiagramInput): DiagramRowValues {
  return {
    landscape_id: key.landscapeId,
    version_id: key.versionId,
    org_id: orgId,
    id: d.id,
    parent_object_id: d.parentObjectId ?? null,
    object_ids: d.objectIds ?? [],
    data: d,
  }
}

// ── bulk writes (chunked, parameterized, idempotent) ───────────────────────────

/** Max rows per INSERT — keeps the bound-parameter count well under Postgres's
 * 65535 limit (objects = 15 cols/row → 1000 rows = 15k params). */
const CHUNK = 1000

const OBJ_COLS = [
  'landscape_id', 'version_id', 'org_id', 'id', 'type', 'name', 'description', 'technology',
  'domain_id', 'parent_id', 'effective_parent_id', 'c4_parent_id', 'scope', 'status', 'data',
] as const
const CONN_COLS = ['landscape_id', 'version_id', 'org_id', 'id', 'from_id', 'to_id', 'label', 'kind', 'data'] as const
const GROUP_COLS = ['landscape_id', 'version_id', 'org_id', 'id', 'name', 'data'] as const
const DIAGRAM_COLS = ['landscape_id', 'version_id', 'org_id', 'id', 'parent_object_id', 'object_ids', 'data'] as const

function objValues(key: WorkspaceKey, orgId: string | null, o: ObjectInput): unknown[] {
  const r = objectToRow(key, orgId, o)
  return [
    r.landscape_id, r.version_id, r.org_id, r.id, r.type, r.name, r.description, r.technology,
    r.domain_id, r.parent_id, r.effective_parent_id, r.c4_parent_id, r.scope, r.status, JSON.stringify(r.data),
  ]
}
function connValues(key: WorkspaceKey, orgId: string | null, c: ConnectionInput): unknown[] {
  const r = connectionToRow(key, orgId, c)
  return [r.landscape_id, r.version_id, r.org_id, r.id, r.from_id, r.to_id, r.label, r.kind, JSON.stringify(r.data)]
}
function groupValues(key: WorkspaceKey, orgId: string | null, g: GroupInput): unknown[] {
  const r = groupToRow(key, orgId, g)
  return [r.landscape_id, r.version_id, r.org_id, r.id, r.name, JSON.stringify(r.data)]
}
function diagramValues(key: WorkspaceKey, orgId: string | null, d: DiagramInput): unknown[] {
  const r = diagramToRow(key, orgId, d)
  return [r.landscape_id, r.version_id, r.org_id, r.id, r.parent_object_id, r.object_ids, JSON.stringify(r.data)]
}

/** Build a single multi-row upsert. The `data` (last) column is cast to jsonb;
 * conflict target is the full composite PK (landscape_id, version_id, id) so rows
 * from different workspaces never collide on upsert. */
function buildUpsert(
  table: string,
  cols: readonly string[],
  rows: unknown[][],
  conflict: 'update' | 'refuse' = 'update',
): { text: string; params: unknown[] } {
  const params: unknown[] = []
  const tuples: string[] = []
  for (const row of rows) {
    const ph = row.map((v, ci) => {
      params.push(v)
      return cols[ci] === 'data' ? `$${params.length}::jsonb` : `$${params.length}`
    })
    tuples.push(`(${ph.join(',')})`)
  }
  const updates = cols
    .filter((c) => c !== 'landscape_id' && c !== 'version_id' && c !== 'id')
    .map((c) => `${c}=EXCLUDED.${c}`)
    .join(',')
  return {
    text: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}` +
      (conflict === 'update' ? ` ON CONFLICT (landscape_id, version_id, id) DO UPDATE SET ${updates}` : ''),
    params,
  }
}

async function bulkUpsert(db: Queryable, table: string, cols: readonly string[], rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { text, params } = buildUpsert(table, cols, rows.slice(i, i + CHUNK))
    await db.query(text, params)
  }
}

/** `bulkUpsert` with NO `ON CONFLICT`: a row whose key is already there is
 * a unique violation, which fails the statement (the cold build's bulk path,
 * which has just deleted the workspace and dropped duplicate ids). Same
 * per-value parameters as the upsert, so the same column values. */
async function bulkInsert(db: Queryable, table: string, cols: readonly string[], rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { text, params } = buildUpsert(table, cols, rows.slice(i, i + CHUNK), 'refuse')
    await db.query(text, params)
  }
}

/** Maintain the two indexed parents derived from the source `parent_id`:
 *  - `effective_parent_id`, the explorer's navigation parent: Group membership
 *    takes precedence, a dangling parent becomes a root;
 *  - `c4_parent_id`, the Model Viewer's level: the parent when that row exists,
 *    else NULL (a root). Groups play no part.
 * Touched parents also refresh their children so create/delete/reparent remains
 * correct without scanning the workspace — which is what keeps a child right
 * when its parent is deleted or re-created: its `parent_id` names a touched id.
 *
 * `changed` has no default ON PURPOSE: `'objects'` (rows inserted, updated or
 * deleted) refreshes both; `'membership'` (only `ro_group_objects` moved)
 * refreshes `effective_parent_id` alone, because `c4_parent_id` does not read
 * groups. That saves the c4 arm's parent EXISTS, which runs for EVERY bounded
 * row; the effective arm's own EXISTS still runs for each bounded row that is
 * in no group (the children pulled in by `parent_id = ANY`, for instance). A
 * new call site must say which it is; a membership caller passing `'objects'`
 * is merely slower, an objects caller passing `'membership'` leaves a stale
 * level. */
async function refreshEffectiveParents(
  db: Queryable,
  key: WorkspaceKey,
  changed: 'objects' | 'membership',
  touchedIds?: string[],
): Promise<void> {
  const ids = [...new Set(touchedIds?.filter(Boolean) ?? [])]
  if (touchedIds && !ids.length) return
  const params: unknown[] = [key.landscapeId, key.versionId]
  const bounded = ids.length
    ? `AND (object.id = ANY($3::text[]) OR object.parent_id = ANY($3::text[]))`
    : ''
  if (ids.length) params.push(ids)
  const c4Parent = changed === 'objects'
    ? `,
     c4_parent_id = CASE WHEN EXISTS (
       SELECT 1 FROM ro_objects parent
       WHERE parent.landscape_id = object.landscape_id
         AND parent.version_id = object.version_id AND parent.id = object.parent_id
     ) THEN object.parent_id END`
    : ''
  await db.query(
    `UPDATE ro_objects object
     SET effective_parent_id = COALESCE(
       (SELECT min(membership.group_id) FROM ro_group_objects membership
        WHERE membership.landscape_id = object.landscape_id
          AND membership.version_id = object.version_id
          AND membership.object_id = object.id),
       CASE WHEN EXISTS (
         SELECT 1 FROM ro_objects parent
         WHERE parent.landscape_id = object.landscape_id
           AND parent.version_id = object.version_id AND parent.id = object.parent_id
       ) THEN object.parent_id END
     )${c4Parent}
     WHERE object.landscape_id = $1 AND object.version_id = $2 ${bounded}`,
    params,
  )
}

async function effectiveParentIdsForTouched(
  db: Queryable,
  key: WorkspaceKey,
  ids: readonly string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return []
  const result = await db.query<{ effective_parent_id: string | null }>(
    `SELECT DISTINCT effective_parent_id FROM ro_objects
     WHERE landscape_id = $1 AND version_id = $2
       AND (id = ANY($3::text[]) OR parent_id = ANY($3::text[]))
       AND effective_parent_id IS NOT NULL`,
    [key.landscapeId, key.versionId, uniqueIds],
  )
  return result.rows.flatMap((row) => row.effective_parent_id ? [row.effective_parent_id] : [])
}

async function diagramIdsForObjects(
  db: Queryable,
  key: WorkspaceKey,
  ids: readonly string[],
): Promise<string[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return []
  const result = await db.query<{ diagram_id: string }>(
    `SELECT DISTINCT diagram_id FROM ro_diagram_objects
     WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, uniqueIds],
  )
  return result.rows.map((row) => row.diagram_id)
}

async function rootCountForTouched(
  db: Queryable,
  key: WorkspaceKey,
  ids: readonly string[],
): Promise<number> {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (!uniqueIds.length) return 0
  const result = await db.query<{ total: string | number }>(
    `SELECT count(*) AS total FROM ro_objects
     WHERE landscape_id = $1 AND version_id = $2
       AND (id = ANY($3::text[]) OR parent_id = ANY($3::text[]))
       AND effective_parent_id IS NULL`,
    [key.landscapeId, key.versionId, uniqueIds],
  )
  return Number(result.rows[0]?.total ?? 0)
}

/**
 * `ANALYZE ro_objects`, BOUNDED (`analyzeWithinCeiling`, `derivedStats.ts`:
 * the measured lock behaviour and why a wait inside the mutex must be
 * finite). A skipped ANALYZE is correct, just slow: the reparent runs the
 * `est=1` plan this exists to avoid.
 *
 * Unexplored alternative: a transaction-scoped planner GUC would take no lock
 * at all, but a blunt `enable_nestloop` would apply to every query in the
 * projection; it has not been measured.
 */
async function analyzeObjectsForReparent(tx: Queryable, key: WorkspaceKey): Promise<void> {
  await analyzeWithinCeiling(tx, key, ['ro_objects'])
}

/**
 * The ids an upsert is about to write, split by whether a row is already
 * there (G4-16f C6a). Replaces `countExistingIds` on the two maintained
 * tables — one statement, the same `= ANY` lookup — so the count the
 * workspace counter is adjusted by and the ids the digest recorder is given
 * come from ONE read.
 *
 * `existingCount` keeps `countExistingIds`'s exact semantics (unique,
 * non-empty ids), because `adjustWorkspaceCount` has always been fed that
 * number. `entered` is over EVERY distinct id, the empty string included: a
 * row with id `''` is a row, and `digestSql` hashes it.
 *
 * Exact against the writers that hold the projection mutex
 * (`withReadModelProjectionTransaction`: the ordinary runner and the static
 * publish). Writers that do NOT hold it — the performance seed, the
 * `upgrade-performance-phase14` script, the dev load gates — could insert the
 * same id between this SELECT and the upsert; `entered` would then
 * over-report it and the stamped digest MISMATCHES the table, which refuses
 * an adopt — the safe direction.
 */
async function splitUpsertIds(
  tx: Queryable,
  key: WorkspaceKey,
  table: 'ro_objects' | 'ro_connections',
  inputIds: readonly string[],
): Promise<{ existingCount: number; entered: string[] }> {
  const ids = [...new Set(inputIds.map((id) => (typeof id === 'string' ? id : String(id))))]
  if (!ids.length) return { existingCount: 0, entered: [] }
  // Aliased: `staticDeltaProjector.unappliedPublish.integration.test.ts`
  // counts the static seed's own `SELECT id FROM ro_objects WHERE …` by its
  // text, and this lookup must not read as one of them.
  const { rows } = await tx.query<{ id: string }>(
    `SELECT existing.id FROM ${table} existing
     WHERE existing.landscape_id = $1 AND existing.version_id = $2 AND existing.id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, ids],
  )
  const existing = new Set(rows.map((row) => row.id))
  return {
    existingCount: [...existing].filter(Boolean).length,
    entered: ids.filter((id) => !existing.has(id)),
  }
}

export interface UpsertObjectsOptions {
  /**
   * `ANALYZE ro_objects` between the bulk insert and the reparent below.
   * COLD BUILD ONLY.
   *
   * `refreshEffectiveParents` correlates `ro_objects` with itself to resolve a
   * parent chain. On a workspace whose rows have just been inserted for the
   * first time the planner has no statistics for the new `landscape_id`, so it
   * estimates `rows=1` against 12 000 actual, prices the parent-existence
   * SubPlan as free, and runs it once per row instead of hashing it once.
   * Measured at 12 000 objects: ~21 s → ~1.6 s for this UPDATE (~26 s → ~7 s
   * for the whole transaction, ~140x fewer shared buffers). The ANALYZE itself
   * costs ~180 ms.
   *
   * WHY A PARAMETER, and not just always. On the per-shard delta path the
   * statistics are already fine and the ANALYZE is pure overhead (~2.5x slower
   * for a 20-object shard, on the hottest path in the projector). A size
   * threshold would be a guess about shard sizes; a parameter cannot be wrong.
   *
   * WHY HERE, and not at the other call site. `refreshEffectiveParents` runs
   * TWICE in a cold build, and the expensive one is this one, not the one at
   * the end of `replaceGroupMembership`. There, `ro_group_objects` is already
   * populated so `COALESCE`'s first arm answers for every touched row and the
   * self-join is never executed. Here it is empty, because the cold build
   * DELETEd it, so every row falls through. Placing the ANALYZE around the
   * other call site buys nothing measurable.
   */
  analyzeBeforeReparent?: boolean
  /** Phase wall times (`rowWriteTimings.ts`); observability only. */
  timings?: RowWriteTimings
}

export async function upsertObjects(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[],
  options: UpsertObjectsOptions = {},
): Promise<void> {
  if (!objects.length) return
  const timings = options.timings
  await withPoolTransaction(db, async (tx) => {
    const ids = objects.map((object) => object.id)
    const { split, oldParentIds, oldRootCount, diagramIds } = await timedPhase(timings, 'objectsTouchedReadsMs', async () => ({
      split: await splitUpsertIds(tx, key, 'ro_objects', ids),
      oldParentIds: await effectiveParentIdsForTouched(tx, key, ids),
      oldRootCount: await rootCountForTouched(tx, key, ids),
      diagramIds: await diagramIdsForObjects(tx, key, ids),
    }))
    const existing = split.existingCount
    await timedPhase(timings, 'objectsInsertMs', () => bulkUpsert(tx, 'ro_objects', OBJ_COLS, objects.map((o) => objValues(key, orgId, o))))
    recordIdSetDelta(tx, 'object', split.entered, [])
    if (options.analyzeBeforeReparent) await timedPhase(timings, 'objectsAnalyzeMs', () => analyzeObjectsForReparent(tx, key))
    await timedPhase(timings, 'objectsReparentMs', () => refreshEffectiveParents(tx, key, 'objects', ids))
    await timedPhase(timings, 'objectPostingsMs', async () => {
      await replaceObjectTechnologyPostingsInTransaction(tx, key, orgId, objects)
      await replaceObjectTagPostingsInTransaction(tx, key, orgId, objects)
      await replaceObjectTeamPostingsInTransaction(tx, key, orgId, objects)
    })
    const { newParentIds, newRootCount } = await timedPhase(timings, 'objectsTouchedReadsMs', async () => ({
      newParentIds: await effectiveParentIdsForTouched(tx, key, ids),
      newRootCount: await rootCountForTouched(tx, key, ids),
    }))
    await timedPhase(timings, 'objectsIncrementalStatsMs', async () => {
      await refreshObjectChildStats(tx, key, [...ids, ...oldParentIds, ...newParentIds])
      await adjustRootObjectCount(tx, key, orgId, newRootCount - oldRootCount)
      await refreshConnectionStatsForEndpoints(tx, key, ids)
      await refreshDiagramSummaries(tx, key, diagramIds)
      await adjustWorkspaceCount(tx, key, orgId, 'object_count', objects.length - existing)
    })
  })
}

async function replaceObjectTagPostingsInTransaction(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[]
): Promise<void> {
  const objectIds = objects.map((object) => object.id)
  const rows = objects.flatMap((object) => objectTagRows(key, orgId, object))
  await db.query(
    `DELETE FROM ro_object_tags
     WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, objectIds]
  )
  if (!rows.length) return
  await db.query(OBJECT_TAG_INSERT_SQL, [JSON.stringify(rows)])
}

// The posting INSERTs, shared by the per-shard replace and the cold build's
// bulk path so both convert a row to its columns the same way (one JSON
// recordset per statement; each SQL takes the rows as `$1`).
const OBJECT_TAG_INSERT_SQL = `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         landscape_id text, version_id text, org_id text, object_id text,
         tag_id text, ordinal integer
       )
     )
     INSERT INTO ro_object_tags (
       landscape_id, version_id, org_id, object_id, tag_id, ordinal
     )
     SELECT landscape_id, version_id, org_id, object_id, tag_id, ordinal FROM input`
const OBJECT_TEAM_INSERT_SQL = `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         landscape_id text, version_id text, org_id text, object_id text, team_id text
       )
     )
     INSERT INTO ro_object_teams (landscape_id, version_id, org_id, object_id, team_id)
     SELECT landscape_id, version_id, org_id, object_id, team_id FROM input`
const OBJECT_TECHNOLOGY_INSERT_SQL = `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         landscape_id text, version_id text, org_id text, object_id text,
         usage_id text, technology_id text, catalog_revision integer,
         used_version text, role text, snapshot jsonb
       )
     )
     INSERT INTO ro_object_technologies (
       landscape_id, version_id, org_id, object_id, usage_id, technology_id,
       catalog_revision, used_version, role, snapshot
     )
     SELECT landscape_id, version_id, org_id, object_id, usage_id, technology_id,
            catalog_revision, used_version, role, snapshot
     FROM input`
const GROUP_TECHNOLOGY_INSERT_SQL = `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         landscape_id text, version_id text, org_id text, group_id text,
         usage_id text, technology_id text, catalog_revision integer,
         used_version text, role text, snapshot jsonb
       )
     )
     INSERT INTO ro_group_technologies (
       landscape_id, version_id, org_id, group_id, usage_id, technology_id,
       catalog_revision, used_version, role, snapshot
     )
     SELECT landscape_id, version_id, org_id, group_id, usage_id, technology_id,
            catalog_revision, used_version, role, snapshot
     FROM input`
const GROUP_TAG_INSERT_SQL = `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         landscape_id text, version_id text, org_id text, group_id text,
         tag_id text, ordinal integer
       )
     )
     INSERT INTO ro_group_tags (
       landscape_id, version_id, org_id, group_id, tag_id, ordinal
     )
     SELECT landscape_id, version_id, org_id, group_id, tag_id, ordinal FROM input`

async function replaceObjectTeamPostingsInTransaction(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[]
): Promise<void> {
  const objectIds = objects.map((object) => object.id)
  const rows = objects.flatMap((object) => objectTeamRows(key, orgId, object))
  await db.query(
    `DELETE FROM ro_object_teams
     WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, objectIds]
  )
  if (!rows.length) return
  await db.query(OBJECT_TEAM_INSERT_SQL, [JSON.stringify(rows)])
}

/** Replace all postings for the touched objects in one transaction. PostgreSQL
 * keeps stale-usage removal + insertion atomic to concurrent readers, while JSON
 * recordset input avoids the parameter limit on large shards. */
export async function replaceObjectTechnologyPostings(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[]
): Promise<void> {
  if (!objects.length) return
  await withPoolTransaction(db, (tx) => replaceObjectTechnologyPostingsInTransaction(tx, key, orgId, objects))
}

async function replaceObjectTechnologyPostingsInTransaction(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[]
): Promise<void> {
  const objectIds = objects.map((object) => object.id)
  const rows = objects.flatMap((object) => objectTechnologyRows(key, orgId, object))
  await db.query(
    `DELETE FROM ro_object_technologies
     WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, objectIds]
  )
  if (!rows.length) return
  await db.query(OBJECT_TECHNOLOGY_INSERT_SQL, [JSON.stringify(rows)])
}

async function replaceGroupTechnologyPostingsInTransaction(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  groups: GroupInput[]
): Promise<void> {
  const groupIds = groups.map((group) => group.id)
  const rows = groups.flatMap((group) => groupTechnologyRows(key, orgId, group))
  await db.query(
    `DELETE FROM ro_group_technologies
     WHERE landscape_id = $1 AND version_id = $2 AND group_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, groupIds]
  )
  if (!rows.length) return
  await db.query(GROUP_TECHNOLOGY_INSERT_SQL, [JSON.stringify(rows)])
}

async function replaceGroupTagPostingsInTransaction(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  groups: GroupInput[]
): Promise<void> {
  const groupIds = groups.map((group) => group.id)
  const rows = groups.flatMap((group) => groupTagRows(key, orgId, group))
  await db.query(
    `DELETE FROM ro_group_tags
     WHERE landscape_id = $1 AND version_id = $2 AND group_id = ANY($3::text[])`,
    [key.landscapeId, key.versionId, groupIds]
  )
  if (!rows.length) return
  await db.query(GROUP_TAG_INSERT_SQL, [JSON.stringify(rows)])
}

export async function upsertConnections(db: Queryable, key: WorkspaceKey, orgId: string | null, connections: ConnectionInput[]): Promise<void> {
  if (!connections.length) return
  await withPoolTransaction(db, async (tx) => {
    const ids = connections.map((connection) => connection.id)
    const split = await splitUpsertIds(tx, key, 'ro_connections', ids)
    const existing = split.existingCount
    await bulkUpsert(tx, 'ro_connections', CONN_COLS, connections.map((c) => connValues(key, orgId, c)))
    recordIdSetDelta(tx, 'connection', split.entered, [])
    await refreshConnectionStats(tx, key, ids)
    await adjustWorkspaceCount(tx, key, orgId, 'connection_count', connections.length - existing)
  })
}

export async function deleteObjects(db: Queryable, key: WorkspaceKey, ids: string[]): Promise<void> {
  if (ids.length) {
    await withPoolTransaction(db, async (tx) => {
      const existing = await countExistingIds(tx, key, 'ro_objects', 'id', ids)
      const oldParentIds = await effectiveParentIdsForTouched(tx, key, ids)
      const oldRootCount = await rootCountForTouched(tx, key, ids)
      const diagramIds = await diagramIdsForObjects(tx, key, ids)
      await tx.query(
        `DELETE FROM ro_object_technologies
         WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `DELETE FROM ro_object_tags
         WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `DELETE FROM ro_object_teams
         WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `DELETE FROM ro_diagram_objects
         WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `DELETE FROM ro_group_objects
         WHERE landscape_id = $1 AND version_id = $2 AND object_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `UPDATE ro_diagrams diagram
         SET object_ids = ARRAY(
               SELECT value FROM unnest(diagram.object_ids) value
               WHERE NOT (value = ANY($3::text[]))
             ),
             data = jsonb_set(
               diagram.data,
               '{objectIds}',
               to_jsonb(ARRAY(
                 SELECT value FROM unnest(diagram.object_ids) value
                 WHERE NOT (value = ANY($3::text[]))
               )),
               true
             )
         WHERE landscape_id = $1 AND version_id = $2
           AND object_ids && $3::text[]`,
        [key.landscapeId, key.versionId, ids]
      )
      // RETURNING: the ids that actually LEFT the table, whatever `ids` held
      // (duplicates, ids with no row) — the digest recorder's input (C6a).
      const removed = await tx.query<{ id: string }>(
        `DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[]) RETURNING id`,
        [key.landscapeId, key.versionId, ids]
      )
      recordIdSetDelta(tx, 'object', [], removed.rows.map((row) => row.id))
      await refreshEffectiveParents(tx, key, 'objects', ids)
      const newParentIds = await effectiveParentIdsForTouched(tx, key, ids)
      const newRootCount = await rootCountForTouched(tx, key, ids)
      await refreshObjectChildStats(tx, key, [...ids, ...oldParentIds, ...newParentIds])
      await adjustRootObjectCount(tx, key, null, newRootCount - oldRootCount)
      await refreshConnectionStatsForEndpoints(tx, key, ids)
      await refreshDiagramSummaries(tx, key, diagramIds)
      await adjustWorkspaceCount(tx, key, null, 'object_count', -existing)
    })
  }
}

export async function deleteConnections(db: Queryable, key: WorkspaceKey, ids: string[]): Promise<void> {
  if (ids.length) {
    await withPoolTransaction(db, async (tx) => {
      const existing = await countExistingIds(tx, key, 'ro_connections', 'id', ids)
      const affectedDiagrams = await tx.query<{ diagram_id: string }>(
        `SELECT DISTINCT diagram_id FROM ro_diagram_connections
         WHERE landscape_id = $1 AND version_id = $2 AND connection_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids],
      )
      await tx.query(
        `DELETE FROM ro_diagram_connections
         WHERE landscape_id = $1 AND version_id = $2 AND connection_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `DELETE FROM ro_connection_flows
         WHERE landscape_id = $1 AND version_id = $2 AND connection_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `UPDATE ro_diagrams diagram
         SET data = jsonb_set(
           diagram.data,
           '{connectionIds}',
           COALESCE((
             SELECT jsonb_agg(value)
             FROM jsonb_array_elements_text(COALESCE(diagram.data->'connectionIds', '[]'::jsonb)) value
             WHERE NOT (value = ANY($3::text[]))
           ), '[]'::jsonb),
           true
         )
         WHERE landscape_id = $1 AND version_id = $2
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(COALESCE(diagram.data->'connectionIds', '[]'::jsonb)) value
             WHERE value = ANY($3::text[])
           )`,
        [key.landscapeId, key.versionId, ids]
      )
      const removed = await tx.query<{ id: string }>(
        `DELETE FROM ro_connections
         WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])
         RETURNING id`,
        [key.landscapeId, key.versionId, ids]
      )
      recordIdSetDelta(tx, 'connection', [], removed.rows.map((row) => row.id))
      await refreshConnectionStats(tx, key, ids)
      await refreshDiagramSummaries(tx, key, affectedDiagrams.rows.map((row) => row.diagram_id))
      await adjustWorkspaceCount(tx, key, null, 'connection_count', -existing)
    })
  }
}

export async function upsertGroups(db: Queryable, key: WorkspaceKey, orgId: string | null, groups: GroupInput[]): Promise<void> {
  if (!groups.length) return
  await withPoolTransaction(db, async (tx) => {
    const ids = groups.map((group) => group.id)
    const existing = await countExistingIds(tx, key, 'ro_groups', 'id', ids)
    await bulkUpsert(tx, 'ro_groups', GROUP_COLS, groups.map((g) => groupValues(key, orgId, g)))
    await replaceGroupTechnologyPostingsInTransaction(tx, key, orgId, groups)
    await replaceGroupTagPostingsInTransaction(tx, key, orgId, groups)
    await refreshConnectionStatsForEndpoints(tx, key, ids)
    await adjustWorkspaceCount(tx, key, orgId, 'group_count', groups.length - existing)
  })
}

export async function deleteGroups(db: Queryable, key: WorkspaceKey, ids: string[]): Promise<void> {
  if (ids.length) {
    await withPoolTransaction(db, async (tx) => {
      const existing = await countExistingIds(tx, key, 'ro_groups', 'id', ids)
      const members = await tx.query<{ object_id: string }>(
        `SELECT object_id FROM ro_group_objects
         WHERE landscape_id = $1 AND version_id = $2 AND group_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids],
      )
      const objectIds = members.rows.map((row) => row.object_id)
      const oldRootCount = await rootCountForTouched(tx, key, objectIds)
      await tx.query(
        `DELETE FROM ro_group_technologies
         WHERE landscape_id = $1 AND version_id = $2 AND group_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `DELETE FROM ro_group_tags
         WHERE landscape_id = $1 AND version_id = $2 AND group_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `DELETE FROM ro_group_objects
         WHERE landscape_id = $1 AND version_id = $2 AND group_id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await tx.query(
        `DELETE FROM ro_groups WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
      await refreshEffectiveParents(tx, key, 'membership', objectIds)
      const newParentIds = await effectiveParentIdsForTouched(tx, key, objectIds)
      const newRootCount = await rootCountForTouched(tx, key, objectIds)
      await refreshObjectChildStats(tx, key, [...ids, ...newParentIds])
      await adjustRootObjectCount(tx, key, null, newRootCount - oldRootCount)
      await refreshConnectionStatsForEndpoints(tx, key, ids)
      await adjustWorkspaceCount(tx, key, null, 'group_count', -existing)
    })
  }
}

/** Sync the FULL group set (groups aren't sharded — they're inline on ModelMeta):
 * upsert all + delete any row (within this workspace) whose id is no longer
 * present. Idempotent. */
export async function syncGroups(db: Queryable, key: WorkspaceKey, orgId: string | null, groups: GroupInput[]): Promise<void> {
  await withPoolTransaction(db, async (tx) => {
    const previousMembership = await tx.query<{ object_id: string }>(
      `SELECT DISTINCT object_id FROM ro_group_objects
       WHERE landscape_id = $1 AND version_id = $2`,
      [key.landscapeId, key.versionId],
    )
    const nextObjectIds = groups.flatMap((group) => group.objectIds ?? [])
    const affectedObjectIds = [...new Set([
      ...previousMembership.rows.map((row) => row.object_id), ...nextObjectIds,
    ])]
    const oldRootCount = await rootCountForTouched(tx, key, affectedObjectIds)
    await upsertGroups(tx, key, orgId, groups)
    const ids = groups.map((group) => group.id)
    await tx.query(
      `DELETE FROM ro_group_technologies
       WHERE landscape_id = $1 AND version_id = $2 AND group_id <> ALL($3::text[])`,
      [key.landscapeId, key.versionId, ids]
    )
    await tx.query(
      `DELETE FROM ro_group_tags
       WHERE landscape_id = $1 AND version_id = $2 AND group_id <> ALL($3::text[])`,
      [key.landscapeId, key.versionId, ids]
    )
    const deleted = await tx.query<{ id: string }>(
      `DELETE FROM ro_groups WHERE landscape_id = $1 AND version_id = $2 AND id <> ALL($3::text[])
       RETURNING id`,
      [key.landscapeId, key.versionId, ids]
    )
    await replaceGroupMembership(tx, key, orgId, groups)
    const deletedIds = deleted.rows.map((row) => row.id)
    const newParentIds = await effectiveParentIdsForTouched(tx, key, affectedObjectIds)
    const newRootCount = await rootCountForTouched(tx, key, affectedObjectIds)
    await refreshObjectChildStats(tx, key, [...ids, ...deletedIds, ...newParentIds])
    await adjustRootObjectCount(tx, key, orgId, newRootCount - oldRootCount)
    await refreshConnectionStatsForEndpoints(tx, key, deletedIds)
    await adjustWorkspaceCount(tx, key, orgId, 'group_count', -(deleted.rowCount ?? 0))
  })
}

/**
 * Delete a diagram and everything the read model hangs off it, by ID.
 *
 * `syncDiagrams` deletes by ABSENCE from a complete registry, which a summary
 * workspace never has: its registry lives in frozen baseline shards nobody
 * reprojects. The static delta projector calls this from `projectMeta` instead,
 * driven by `ModelMeta.deletedDiagramIds`.
 *
 * SIX tables, because `readModel/schema.ts` declares NO `ON DELETE CASCADE`
 * anywhere. Forgetting the membership rows would be a quiet defect:
 * Model Objects and Dependencies read `ro_diagram_objects`
 * (`objectExplorer.ts`, `queries.ts`), so the dead diagram would keep showing
 * up under "linked diagrams" long after its card disappeared. `refreshDiagramSummaries`
 * purges `ro_diagram_summaries` through its `NOT EXISTS` clause, and
 * `refreshConnectionStats` repairs the connections that just lost a membership
 * or a flow. `read_model_diagram_render_generations` is deliberately NOT
 * deleted — the caller BUMPS it, so a cached render of the deleted diagram is
 * invalidated rather than left addressable.
 *
 * Returns how many `ro_diagrams` rows actually went, so the caller can adjust
 * `diagram_count` by a real delta instead of by the size of its input.
 */
export async function deleteDiagrams(db: Queryable, key: WorkspaceKey, ids: readonly string[]): Promise<number> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return 0
  let removed = 0
  await withPoolTransaction(db, async (tx) => {
    const params = [key.landscapeId, key.versionId, unique]
    // Captured BEFORE the deletes: these connections lose a membership or a
    // flow and their aggregate counters have to be recomputed afterwards.
    const affectedConnections = await tx.query<{ connection_id: string }>(
      `SELECT connection_id FROM ro_diagram_connections
        WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = ANY($3::text[])
       UNION
       SELECT connection_id FROM ro_connection_flows
        WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = ANY($3::text[])`,
      params,
    )
    await tx.query(
      `DELETE FROM ro_diagram_objects WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = ANY($3::text[])`,
      params,
    )
    await tx.query(
      `DELETE FROM ro_diagram_groups WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = ANY($3::text[])`,
      params,
    )
    await tx.query(
      `DELETE FROM ro_diagram_connections WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = ANY($3::text[])`,
      params,
    )
    await tx.query(
      `DELETE FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = ANY($3::text[])`,
      params,
    )
    for (const table of DIAGRAM_FLOW_INDEX_TABLES) {
      await tx.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = ANY($3::text[])`, params)
    }
    const deleted = await tx.query(
      `DELETE FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
      params,
    )
    removed = deleted.rowCount ?? 0
    // Bounded to these ids: the summaries pass drops the rows whose diagram no
    // longer exists, and re-inserting nothing for them is the whole point.
    await refreshDiagramSummaries(tx, key, unique)
    await refreshConnectionStats(tx, key, affectedConnections.rows.map((row) => row.connection_id))
  })
  return removed
}

export async function upsertDiagrams(db: Queryable, key: WorkspaceKey, orgId: string | null, diagrams: DiagramInput[]): Promise<void> {
  if (!diagrams.length) return
  await withPoolTransaction(db, async (tx) => {
    const ids = diagrams.map((diagram) => diagram.id)
    const existing = await countExistingIds(tx, key, 'ro_diagrams', 'id', ids)
    await bulkUpsert(tx, 'ro_diagrams', DIAGRAM_COLS, diagrams.map((d) => diagramValues(key, orgId, d)))
    await refreshDiagramSummaries(tx, key, ids)
    await adjustWorkspaceCount(tx, key, orgId, 'diagram_count', diagrams.length - existing)
  })
}

/** Sync the FULL diagram registry (DiagramMeta stubs): upsert all + delete missing
 * (within this workspace). Idempotent; the registry is small relative to the model. */
export async function syncDiagrams(db: Queryable, key: WorkspaceKey, orgId: string | null, diagrams: DiagramInput[]): Promise<void> {
  await withPoolTransaction(db, async (tx) => {
    await upsertDiagrams(tx, key, orgId, diagrams)
    const deleted = await tx.query(
      `DELETE FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2 AND id <> ALL($3::text[])
       RETURNING id`,
      [key.landscapeId, key.versionId, diagrams.map((d) => d.id)]
    )
    await tx.query(
      `DELETE FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2 AND diagram_id <> ALL($3::text[])`,
      [key.landscapeId, key.versionId, diagrams.map((d) => d.id)]
    )
    for (const table of DIAGRAM_FLOW_INDEX_TABLES) {
      await tx.query(
        `DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2 AND diagram_id <> ALL($3::text[])`,
        [key.landscapeId, key.versionId, diagrams.map((d) => d.id)],
      )
    }
    await replaceDiagramMembership(tx, key, orgId, diagrams)
    await refreshDiagramSummaries(tx, key)
    await refreshConnectionStats(tx, key)
    await adjustWorkspaceCount(tx, key, orgId, 'diagram_count', -(deleted.rowCount ?? 0))
  })
}

async function replaceGroupMembership(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  groups: GroupInput[],
): Promise<void> {
  const previous = await db.query<{ object_id: string }>(
    `SELECT DISTINCT object_id FROM ro_group_objects
     WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  await db.query(`DELETE FROM ro_group_objects WHERE landscape_id = $1 AND version_id = $2`, [key.landscapeId, key.versionId])
  const rows = groups.flatMap((group) => [...new Set(group.objectIds ?? [])].map((objectId) => [group.id, objectId] as const))
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const params: unknown[] = []
    const values = rows.slice(offset, offset + CHUNK).map(([groupId, objectId]) => {
      const start = params.length
      params.push(key.landscapeId, key.versionId, orgId, groupId, objectId)
      return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5})`
    })
    await db.query(
      `INSERT INTO ro_group_objects (landscape_id, version_id, org_id, group_id, object_id)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
      params,
    )
  }
  await refreshEffectiveParents(db, key, 'membership', [
    ...previous.rows.map((row) => row.object_id),
    ...rows.map(([, objectId]) => objectId),
  ])
}

async function replaceDiagramMembership(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  diagrams: DiagramInput[],
): Promise<void> {
  await db.query(`DELETE FROM ro_diagram_objects WHERE landscape_id = $1 AND version_id = $2`, [key.landscapeId, key.versionId])
  await db.query(`DELETE FROM ro_diagram_groups WHERE landscape_id = $1 AND version_id = $2`, [key.landscapeId, key.versionId])
  await db.query(`DELETE FROM ro_diagram_connections WHERE landscape_id = $1 AND version_id = $2`, [key.landscapeId, key.versionId])
  const rows = diagrams.flatMap((diagram) => [...new Set(diagram.objectIds ?? [])].map((objectId) => [diagram.id, objectId] as const))
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    const params: unknown[] = []
    const values = rows.slice(offset, offset + CHUNK).map(([diagramId, objectId]) => {
      const start = params.length
      params.push(key.landscapeId, key.versionId, orgId, diagramId, objectId)
      return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5})`
    })
    await db.query(
      `INSERT INTO ro_diagram_objects (landscape_id, version_id, org_id, diagram_id, object_id)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
      params,
    )
  }
  const groupRows = diagrams.flatMap((diagram) => [...new Set(diagram.groupIds ?? [])].map((groupId) => [diagram.id, groupId] as const))
  for (let offset = 0; offset < groupRows.length; offset += CHUNK) {
    const params: unknown[] = []
    const values = groupRows.slice(offset, offset + CHUNK).map(([diagramId, groupId]) => {
      const start = params.length
      params.push(key.landscapeId, key.versionId, orgId, diagramId, groupId)
      return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5})`
    })
    await db.query(
      `INSERT INTO ro_diagram_groups (landscape_id, version_id, org_id, diagram_id, group_id)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
      params,
    )
  }
  const connectionRows = diagrams.flatMap((diagram) => [...new Set(diagram.connectionIds ?? [])].map((connectionId) => [diagram.id, connectionId] as const))
  for (let offset = 0; offset < connectionRows.length; offset += CHUNK) {
    const params: unknown[] = []
    const values = connectionRows.slice(offset, offset + CHUNK).map(([diagramId, connectionId]) => {
      const start = params.length
      params.push(key.landscapeId, key.versionId, orgId, diagramId, connectionId)
      return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5})`
    })
    await db.query(
      `INSERT INTO ro_diagram_connections (landscape_id, version_id, org_id, diagram_id, connection_id)
       VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
      params,
    )
  }
}

/** Every table `replaceDiagramFlowIndex` writes, keyed by diagram. A path that
 * drops a diagram's (or a workspace's) ro_connection_flows drops these too —
 * the coverage witness above all: left behind, it would certify flows that no
 * longer have rows. */
export const DIAGRAM_FLOW_INDEX_TABLES = ['ro_flows', 'ro_flow_objects', 'ro_diagram_flow_index'] as const

/** The fields of a flow the flow index reads — structural, so a DiagramDoc's
 * FlowInput and the performance seed's flows both fit. */
export interface FlowIndexInput {
  id: string
  name?: unknown
  steps?: unknown
}

/** The objects one flow's steps touch: a process step's object, a message
 * step's sender and receiver. Mirrors the client's `flowsReferencingObject`. */
export function flowObjectIds(flow: FlowIndexInput): string[] {
  const ids = new Set<string>()
  // A malformed document must not throw here: this runs inside the flow
  // projection transaction, where a throw degrades the whole workspace.
  for (const raw of Array.isArray(flow.steps) ? (flow.steps as unknown[]) : []) {
    if (!raw || typeof raw !== 'object') continue
    const step = raw as Record<string, unknown>
    const candidates = step.type === 'process'
      ? [step.objectId]
      : step.type === 'message' ? [step.fromObjectId, step.toObjectId] : []
    for (const id of candidates) if (typeof id === 'string' && id) ids.add(id)
  }
  return [...ids]
}

/** Replace ONE diagram's flow names + object postings and record that the
 * diagram is covered (`ro_diagram_flow_index`). Callers pass the diagram's
 * COMPLETE flow set, read from a DiagramDoc that carries a flows map — a
 * document without one must not reach here, or the witness would certify an
 * empty set it never saw. Runs inside the caller's transaction. */
export async function replaceDiagramFlowIndex(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  diagramId: string,
  flows: readonly FlowInput[],
): Promise<void> {
  await dropDiagramFlowIndex(db, key, diagramId)
  await insertDiagramFlowIndex(db, key, orgId, [{ diagramId, flows }])
}

/** Forget one diagram's flow index, coverage witness included: its flows are
 * then reported as unknown. Runs inside the caller's transaction. */
export async function dropDiagramFlowIndex(db: Queryable, key: WorkspaceKey, diagramId: string): Promise<void> {
  for (const table of DIAGRAM_FLOW_INDEX_TABLES) {
    await db.query(
      `DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
      [key.landscapeId, key.versionId, diagramId],
    )
  }
}

/** The derivation `ro_diagram_flow_index.index_version` certifies. Bump it when
 * `flowObjectIds` (or what a flow row holds) changes meaning: every older
 * witness then stops counting as coverage, so its diagrams read as incomplete
 * until re-projected instead of certifying the old semantics. */
export const FLOW_INDEX_VERSION = 1

/** Insert flow names, object postings and coverage witnesses for diagrams
 * whose previous rows are already gone (a per-diagram replace, or the seed of
 * an empty workspace). Three statements whatever the diagram count. */
export async function insertDiagramFlowIndex(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  entries: ReadonlyArray<{ diagramId: string; flows: readonly FlowIndexInput[] }>,
): Promise<void> {
  if (!entries.length) return
  const names: Array<{ diagramId: string; flowId: string; name: string }> = []
  const postings: Array<{ diagramId: string; flowId: string; objectId: string }> = []
  for (const { diagramId, flows } of entries) {
    for (const flow of flows) {
      if (typeof flow.id !== 'string' || !flow.id) continue
      names.push({ diagramId, flowId: flow.id, name: typeof flow.name === 'string' ? flow.name : '' })
      for (const objectId of flowObjectIds(flow)) postings.push({ diagramId, flowId: flow.id, objectId })
    }
  }
  // text[] + unnest, NOT jsonb: a user-typed flow name holding U+0000 or a lone
  // surrogate is rejected by the jsonb parser, which would fail this whole
  // flow transaction (ro_connection_flows included) on every retry. Text
  // parameters go through pg's UTF-8 encoding; NUL is stripped (Postgres text
  // cannot hold it).
  const clean = (value: string) => value.split(String.fromCharCode(0)).join('')
  if (names.length) {
    await db.query(
      `INSERT INTO ro_flows (landscape_id, version_id, org_id, diagram_id, flow_id, name)
       SELECT $1, $2, $3, item.diagram_id, item.flow_id, item.name
       FROM unnest($4::text[], $5::text[], $6::text[]) AS item(diagram_id, flow_id, name)
       ON CONFLICT DO NOTHING`,
      [key.landscapeId, key.versionId, orgId,
        names.map((row) => clean(row.diagramId)), names.map((row) => clean(row.flowId)), names.map((row) => clean(row.name))],
    )
  }
  if (postings.length) {
    await db.query(
      `INSERT INTO ro_flow_objects (landscape_id, version_id, org_id, diagram_id, flow_id, object_id)
       SELECT $1, $2, $3, item.diagram_id, item.flow_id, item.object_id
       FROM unnest($4::text[], $5::text[], $6::text[]) AS item(diagram_id, flow_id, object_id)
       ON CONFLICT DO NOTHING`,
      [key.landscapeId, key.versionId, orgId,
        postings.map((row) => clean(row.diagramId)), postings.map((row) => clean(row.flowId)), postings.map((row) => clean(row.objectId))],
    )
  }
  await db.query(
    `INSERT INTO ro_diagram_flow_index (landscape_id, version_id, org_id, diagram_id, index_version)
     SELECT $2, $3, $4, id, $5 FROM unnest($1::text[]) AS id
     ON CONFLICT (landscape_id, version_id, diagram_id) DO UPDATE SET index_version = EXCLUDED.index_version`,
    [[...new Set(entries.map((entry) => clean(entry.diagramId)))], key.landscapeId, key.versionId, orgId, FLOW_INDEX_VERSION],
  )
}

/** Project the flow→connection postings from one DiagramDoc. Diagram documents
 * are independently synced, so replacement is scoped to exactly one diagram.
 *
 * `certify` — no default, on purpose: true only when `flows` was read from a
 * DiagramDoc whose `flows` IS a map. Otherwise (e.g. a `field-not-a-map`
 * defect, read as `{}`) the diagram's object-flow index and coverage witness
 * are dropped instead, so its flows read as unknown rather than as none. */
export async function syncConnectionFlows(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  diagramId: string,
  flows: FlowInput[],
  certify: boolean,
): Promise<void> {
  await withPoolTransaction(db, async (tx) => {
    const old = await tx.query<{ connection_id: string }>(
      `SELECT DISTINCT connection_id FROM ro_connection_flows
       WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
      [key.landscapeId, key.versionId, diagramId],
    )
    await tx.query(
      `DELETE FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2 AND diagram_id = $3`,
      [key.landscapeId, key.versionId, diagramId],
    )
    const rows = flows.flatMap((flow) => [...new Set((flow.steps ?? [])
      .map((step) => step.connectionId)
      .filter((id): id is string => Boolean(id)))]
      .map((connectionId) => [flow.id, connectionId] as const))
    for (let offset = 0; offset < rows.length; offset += CHUNK) {
      const params: unknown[] = []
      const values = rows.slice(offset, offset + CHUNK).map(([flowId, connectionId]) => {
        const start = params.length
        params.push(key.landscapeId, key.versionId, orgId, diagramId, flowId, connectionId)
        return `($${start + 1},$${start + 2},$${start + 3},$${start + 4},$${start + 5},$${start + 6})`
      })
      await tx.query(
        `INSERT INTO ro_connection_flows (landscape_id, version_id, org_id, diagram_id, flow_id, connection_id)
         VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
        params,
      )
    }
    if (certify) await replaceDiagramFlowIndex(tx, key, orgId, diagramId, flows)
    else await dropDiagramFlowIndex(tx, key, diagramId)
    await refreshConnectionStats(tx, key, [
      ...old.rows.map((row) => row.connection_id),
      ...rows.map(([, connectionId]) => connectionId),
    ])
  })
}

// ── shard-incremental + cold build ─────────────────────────────────────────────

/** Apply one object shard's delta: upsert its current objects, delete the ids that
 * were in the shard before but are gone now (within this workspace). `oldIds` = the
 * shard's previous member ids (an object never moves shards, so this is local +
 * replay-safe).
 *
 * A duplicate id WITHIN the shard (two map keys, one inner id) is dropped
 * first, last occurrence kept (`lastOccurrenceById`, the cold build's rule):
 * two copies in one `bulkUpsert` chunk fail the statement (21000, "cannot
 * affect row a second time") and fail every later delta of the shard, and
 * across chunks they would overcount `object_count`. Returns the drops.
 * Shard-local only: a duplicate across shards is not seen here (see
 * `coldBuildReadModel` step 1 for what that costs). */
export async function applyObjectShardDelta(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  oldIds: string[],
  newObjects: ObjectInput[]
): Promise<DroppedDuplicateId[]> {
  const { kept, dropped } = lastOccurrenceById('object', newObjects)
  await withPoolTransaction(db, async (tx) => {
    await upsertObjects(tx, key, orgId, kept)
    const present = new Set(kept.map((o) => o.id))
    await deleteObjects(tx, key, oldIds.filter((id) => !present.has(id)))
  })
  return dropped
}

/** `applyObjectShardDelta` for a connection shard, the same in-shard
 * duplicate rule. Returns the drops. */
export async function applyConnectionShardDelta(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  oldIds: string[],
  newConnections: ConnectionInput[]
): Promise<DroppedDuplicateId[]> {
  const { kept, dropped } = lastOccurrenceById('connection', newConnections)
  await upsertConnections(db, key, orgId, kept)
  const present = new Set(kept.map((c) => c.id))
  await deleteConnections(db, key, oldIds.filter((id) => !present.has(id)))
  return dropped
}

export interface ColdBuildOptions {
  /** Phase wall times (`rowWriteTimings.ts`): `rowWritesBreakdown` of
   * `read_model.cold_build_phases`. Observability only. */
  timings?: RowWriteTimings
  /** Receives the tables whose bounded ANALYZE was skipped at its lock
   * ceiling (`analyzeWithinCeiling`): `analyzeSkippedTables` of
   * `read_model.cold_build_phases`. Observability only. */
  analyzeSkipped?: string[]
  /** The ANALYZE lock ceiling, ms (default `ANALYZE_LOCK_WAIT_MS`). Tests
   * shorten it; production passes nothing. */
  analyzeLockWaitMs?: number
}

/** The four entity kinds a cold build writes, one `ro_*` table each. */
export type ColdBuildEntityKind = 'object' | 'connection' | 'group' | 'diagram'

/** One entity a cold build did NOT write because a LATER entity of the
 * same kind has the same id (`lastOccurrenceById`). */
export interface DroppedDuplicateId {
  kind: ColdBuildEntityKind
  /** The id, as stored (`parameterText`). */
  id: string | null
  /** Positions in the input list: the dropped entity, and the one kept. */
  index: number
  keptIndex: number
}

export interface ColdBuildResult {
  /** Every duplicate dropped, in input order. Empty for an extracted model
   * (`extractModelEntities` drops them first and reports each as a
   * `duplicate-id` ModelDefect); non-empty only for a caller that passes
   * raw lists. */
  droppedDuplicates: DroppedDuplicateId[]
}

/**
 * `entities` with every entity whose id (as stored: `parameterText`)
 * appears AGAIN LATER in the list removed — the LAST occurrence wins, kept at
 * its own position. Deterministic: which one survives depends on the list
 * order only, never on batch boundaries. Pure.
 *
 * Why duplicates reach here at all (they are NOT unique by construction):
 * `extractModelEntities` merges object/connection shards by CRDT map KEY
 * (`Object.assign`), but a row is keyed by the entity's inner `id`, which a
 * writer is free to repeat under another key; groups come out of one map
 * the same way; and `readDiagrams` flat-maps the registry shards with no
 * merge at all, so one diagram id in two shards appears twice.
 *
 * WHY LAST, NOT FIRST: so the server serves what the client shows. The
 * client reads the same documents in the same order (`Object.values` of the
 * same maps; `mergeObjectShards`/`mergeConnectionShards`, which
 * `Object.assign` the shards in list order, `src/lib/automerge/projection.ts`)
 * and keeps BOTH copies in its store arrays; every by-id view it builds from
 * them is last-wins — the canvas' `objectMap`/`groupMap`
 * (`new Map(list.map((x) => [x.id, x]))`, `CanvasEngine.ts`), the diagram
 * stubs (`currentMetaStubs`, `bridge.ts`), and the WRITE path: `byIdMap`
 * (`bridge.ts`) and `byId` (`projection.ts`) key the store's list by inner id,
 * last wins, so the client's next write of that shard or ModelMeta collapses
 * the pair to the last copy in the document itself. The server's per-shard
 * delta baseline (`snap`, keyed by `o.id`) is last-wins too. First-wins would
 * have served the copy every client renders over and then writes away.
 *
 * "THE SAME ORDER" HOLDS PER REPLICA, NOT PER DOCUMENT (measured on
 * @automerge/automerge 3.2.6, both packages): a map lists its
 * keys in the order the replica materialised them — KEY order after a load
 * (a server boot, a page reload, `repo.import`), the order it applied them
 * for keys that arrived later (write order for its own writes, merge order
 * for synced ones). {o1, o2} then 'aa-twin' lists [o1, o2, aa-twin]
 * in-session and [aa-twin, o1, o2] after save/load. So for a twin this rule
 * agrees with a client that materialised the map the way this process did,
 * and two replicas can disagree until one of them writes the pair away; the
 * read model can also flip copies on a restart (a cold build reads loaded
 * maps). `liveDuplicateIds.integration.test.ts` pins both orders.
 */
export function lastOccurrenceById<T extends { id: unknown }>(
  kind: ColdBuildEntityKind,
  entities: readonly T[],
): { kept: T[]; ids: (string | null)[]; dropped: DroppedDuplicateId[] } {
  const converted = entities.map((entity) => parameterText(entity.id))
  const lastAt = new Map<string | null, number>()
  converted.forEach((id, index) => lastAt.set(id, index))
  const kept: T[] = []
  const ids: (string | null)[] = []
  const dropped: DroppedDuplicateId[] = []
  entities.forEach((entity, index) => {
    const id = converted[index]
    const keptIndex = lastAt.get(id)!
    if (keptIndex !== index) {
      dropped.push({ kind, id, index, keptIndex })
      return
    }
    kept.push(entity)
    ids.push(id)
  })
  return { kept, ids, dropped }
}

/** node-postgres' own conversion of a JS value to a parameter
 * (`pg/lib/utils.js` `prepareValue`, reached through the SAME `pg` module
 * instance every pool here is built from — `pg.utils`, set by
 * `lib/index.js`; its Date branch reads that instance's `pg.defaults`), so
 * the bulk path converts its column values with the very function every
 * other row write's parameters go through. Not part of pg's typed API:
 * checked at load, so an upgrade that moves it fails the import loudly
 * instead of converting differently. `pg` is held to the 8.21 patch line
 * (`~8.21.0` in package.json) for the same reason: a minor upgrade is a
 * deliberate change. The guards are this load-time check and the identity
 * test (`coldBuild.property.integration.test.ts`), not the range. */
const prepareValue = (pg as unknown as { utils?: { prepareValue?: unknown } }).utils?.prepareValue
if (typeof prepareValue !== 'function') {
  throw new Error(
    'read-model projector: pg.utils.prepareValue is not a function in the installed node-postgres — '
    + 'parameterText (projector.ts) relies on it to reproduce the parameter conversion of every row write; '
    + 're-check it against the new pg version before changing the pin in server/package.json',
  )
}
/** Exported for the identity test (`coldBuild.property.integration.test.ts`). */
export const PG_PREPARE_VALUE = prepareValue as (value: unknown) => unknown
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })
const SURROGATE = /[\ud800-\udfff]/

/**
 * The text PostgreSQL stores for `value` sent as ONE scalar parameter of a
 * `text` column — what `bulkUpsert`'s per-value parameters produce — so the
 * bulk path, which ships columns as `text[]`, writes the same bytes and can
 * decide in JS what the database would decide by text equality (parent
 * existence, group membership, duplicate ids).
 *
 *  - `prepareValue`: null/undefined → NULL, a number/boolean → `toString()`,
 *    an object → JSON, an array → its PostgreSQL array literal (as a scalar
 *    parameter does — an array ELEMENT would otherwise become a nested
 *    dimension), a Date → its timestamp text;
 *  - a Buffer (a scalar parameter goes as raw bytes) → its UTF-8 decoding,
 *    and a throw where PostgreSQL would refuse the bytes as UTF-8;
 *  - a lone surrogate → U+FFFD, as node-postgres' UTF-8 encoding of the
 *    parameter does (a string with a surrogate is round-tripped through the
 *    same encoder; one without has nothing to replace).
 * What PostgreSQL then refuses (a NUL character) it refuses on both paths.
 */
export function parameterText(value: unknown): string | null {
  const prepared = PG_PREPARE_VALUE(value)
  if (prepared === null || prepared === undefined) return null
  const text = Buffer.isBuffer(prepared) ? STRICT_UTF8.decode(prepared) : String(prepared)
  return SURROGATE.test(text) ? Buffer.from(text, 'utf8').toString('utf8') : text
}

/** Rows per statement of the cold build's bulk path: one statement per
 * batch of ~5 000 rows (the probe: 2 000, 5 000 and 10 000 rows per
 * statement inserted 85 235 objects in the same ~3 s; one 85 235-row
 * statement took ~4 s and holds the whole JSON/arrays at once). */
const COLD_BUILD_BATCH = 5000

/** `[owner, member]` posting pairs of one membership list per owner, as the
 * by-deltas path inserts them: the owner's list de-duplicated with a `Set`
 * (there on the raw values, then `ON CONFLICT DO NOTHING`; here on the
 * converted text, which is the same final set). */
function membershipPairs<T extends { id: unknown }>(
  owners: readonly T[],
  members: (owner: T) => readonly unknown[] | undefined,
): Array<[string | null, string | null]> {
  const pairs: Array<[string | null, string | null]> = []
  for (const owner of owners) {
    const ownerId = parameterText(owner.id)
    // The same expression as the by-deltas path, so a list that is not
    // iterable throws here as it throws there.
    const distinct = new Set([...new Set(members(owner) ?? [])].map(parameterText))
    for (const member of distinct) pairs.push([ownerId, member])
  }
  return pairs
}

async function insertMembershipPairs(
  tx: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  table: 'ro_group_objects' | 'ro_diagram_objects' | 'ro_diagram_groups' | 'ro_diagram_connections',
  columns: readonly [string, string],
  pairs: ReadonlyArray<[string | null, string | null]>,
): Promise<void> {
  for (let offset = 0; offset < pairs.length; offset += COLD_BUILD_BATCH) {
    const batch = pairs.slice(offset, offset + COLD_BUILD_BATCH)
    await tx.query(
      `INSERT INTO ${table} (landscape_id, version_id, org_id, ${columns[0]}, ${columns[1]})
       SELECT $1, $2, $3::text, pair.owner_id, pair.member_id
       FROM unnest($4::text[], $5::text[]) AS pair(owner_id, member_id)`,
      [key.landscapeId, key.versionId, orgId, batch.map(([owner]) => owner), batch.map(([, member]) => member)],
    )
  }
}

/** One posting INSERT per batch of rows (`*_INSERT_SQL`). */
async function insertPostingRows(tx: Queryable, sql: string, rows: readonly object[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += COLD_BUILD_BATCH) {
    await tx.query(sql, [JSON.stringify(rows.slice(offset, offset + COLD_BUILD_BATCH))])
  }
}

/**
 * The objects, with their two derived parents computed BEFORE the insert
 * instead of by `refreshEffectiveParents`' UPDATE of every row afterwards
 * (~3-4 s of the by-deltas build at 85 235 objects: a second version of each
 * row, and of each of its twelve index entries). The same definitions:
 *  - `c4_parent_id` = `parent_id` when a row with that id exists in this
 *    workspace, else NULL. Every `ro_objects` row of the workspace is in
 *    `objects` (the cold build deleted the rest), so existence is membership
 *    of the converted id set — the database's `parent.id = object.parent_id`
 *    is text equality, which is equality of the converted strings;
 *  - `effective_parent_id` = the smallest group id among the object's
 *    `ro_group_objects` rows — `min()` computed BY THE DATABASE
 *    (`minGroupOf`), under the column's collation, never by JS — else the
 *    `c4_parent_id`.
 */
async function insertObjectRows(
  tx: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: readonly ObjectInput[],
  ids: readonly (string | null)[],
  minGroupOf: ReadonlyMap<string, string>,
): Promise<void> {
  const present = new Set(ids)
  await insertObjectValueRows(tx, key, orgId, objects.map((object, index) =>
    objectRowValues(key, orgId, object, ids[index], present, minGroupOf)))
}

/** The two parents `insertObjectRows` derives for one object (its comment
 * says how), from the parent id as converted and the workspace's id set. */
function derivedParents(
  parentId: string | null,
  id: string | null,
  present: ReadonlySet<string | null>,
  minGroupOf: ReadonlyMap<string, string>,
): { c4ParentId: string | null; effectiveParentId: string | null } {
  const c4ParentId = parentId !== null && present.has(parentId) ? parentId : null
  return { c4ParentId, effectiveParentId: (id !== null ? minGroupOf.get(id) : undefined) ?? c4ParentId }
}

/** One `ro_objects` row as `insertObjectValueRows` sends it: the 12
 * per-row columns, in its `unnest` order. */
type ObjectRowParameters = Array<string | null>

function objectRowValues(
  key: WorkspaceKey,
  orgId: string | null,
  object: ObjectInput,
  id: string | null,
  present: ReadonlySet<string | null>,
  minGroupOf: ReadonlyMap<string, string>,
): ObjectRowParameters {
  const row = objectToRow(key, orgId, object)
  const parentId = parameterText(row.parent_id)
  const { c4ParentId, effectiveParentId } = derivedParents(parentId, id, present, minGroupOf)
  return [
    id, parameterText(row.type), parameterText(row.name), parameterText(row.description),
    parameterText(row.technology), parameterText(row.domain_id), parentId, effectiveParentId,
    c4ParentId, parameterText(row.scope), parameterText(row.status),
    // `data` exactly as `objValues` sends it, cast below as it casts it.
    JSON.stringify(row.data),
  ]
}

async function insertObjectValueRows(
  tx: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  rows: readonly ObjectRowParameters[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += COLD_BUILD_BATCH) {
    const columns: Array<Array<string | null>> = Array.from({ length: 12 }, () => [])
    for (let index = offset; index < Math.min(offset + COLD_BUILD_BATCH, rows.length); index++) {
      rows[index]!.forEach((value, column) => columns[column]!.push(value))
    }
    await tx.query(
      `INSERT INTO ro_objects (
         landscape_id, version_id, org_id, id, type, name, description, technology,
         domain_id, parent_id, effective_parent_id, c4_parent_id, scope, status, data
       )
       SELECT $1, $2, $3::text, row.id, row.type, row.name, row.description, row.technology,
              row.domain_id, row.parent_id, row.effective_parent_id, row.c4_parent_id,
              row.scope, row.status, row.data::jsonb
       FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                   $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[])
         AS row(id, type, name, description, technology, domain_id, parent_id,
                effective_parent_id, c4_parent_id, scope, status, data)`,
      [key.landscapeId, key.versionId, orgId, ...columns],
    )
  }
}

/**
 * Rebuild one workspace's read-model rows from its full model (one-time cold
 * build, or a self-heal drop+rematerialize). DELETE-then-bulk-insert scoped to
 * (landscape_id, version_id) — NOT a bare TRUNCATE, since the tables now hold
 * every projected workspace's rows side by side. Idempotent + replay-safe:
 * re-running with the same input yields identical rows for this workspace, and
 * never touches another workspace's rows.
 *
 * SET-BASED (G4-16f C7). INVARIANT: every `ro_*` row this writes — the
 * derived stats included, `ro_workspace_stats.updated_at` aside (the
 * transaction's `now()`) — is byte-identical to what `coldBuildReadModelByDeltas`
 * (the composition of the delta paths this replaced) writes for the same
 * input; `coldBuild.property.integration.test.ts` compares the two over
 * randomized corpora. What makes it hold, and what each step relies on:
 *
 *  1. DUPLICATE IDS ARE DROPPED, the LAST occurrence kept
 *     (`lastOccurrenceById`, which says why last), before any statement, so
 *     no insert needs `ON CONFLICT` and none has one. They do occur (see
 *     `lastOccurrenceById`): refusing them failed every cold build of the
 *     workspace, and in monolith mode every reproject, until
 *     `consecutive_failures` walked it to `failed`. The production caller
 *     never gets here with one — `extractModelEntities` applies the same
 *     rule and records each drop as a `duplicate-id` ModelDefect, so the
 *     integrity digest (`fullExtractionIntegrity`) is computed over the same
 *     ids these rows hold; a direct caller gets the drops back in
 *     `droppedDuplicates`. The live paths apply the same rule to what they
 *     see: the ModelMeta pass to the groups map before `syncGroups` and its
 *     group seal, and `applyObjectShardDelta`/`applyConnectionShardDelta` to
 *     ONE shard's list; the static projector to each overlay delta's upserts
 *     and to its ModelMeta groups (`staticDeltaProjector.ts`).
 *     DIVERGENCES, on duplicated input only:
 *      - `coldBuildReadModelByDeltas` (`ON CONFLICT DO UPDATE` per 1 000-row
 *        chunk) FAILS on two in one chunk (21000, "cannot affect row a second
 *        time") and keeps the last across chunks, with the memberships of
 *        both. Pinned by `coldBuild.property.integration.test.ts`; on unique
 *        input the two cold builds are byte-identical.
 *      - A duplicate ACROSS SHARDS (one inner id in two object shards, or two
 *        connection shards) is resolved here and by the client to the later
 *        shard's copy, but the per-shard delta path sees one shard at a time
 *        and has no cross-shard ownership index (deliberately not built). So
 *        a later delta of the shard holding the DROPPED copy, including the
 *        immediate gap projection of an extraction-seeded shard at boot
 *        (`watchObjectShard`, when the live heads differ from the
 *        extraction's), either OVERWRITES the kept row with the dropped
 *        copy's values, or DELETES it: `applyObjectShardDelta` deletes the
 *        `oldIds` no longer present by bare id, so removing the dropped copy
 *        from its shard removes the row the other shard still holds. Either
 *        lasts until the next cold build. The object (connection) seal lapses
 *        at that delta — the delta paths stamp no digest for their kind — so
 *        a later adopt or `verifyWorkspaceIntegrity` reads the kind as
 *        not comparable (`not-verifiable`), never as a mismatch. NOT
 *        covered: the reference-integrity refusal
 *        (`readModelUntrustworthyReason`) reads no seal, so a row deleted
 *        this way can read there as a dangling reference (a known gap).
 *  2. The workspace's rows are DELETED first (every table the by-deltas path
 *     deletes, in its order), so the rows inserted are the whole workspace.
 *  3. Groups and their memberships go in BEFORE the objects, so the objects'
 *     `effective_parent_id` can be computed at insert (`insertObjectRows`);
 *     no table declares a foreign key, so the order is free.
 *  4. None of the per-touched incremental work runs — the touched-id reads,
 *     child stats, root/object/connection/group/diagram counts, connection
 *     stats, diagram summaries: `rebuildReadModelDerivedStats` deletes and
 *     recomputes every one of `ro_object_child_stats`, `ro_connection_stats`,
 *     `ro_diagram_summaries` and `ro_workspace_stats` (every count column, the
 *     root count, `org_id`) from the base rows at the end, and the by-deltas
 *     path's own end is that same call — what it maintained incrementally
 *     before it is discarded by it.
 *  5. Column values go through `parameterText` — node-postgres' conversion
 *     of a scalar parameter — or through the exact statements and row mappers
 *     the delta paths use (`bulkInsert`, the `*_INSERT_SQL` postings).
 *
 * THE LOCK ORDER (`adoptState.ts`): this writes `ro_*` tables only — never a
 * protocol table (`read_model_ordinary_head_retirements`,
 * `read_model_ordinary_chain_folds`), the fence row or an adopt row. That is
 * what lets the caller run it before it claims and asserts the fence
 * (`projectorService.ts`, the cold build's `runTracked`); a protocol write
 * added here would precede the fence and is refused by the protocol tables'
 * trigger on a participant connection. Both are tested
 * (`coldBuild.property.integration.test.ts`).
 *
 * ONE transaction (the caller's when it passes a client): a failure anywhere
 * leaves the previous rows.
 */
export async function coldBuildReadModel(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[],
  connections: ConnectionInput[],
  groups: GroupInput[] = [],
  diagrams: DiagramInput[] = [],
  options: ColdBuildOptions = {},
): Promise<ColdBuildResult> {
  const timings = options.timings
  const objectsKept = lastOccurrenceById('object', objects)
  const connectionsKept = lastOccurrenceById('connection', connections)
  const groupsKept = lastOccurrenceById('group', groups)
  const diagramsKept = lastOccurrenceById('diagram', diagrams)
  const droppedDuplicates = [objectsKept, connectionsKept, groupsKept, diagramsKept].flatMap((list) => list.dropped)
  const objectIds = objectsKept.ids
  objects = objectsKept.kept
  connections = connectionsKept.kept
  groups = groupsKept.kept
  diagrams = diagramsKept.kept
  const diagramObjects = membershipPairs(diagrams, (diagram) => diagram.objectIds)
  const diagramGroups = membershipPairs(diagrams, (diagram) => diagram.groupIds)
  const diagramConnections = membershipPairs(diagrams, (diagram) => diagram.connectionIds)
  await withPoolTransaction(db, async (tx) => {
    const params = [key.landscapeId, key.versionId]
    // P3p: the pending lists merged once, at the end, when no other
    // workspace can be writing these indexes (`COLD_BUILD_GIN_PENDING_LIST_LIMIT`).
    const priorPendingListLimit = await deferGinPendingListMergesWhenAlone(tx, key, timings)
    await timedPhase(timings, 'deletesMs', () => deleteWorkspaceRows(tx, params))
    const minGroupOf = await writeGroupRows(tx, key, orgId, groups, timings)
    await timedPhase(timings, 'objectsInsertMs', () => insertObjectRows(tx, key, orgId, objects, objectIds, minGroupOf))
    await timedPhase(timings, 'objectPostingsMs', async () => {
      await insertPostingRows(tx, OBJECT_TECHNOLOGY_INSERT_SQL, objects.flatMap((object) => objectTechnologyRows(key, orgId, object)))
      await insertPostingRows(tx, OBJECT_TAG_INSERT_SQL, objects.flatMap((object) => objectTagRows(key, orgId, object)))
      await insertPostingRows(tx, OBJECT_TEAM_INSERT_SQL, objects.flatMap((object) => objectTeamRows(key, orgId, object)))
    })
    await timedPhase(timings, 'connectionsMs', () =>
      bulkInsert(tx, 'ro_connections', CONN_COLS, connections.map((c) => connValues(key, orgId, c))))
    await timedPhase(timings, 'diagramsMs', () =>
      bulkInsert(tx, 'ro_diagrams', DIAGRAM_COLS, diagrams.map((d) => diagramValues(key, orgId, d))))
    await timedPhase(timings, 'diagramMembershipMs', async () => {
      await insertMembershipPairs(tx, key, orgId, 'ro_diagram_objects', ['diagram_id', 'object_id'], diagramObjects)
      await insertMembershipPairs(tx, key, orgId, 'ro_diagram_groups', ['diagram_id', 'group_id'], diagramGroups)
      await insertMembershipPairs(tx, key, orgId, 'ro_diagram_connections', ['diagram_id', 'connection_id'], diagramConnections)
    })
    await rebuildReadModelDerivedStats(tx, key, orgId, timings, analyzeOptionsOf(options))
    if (priorPendingListLimit !== undefined) {
      await timedPhase(timings, 'ginPendingMergeMs', () => mergeGinPendingLists(tx, priorPendingListLimit))
    }
  })
  return { droppedDuplicates }
}

/** Groups, their postings and memberships, then `minGroupOf` (by the database). */
async function writeGroupRows(
  tx: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  groups: readonly GroupInput[],
  timings: RowWriteTimings | undefined,
): Promise<ReadonlyMap<string, string>> {
  const params = [key.landscapeId, key.versionId]
  await timedPhase(timings, 'groupsMs', async () => {
    await bulkInsert(tx, 'ro_groups', GROUP_COLS, groups.map((g) => groupValues(key, orgId, g)))
    await insertPostingRows(tx, GROUP_TECHNOLOGY_INSERT_SQL, groups.flatMap((group) => groupTechnologyRows(key, orgId, group)))
    await insertPostingRows(tx, GROUP_TAG_INSERT_SQL, groups.flatMap((group) => groupTagRows(key, orgId, group)))
  })
  return timedPhase(timings, 'groupMembershipMs', async () => {
    const groupMembers = membershipPairs(groups, (group) => group.objectIds)
    await insertMembershipPairs(tx, key, orgId, 'ro_group_objects', ['group_id', 'object_id'], groupMembers)
    if (!groupMembers.length) return new Map<string, string>()
    const result = await tx.query<{ object_id: string; group_id: string }>(
      `SELECT object_id, min(group_id) AS group_id FROM ro_group_objects
       WHERE landscape_id = $1 AND version_id = $2 GROUP BY object_id`,
      params,
    )
    return new Map(result.rows.map((row) => [row.object_id, row.group_id]))
  })
}

/**
 * The GIN pending-list limit of a cold build's transaction (G4-16f, P3p).
 * With the
 * server's default (4 MB), every 4 MB of new trigram entries a cold build
 * inserts is merged into the index there and then, in the foreground: on the
 * day-250 corpus that was 625 MB of the build's 1 050 MB of WAL
 * (`Gin/INSERT`), the same index pages rewritten merge after merge. Raised
 * for the build's transaction only (`SET LOCAL`, restored at its end), the
 * entries accumulate and are merged ONCE (`mergeGinPendingLists`), inside the
 * same transaction. The incremental paths keep the server's limit.
 *
 * ONLY WHEN NO OTHER WORKSPACE HAS ROWS (`deferGinPendingListMergesWhenAlone`).
 * The pending list is the INDEX's, and every workspace shares the index:
 * another session's insert that finds the list above ITS limit (4 MB) merges
 * all of it, in the foreground — the cold build's entries included. Measured
 * (qa/g416f-gin-pending-concurrency.mts, two 12 000-object builds at once
 * and a single-object `upsertObjects` of a third workspace every 20 ms):
 * with the limit raised for every build, that writer's max went from 62-78
 * ms to 420-630 ms (5-6 writes over 100 ms per run), at 32 MB as at 256 MB;
 * a trigram search meanwhile scans the longer list too (p99 5-9 → 6-17 ms).
 * The merge cannot be made invisible on a shared index, so it is deferred
 * only where nobody else can be writing it: a database whose `ro_objects`
 * holds no other workspace — a single-workspace deployment, or the first
 * workspace a NEW database attaches. Not "a cell's first attach": every cell
 * of a deployment writes the same `ro_*` tables, so a cell that attaches its
 * first workspace on a database other cells already fill is not alone and
 * merges as before. And only when this role owns every GIN
 * index of those tables (below). Giving every workspace the
 * single merge would need per-workspace partitions of the `ro_*` tables.
 */
export const COLD_BUILD_GIN_PENDING_LIST_LIMIT = '256MB'

/**
 * Raise the limit for the rest of the transaction when `ro_objects` holds
 * no row of another workspace (two B-tree probes of its primary key, either
 * side of this workspace); returns the prior value (null when the connection
 * reported none: nothing to restore), or `undefined` when the limit was left
 * alone. A workspace that gets its first rows during the build is the
 * residual: its writes may pay this build's merge.
 */
async function deferGinPendingListMergesWhenAlone(
  tx: Queryable,
  key: WorkspaceKey,
  timings: RowWriteTimings | undefined,
): Promise<string | null | undefined> {
  // `other` is also true when this role does NOT own every GIN index of the
  // tables the build writes: `gin_clean_pending_list`
  // requires the owner, so a raised limit over an index the final merge
  // cannot clean would leave up to 256 MB of entries for the next foreign
  // writer to merge in the foreground — the very cost the guard avoids.
  const { rows: others } = await tx.query<{ other: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ro_objects WHERE (landscape_id, version_id) < ($1, $2))
         OR EXISTS (SELECT 1 FROM ro_objects WHERE (landscape_id, version_id) > ($1, $2))
         OR EXISTS (SELECT 1 FROM pg_index x
                      JOIN pg_class i ON i.oid = x.indexrelid
                      JOIN pg_am am ON am.oid = i.relam
                     WHERE am.amname = 'gin' AND x.indrelid = ANY($3::regclass[])
                       AND NOT pg_has_role(current_user, i.relowner, 'USAGE')) AS other`,
    [key.landscapeId, key.versionId, [...COLD_BUILD_DELETED_TABLES]],
  )
  // A connection that answered nothing (a test double) is not "alone".
  if (others[0]?.other !== false) return undefined
  const { rows } = await tx.query<{ prior: string }>(
    `SELECT current_setting('gin_pending_list_limit') AS prior, set_config('gin_pending_list_limit', $1, true)`,
    [COLD_BUILD_GIN_PENDING_LIST_LIMIT],
  )
  if (timings) timings.ginPendingDeferred = 1
  return rows[0]?.prior ?? null
}

/**
 * Merge the pending list of every GIN index on the tables the cold build
 * wrote — every table it deletes from (`COLD_BUILD_DELETED_TABLES`), so
 * every GIN index whose list it can have grown, trigram or not
 * (`gin_clean_pending_list`, forced: it waits for a concurrent merge of
 * the same index instead of skipping), then restore the limit. Merges what
 * the list holds, ANY writer's entries included (they are index entries, not
 * rows: visibility is the heap's), so a second cold build running at the same
 * moment finds less to merge. The merge's memory is bounded by
 * `maintenance_work_mem`, not by the list.
 */
async function mergeGinPendingLists(tx: Queryable, priorLimit: string | null): Promise<void> {
  await tx.query(
    `SELECT gin_clean_pending_list(x.indexrelid::regclass)
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_am am ON am.oid = i.relam
      WHERE am.amname = 'gin' AND x.indrelid = ANY($1::regclass[])
        -- The function requires the index's owner; an index this role does
        -- not own keeps its list (the server's ordinary behaviour), rather
        -- than failing the build.
        AND pg_has_role(current_user, i.relowner, 'USAGE')`,
    [[...COLD_BUILD_DELETED_TABLES]],
  )
  if (priorLimit !== null) await tx.query(`SELECT set_config('gin_pending_list_limit', $1, true)`, [priorLimit])
}

const analyzeOptionsOf = (options: ColdBuildOptions) => ({
  skipped: options.analyzeSkipped,
  lockWaitMs: options.analyzeLockWaitMs,
})

/**
 * THE REFERENCE the bulk `coldBuildReadModel` is tested against — the cold
 * build as it was before G4-16f C7: delete, then every entity through its
 * delta path (`upsertObjects` with its per-touched incremental stats, the
 * upserts, the membership replaces), then `rebuildReadModelDerivedStats`.
 * Not called in production; kept so the equivalence property can be checked
 * against the paths the delta projector still runs. It does NOT drop
 * duplicate ids (see `coldBuildReadModel` step 1 for what it does with
 * them instead).
 */
export async function coldBuildReadModelByDeltas(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[],
  connections: ConnectionInput[],
  groups: GroupInput[] = [],
  diagrams: DiagramInput[] = [],
  options: ColdBuildOptions = {},
): Promise<void> {
  const timings = options.timings
  await withPoolTransaction(db, async (tx) => {
    const params = [key.landscapeId, key.versionId]
    await timedPhase(timings, 'deletesMs', () => deleteWorkspaceRows(tx, params))
    // THE ONE caller that asks for the ANALYZE — see `UpsertObjectsOptions`.
    // A cold build has just DELETEd every `ro_objects` row for this workspace
    // and is about to insert them all back, so the planner's statistics for
    // this `landscape_id` are worthless exactly where the reparent needs them.
    // The delta paths must NOT pass it (~2.5x slower there).
    await upsertObjects(tx, key, orgId, objects, { analyzeBeforeReparent: true, timings })
    await timedPhase(timings, 'connectionsMs', () => upsertConnections(tx, key, orgId, connections))
    await timedPhase(timings, 'groupsMs', () => upsertGroups(tx, key, orgId, groups))
    await timedPhase(timings, 'diagramsMs', () => upsertDiagrams(tx, key, orgId, diagrams))
    await timedPhase(timings, 'groupMembershipMs', () => replaceGroupMembership(tx, key, orgId, groups))
    await timedPhase(timings, 'diagramMembershipMs', () => replaceDiagramMembership(tx, key, orgId, diagrams))
    await rebuildReadModelDerivedStats(tx, key, orgId, timings, analyzeOptionsOf(options))
  })
}

/** Every row of one workspace's projected tables, children before parents
 * (no FK declares it, but the order keeps any future one satisfied). */
async function deleteWorkspaceRows(tx: Queryable, params: string[]): Promise<void> {
  for (const table of COLD_BUILD_DELETED_TABLES) {
    await tx.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, params)
  }
}

/** What a cold build deletes, in this order — every projected table it
 * rewrites (`ro_decision_records` is not one: decision records have their
 * own projection, and `rebuildWorkspaceStats` counts them as they are). */
const COLD_BUILD_DELETED_TABLES = [
  'ro_object_technologies', 'ro_group_technologies', 'ro_object_tags', 'ro_group_tags', 'ro_object_teams',
  'ro_group_objects', 'ro_diagram_objects', 'ro_diagram_groups', 'ro_diagram_connections', 'ro_connection_flows',
  ...DIAGRAM_FLOW_INDEX_TABLES,
  'ro_objects', 'ro_connections', 'ro_groups', 'ro_diagrams',
  'ro_diagram_summaries', 'ro_connection_stats', 'ro_object_child_stats', 'ro_workspace_stats',
] as const

/** Pools get a dedicated transaction; a caller-scoped client runs in the
 * caller's. The shape test and the ROLLBACK handling (which must not let a
 * failing ROLLBACK replace the original error) live in `queryableShape.ts`. */
async function withPoolTransaction(db: Queryable, run: (tx: Queryable) => Promise<void>): Promise<void> {
  await withAtomicStatements(db, run)
}
