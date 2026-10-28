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
  countExistingIds,
  rebuildReadModelDerivedStats,
  refreshConnectionStats,
  refreshConnectionStatsForEndpoints,
  refreshDiagramSummaries,
  refreshObjectChildStats,
} from './derivedStats.js'
import { withAtomicStatements } from './queryableShape.js'

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
 * column denormalizes both `technology` + `technologies[]` so the trigram index
 * covers either representation. */
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
function buildUpsert(table: string, cols: readonly string[], rows: unknown[][]): { text: string; params: unknown[] } {
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
    text: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ` +
      `ON CONFLICT (landscape_id, version_id, id) DO UPDATE SET ${updates}`,
    params,
  }
}

async function bulkUpsert(db: Queryable, table: string, cols: readonly string[], rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { text, params } = buildUpsert(table, cols, rows.slice(i, i + CHUNK))
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
 * How long a cold build will wait for `ro_objects`' ANALYZE lock before giving
 * up on the optimisation and building with the slow plan.
 *
 * Generous ON PURPOSE, and the arithmetic is the justification rather than a
 * round number: the only thing that holds this lock is another cold build's
 * ANALYZE, which runs for about the length of one build (~7 s at 12 000
 * objects). Skipping costs ~19 s of reparent, so waiting is the better trade at
 * any value under that. What the ceiling buys is not speed — it is that the
 * wait is FINITE.
 */
const ANALYZE_LOCK_WAIT_MS = 15_000

/**
 * `ANALYZE ro_objects`, BOUNDED, degrading to the slow plan rather than waiting.
 *
 * The bound is the whole point of this function existing instead of one inline
 * statement. Measured against a real Postgres:
 *
 *  - `ANALYZE` takes `ShareUpdateExclusiveLock` on the table and HOLDS IT TO
 *    COMMIT (still present two statements later). `ro_objects` carries every
 *    workspace's rows side by side, so this is a CROSS-WORKSPACE lock;
 *  - it does NOT conflict with ordinary DML — a rival INSERT ran in 3 ms — so
 *    delta projections, and every other writer of these tables, are unaffected;
 *  - it DOES conflict with another `ANALYZE` (and with VACUUM and DDL): the
 *    rival aborted at its ceiling. So two cold builds of DIFFERENT workspaces
 *    serialize here, and nothing else was serializing them — the projection
 *    mutex is per-workspace.
 *
 * And that matters because of where it sits: `withReadModelProjectionTransaction`
 * sets `lock_timeout = 0` immediately after taking the mutex, deliberately, so
 * that a static publish's `overlay-rotation` wait is not re-timed. That disarm
 * assumes everything after the mutex is a per-workspace ROW lock; this
 * statement is a cross-workspace TABLE lock, so it would inherit an unbounded
 * wait inside a held mutex. Hence the SAVEPOINT and the ceiling here rather
 * than reliance on the caller's.
 *
 * A skipped ANALYZE is correct, just slow: the reparent runs the `est=1` plan
 * this exists to avoid. It is logged, because a cold build silently taking 4x
 * longer is the kind of thing nobody ever finds.
 *
 * Unexplored alternative: a transaction-scoped planner GUC would take no lock
 * at all, but a blunt `enable_nestloop` would apply to every query in the
 * projection; it has not been measured.
 */
async function analyzeObjectsForReparent(tx: Queryable, key: WorkspaceKey): Promise<void> {
  // A SAVEPOINT because a failed statement ABORTS the whole transaction, and
  // this one is allowed to fail — it is an optimisation, not a write.
  await tx.query('SAVEPOINT read_model_analyze')
  try {
    await tx.query(`SET LOCAL lock_timeout = '${ANALYZE_LOCK_WAIT_MS}ms'`)
    await tx.query('ANALYZE ro_objects')
    await tx.query('RELEASE SAVEPOINT read_model_analyze')
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT read_model_analyze')
    await tx.query('RELEASE SAVEPOINT read_model_analyze')
    console.warn(
      `[read-model] could not ANALYZE ro_objects for ${key.landscapeId}/${key.versionId} within `
      + `${ANALYZE_LOCK_WAIT_MS} ms (another cold build's ANALYZE, an autovacuum or a migration holds it). `
      + 'Building with stale planner statistics — correct, but measured ~4x slower on a first-ever build:',
      error,
    )
  }
  // OFF again whatever happened. On the success path the `SET LOCAL` above is
  // still in force and would re-time every later lock in the projection (see
  // the disarm in `projectionTransaction.ts`). On
  // the failure path `ROLLBACK TO SAVEPOINT` has already undone it, so this is
  // redundant there and harmless; issuing it unconditionally is what keeps the
  // two paths from having to be reasoned about separately.
  await tx.query('SET LOCAL lock_timeout = 0')
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
}

export async function upsertObjects(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[],
  options: UpsertObjectsOptions = {},
): Promise<void> {
  if (!objects.length) return
  await withPoolTransaction(db, async (tx) => {
    const ids = objects.map((object) => object.id)
    const existing = await countExistingIds(tx, key, 'ro_objects', 'id', ids)
    const oldParentIds = await effectiveParentIdsForTouched(tx, key, ids)
    const oldRootCount = await rootCountForTouched(tx, key, ids)
    const diagramIds = await diagramIdsForObjects(tx, key, ids)
    await bulkUpsert(tx, 'ro_objects', OBJ_COLS, objects.map((o) => objValues(key, orgId, o)))
    if (options.analyzeBeforeReparent) await analyzeObjectsForReparent(tx, key)
    await refreshEffectiveParents(tx, key, 'objects', ids)
    await replaceObjectTechnologyPostingsInTransaction(tx, key, orgId, objects)
    await replaceObjectTagPostingsInTransaction(tx, key, orgId, objects)
    await replaceObjectTeamPostingsInTransaction(tx, key, orgId, objects)
    const newParentIds = await effectiveParentIdsForTouched(tx, key, ids)
    const newRootCount = await rootCountForTouched(tx, key, ids)
    await refreshObjectChildStats(tx, key, [...ids, ...oldParentIds, ...newParentIds])
    await adjustRootObjectCount(tx, key, orgId, newRootCount - oldRootCount)
    await refreshConnectionStatsForEndpoints(tx, key, ids)
    await refreshDiagramSummaries(tx, key, diagramIds)
    await adjustWorkspaceCount(tx, key, orgId, 'object_count', objects.length - existing)
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
  await db.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         landscape_id text, version_id text, org_id text, object_id text,
         tag_id text, ordinal integer
       )
     )
     INSERT INTO ro_object_tags (
       landscape_id, version_id, org_id, object_id, tag_id, ordinal
     )
     SELECT landscape_id, version_id, org_id, object_id, tag_id, ordinal FROM input`,
    [JSON.stringify(rows)]
  )
}

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
  await db.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         landscape_id text, version_id text, org_id text, object_id text, team_id text
       )
     )
     INSERT INTO ro_object_teams (landscape_id, version_id, org_id, object_id, team_id)
     SELECT landscape_id, version_id, org_id, object_id, team_id FROM input`,
    [JSON.stringify(rows)]
  )
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
  await db.query(
    `WITH input AS (
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
     FROM input`,
    [JSON.stringify(rows)]
  )
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
  await db.query(
    `WITH input AS (
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
     FROM input`,
    [JSON.stringify(rows)]
  )
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
  await db.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
         landscape_id text, version_id text, org_id text, group_id text,
         tag_id text, ordinal integer
       )
     )
     INSERT INTO ro_group_tags (
       landscape_id, version_id, org_id, group_id, tag_id, ordinal
     )
     SELECT landscape_id, version_id, org_id, group_id, tag_id, ordinal FROM input`,
    [JSON.stringify(rows)]
  )
}

export async function upsertConnections(db: Queryable, key: WorkspaceKey, orgId: string | null, connections: ConnectionInput[]): Promise<void> {
  if (!connections.length) return
  await withPoolTransaction(db, async (tx) => {
    const ids = connections.map((connection) => connection.id)
    const existing = await countExistingIds(tx, key, 'ro_connections', 'id', ids)
    await bulkUpsert(tx, 'ro_connections', CONN_COLS, connections.map((c) => connValues(key, orgId, c)))
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
      await tx.query(
        `DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
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
      await tx.query(
        `DELETE FROM ro_connections
         WHERE landscape_id = $1 AND version_id = $2 AND id = ANY($3::text[])`,
        [key.landscapeId, key.versionId, ids]
      )
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
 * replay-safe). */
export async function applyObjectShardDelta(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  oldIds: string[],
  newObjects: ObjectInput[]
): Promise<void> {
  await withPoolTransaction(db, async (tx) => {
    await upsertObjects(tx, key, orgId, newObjects)
    const present = new Set(newObjects.map((o) => o.id))
    await deleteObjects(tx, key, oldIds.filter((id) => !present.has(id)))
  })
}

export async function applyConnectionShardDelta(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  oldIds: string[],
  newConnections: ConnectionInput[]
): Promise<void> {
  await upsertConnections(db, key, orgId, newConnections)
  const present = new Set(newConnections.map((c) => c.id))
  await deleteConnections(db, key, oldIds.filter((id) => !present.has(id)))
}

/** Rebuild one workspace's read-model rows from its full model (one-time cold
 * build, or a self-heal drop+rematerialize). DELETE-then-bulk-insert scoped to
 * (landscape_id, version_id) — NOT a bare TRUNCATE, since the tables now hold
 * every projected workspace's rows side by side. Idempotent + replay-safe:
 * re-running with the same input yields identical rows for this workspace, and
 * never touches another workspace's rows. */
export async function coldBuildReadModel(
  db: Queryable,
  key: WorkspaceKey,
  orgId: string | null,
  objects: ObjectInput[],
  connections: ConnectionInput[],
  groups: GroupInput[] = [],
  diagrams: DiagramInput[] = []
): Promise<void> {
  await withPoolTransaction(db, async (tx) => {
    const params = [key.landscapeId, key.versionId]
    await tx.query(`DELETE FROM ro_object_technologies WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_group_technologies WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_object_tags WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_group_tags WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_object_teams WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_group_objects WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_diagram_objects WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_diagram_groups WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_diagram_connections WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_connection_flows WHERE landscape_id = $1 AND version_id = $2`, params)
    for (const table of DIAGRAM_FLOW_INDEX_TABLES) {
      await tx.query(`DELETE FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, params)
    }
    await tx.query(`DELETE FROM ro_objects WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_connections WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_groups WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_diagrams WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_diagram_summaries WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_connection_stats WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_object_child_stats WHERE landscape_id = $1 AND version_id = $2`, params)
    await tx.query(`DELETE FROM ro_workspace_stats WHERE landscape_id = $1 AND version_id = $2`, params)
    // THE ONE caller that asks for the ANALYZE — see `UpsertObjectsOptions`.
    // A cold build has just DELETEd every `ro_objects` row for this workspace
    // and is about to insert them all back, so the planner's statistics for
    // this `landscape_id` are worthless exactly where the reparent needs them.
    // The delta paths must NOT pass it (~2.5x slower there).
    await upsertObjects(tx, key, orgId, objects, { analyzeBeforeReparent: true })
    await upsertConnections(tx, key, orgId, connections)
    await upsertGroups(tx, key, orgId, groups)
    await upsertDiagrams(tx, key, orgId, diagrams)
    await replaceGroupMembership(tx, key, orgId, groups)
    await replaceDiagramMembership(tx, key, orgId, diagrams)
    await rebuildReadModelDerivedStats(tx, key, orgId)
  })
}

/** Pools get a dedicated transaction; a caller-scoped client runs in the
 * caller's. The shape test and the ROLLBACK handling (which must not let a
 * failing ROLLBACK replace the original error) live in `queryableShape.ts`. */
async function withPoolTransaction(db: Queryable, run: (tx: Queryable) => Promise<void>): Promise<void> {
  await withAtomicStatements(db, run)
}
