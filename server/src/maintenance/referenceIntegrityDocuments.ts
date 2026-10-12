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

import type { Repo } from '@automerge/automerge-repo'
import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import type { Queryable } from '../readModel/types.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import { staticReadModelQueryWorkspaceIfPresent } from '../readModel/staticWorkspace.js'
import {
  DOCUMENT_CHECKED_KINDS,
  classifyReferenceFinding,
  type DocumentReferenceKind,
  type ReferenceFinding,
} from './referenceFindings.js'

export { DOCUMENT_CHECKED_KINDS }
export type { DocumentReferenceKind }

/**
 * Is this workspace's read model a REDIRECT to another version's rows?
 *
 * A sparse draft registers `read_model_static_workspaces.base_version_id =
 * <parent>` (`landscapes.ts`), so every `ro_*` row it reads lives under the
 * PARENT's `version_id` and a query using the draft's own id returns nothing.
 *
 * This scan resolves referrers from the draft's documents against targets in
 * `ro_*` by raw `version_id`. On a redirected workspace those target sets come
 * back EMPTY, so every composition member, group member, layout key, flow ref
 * and ADR link in the draft reads as dangling — and the repair would strip all
 * of them. Not a hypothetical: the whole draft's content is reachable this way.
 *
 * REFUSING is the answer, not compensating. Querying the parent instead would be
 * wrong in the other direction — a draft's overlay adds and deletes entities of
 * its own, so the parent is not its target set either. Making this scan
 * draft-aware is a design change; until then it must not pretend to have looked.
 */
export async function readModelRedirectBaseVersion(
  db: Queryable,
  key: { landscapeId: string; versionId: string },
): Promise<string | null> {
  const resolved = await staticReadModelQueryWorkspaceIfPresent(db, key)
  if (!resolved || resolved.versionId === key.versionId) return null
  return resolved.versionId
}

/**
 * Why the read model of this workspace cannot be trusted as ground truth right
 * now, or null when it can.
 *
 * SIBLING OF THE SPARSE-DRAFT REFUSAL, and it exists for the same reason: every
 * check here asks "does the target exist in `ro_*`?", so any state in which
 * `ro_*` is legitimately incomplete turns the whole workspace into findings, and
 * `diagram.objectIds` / `diagram.connectionIds` / `group.objectIds` are all
 * classified `safeToApply: true`. An apply then strips the ids from every
 * diagram AND deletes their saved layout positions.
 *
 * Two states make `ro_*` legitimately incomplete:
 *
 *  1. A projection that COMPLETED WITH HOLES. `readEntityMapOrDefect`
 *     (`readModel/modelDefects.ts`) returns an empty map plus a recorded defect
 *     when a shard is unreadable, deliberately, so one bad shard no longer
 *     fails the whole projection. `ro_objects` is then short by that shard while
 *     `ro_diagram_objects` still lists its members — which reads here as "the
 *     object was deleted" and is exactly wrong.
 *  2. A workspace that was NEVER PROJECTED, or was evicted. The projector fleet
 *     is per-workspace and LRU-capped, so `ro_*` being empty is routine rather
 *     than evidence of anything.
 *
 * Refusing here covers the dry run and the apply, which are the console's two
 * entry points.
 */
export async function readModelUntrustworthyReason(
  db: Queryable,
  key: { landscapeId: string; versionId: string },
): Promise<string | null> {
  const { rows } = await db.query<{
    projected_generation: string | null
    last_error_generation: string | null
    degraded_since: Date | null
    defect_count: number | null
    defect_summary: string | null
  }>(
    `SELECT projected_generation, last_error_generation, degraded_since, defect_count, defect_summary
       FROM read_model_projection_state
      WHERE landscape_id = $1 AND version_id = $2`,
    [key.landscapeId, key.versionId],
  )
  const state = rows[0]
  if (!state) return 'it has never been projected, so every ro_* table is empty'
  if (state.degraded_since) return `its projector has been degraded since ${state.degraded_since.toISOString()}`
  if ((state.defect_count ?? 0) > 0) {
    return `its last full extraction recorded ${state.defect_count} unreadable document(s)`
      + `${state.defect_summary ? `: ${state.defect_summary}` : ''}`
  }
  if (state.last_error_generation !== null
    && BigInt(state.last_error_generation) > BigInt(state.projected_generation ?? '0')) {
    return `its last projection attempt (generation ${state.last_error_generation}) failed`
  }
  return null
}

/**
 * The second leg of the reference-integrity scan: the references that exist only
 * in Automerge documents and are therefore invisible to SQL.
 *
 * `ro_groups` is `(id, name)` and nothing else, so `Group.parentObjectId` — the
 * one dangling reference with a VISIBLE symptom, wrapper chrome plus a live
 * "create detail diagram" control anchored to a deleted object — has no column to
 * be checked against. Neither do a diagram's layout keys, nor a flow step's
 * object and connection refs.
 *
 * The walk is deliberately lopsided. `ModelMeta` is ONE document holding the
 * whole group collection, so those checks are effectively free and always run.
 * The per-diagram checks need one document each, so they are bounded by both a
 * document count and a wall clock, and the result says when it stopped early.
 *
 * REPORT ONLY.
 *
 * Two things this leg still cannot decide:
 *   - `Diagram.skinId`. Skins are client PLUGINS; the server holds no installed
 *     registry to resolve one against, so a miss here would be unfalsifiable.
 *     `getResolvedSkin` already falls back to the default, which is the whole
 *     mitigation.
 *   - `Comment.diagramId`. It cannot dangle: comments live INSIDE the DiagramDoc
 *     and die with it. What is missing there is disclosure before a delete, not
 *     a reference check.
 */

export interface DocumentScanReport {
  reportOnly: true
  landscapeId: string
  versionId: string
  findings: ReferenceFinding[]
  countsByKind: Record<string, number>
  checkedKinds: readonly string[]
  /** Diagram documents actually opened. */
  diagramsWalked: number
  /** Diagram documents the caps stopped it from opening. */
  diagramsSkipped: number
  /** True when a cap or the deadline cut the walk short. */
  truncated: boolean
}

interface RootLike { modelUrl?: string; modelMetaUrl?: string; shardUrls?: string[] }
interface AdrLinkLike { type?: unknown; targetId?: unknown }
interface MetaLike {
  groups?: Record<string, { parentObjectId?: string; objectIds?: string[] }>
  decisionRecords?: Record<string, { related?: AdrLinkLike[] } | null>
  deletedDecisionRecordIds?: string[]
  decisionRecordShardUrls?: string[]
  staticBaseline?: boolean
}
interface RegistryShardLike { diagrams?: Record<string, { docUrl?: string }> }
interface DiagramDocLike {
  objectIds?: string[]
  connectionIds?: string[]
  groupIds?: string[]
  layouts?: Record<string, unknown>
  layouts3d?: Record<string, unknown>
  flows?: Record<string, { steps?: Array<Record<string, unknown>> }>
}

export interface DocumentScanOptions {
  landscapeId: string
  versionId: string
  /** Hard cap on diagram documents opened. Default 200. */
  maxDiagrams?: number
  /** Wall clock for the whole walk. Default 20s. */
  deadlineMs?: number
  /** Per-document resolve ceiling. Default 5s. */
  documentTimeoutMs?: number
  now?: () => number
}

const DEFAULTS = { maxDiagrams: 200, deadlineMs: 20_000, documentTimeoutMs: 5_000 }

/**
 * Walk one workspace's documents.
 *
 * Resolution is HYBRID on purpose: the referrers come from the documents
 * (nothing else has them) while the targets are resolved against the read model,
 * which already projects every object, connection and group id. Loading the
 * object shards to answer "does this id exist" would materialise the whole model
 * to learn something Postgres already knows.
 *
 * Run this from the maintenance coordinator rather than a request handler: it
 * opens documents, and a workspace with a resident read-model projector holds
 * leases that make the walk both slower and less meaningful.
 */
export async function scanDocumentReferences(
  db: Queryable,
  repo: Repo,
  rootUrl: string,
  options: DocumentScanOptions,
): Promise<DocumentScanReport> {
  const { landscapeId, versionId } = options
  const maxDiagrams = options.maxDiagrams ?? DEFAULTS.maxDiagrams
  const deadlineMs = options.deadlineMs ?? DEFAULTS.deadlineMs
  const documentTimeoutMs = options.documentTimeoutMs ?? DEFAULTS.documentTimeoutMs
  const clock = options.now ?? (() => Date.now())
  const startedAt = clock()
  const outOfTime = () => clock() - startedAt >= deadlineMs

  const findings: ReferenceFinding[] = []
  // Severity and repairability come from the SHARED classifier, so a document
  // finding reaches the repair carrying the same verdict a SQL one would.
  const add = (kind: DocumentReferenceKind, field: string, sourceId: string, targetId: string) => {
    findings.push({ landscapeId, versionId, kind, field, sourceId, targetId, ...classifyReferenceFinding(kind) })
  }

  // A redirected read model has NO rows under this version_id, so every target
  // set below would be empty and every reference in the documents would read as
  // dangling. Report nothing, and say the walk did not happen — `truncated` is
  // what stops "0 findings" being read as "0 problems".
  if (await readModelRedirectBaseVersion(db, { landscapeId, versionId })) {
    const countsByKind: Record<string, number> = {}
    for (const kind of DOCUMENT_CHECKED_KINDS) countsByKind[kind] = 0
    return {
      reportOnly: true, landscapeId, versionId, findings: [], countsByKind,
      checkedKinds: [], diagramsWalked: 0, diagramsSkipped: 0, truncated: true,
    }
  }

  // Target sets from the read model — one round trip each, no document loading.
  const idsOf = async (table: string): Promise<Set<string>> => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE landscape_id = $1 AND version_id = $2`, [landscapeId, versionId])
    return new Set(rows.map((row) => row.id))
  }
  const [objectIds, connectionIds, groupIds, diagramIds] = await Promise.all([
    idsOf('ro_objects'), idsOf('ro_connections'), idsOf('ro_groups'), idsOf('ro_diagrams'),
  ])

  const root = (await findReadyDocument<RootLike>(repo, rootUrl, documentTimeoutMs)).doc()
  if (!root) throw new Error(`workspace root ${rootUrl} is unreadable`)

  // ── ModelMeta: the whole group collection, in one document ────────────────
  const metaUrl = root.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl) ? root.modelMetaUrl : root.modelUrl
  if (metaUrl && isValidAutomergeUrl(metaUrl)) {
    const meta = (await findReadyDocument<MetaLike>(repo, metaUrl, documentTimeoutMs)).doc()
    for (const [groupId, group] of Object.entries(meta?.groups ?? {})) {
      const parent = group?.parentObjectId
      // The visible one: the canvas keeps painting wrapper chrome and a live
      // "create detail diagram" control anchored to an object that is gone.
      if (typeof parent === 'string' && parent !== '' && !objectIds.has(parent)) {
        add('group.parentObjectId', 'parentObjectId', groupId, parent)
      }
      for (const memberId of group?.objectIds ?? []) {
        if (typeof memberId === 'string' && memberId !== '' && !objectIds.has(memberId)) {
          add('group.objectIds', 'objectIds', groupId, memberId)
        }
      }
    }

    // ── ADR related links, which SQL alone cannot see on an ordinary workspace ─
    //
    // `ro_decision_records` is written ONLY by the static delta projector and the
    // one-shot performance baseline — `readModel/projector.ts` never touches it —
    // so on an ordinary workspace the SQL leg's two ADR checks run against an
    // empty table forever and can never report anything. The referrers are right
    // here in the document; read them from there.
    const records = meta?.decisionRecords ?? {}
    const tombstoned = new Set(meta?.deletedDecisionRecordIds ?? [])
    // Mirrors `usesDecisionRecordDelta` on the client: either marker means
    // `decisionRecords` is an EDIT OVERLAY and the collection lives elsewhere.
    //
    // ABSTAIN WHOLESALE on a paged workspace — both kinds, not just the record
    // kind. That workspace is precisely the one whose `ro_decision_records` IS
    // populated (the static delta projector mirrors the overlay into it too), so
    // the SQL leg already sees every record here, baseline AND overlay.
    // Abstaining on only one kind would report the other twice — one dangling
    // link, two findings. The two legs' populations must be disjoint.
    const paged = meta?.staticBaseline === true || (meta?.decisionRecordShardUrls?.length ?? 0) > 0
    const liveRecordIds = new Set(Object.keys(records).filter((id) => !tombstoned.has(id)))
    for (const [adrId, record] of paged ? [] : Object.entries(records)) {
      if (tombstoned.has(adrId)) continue
      const related = record?.related
      if (!Array.isArray(related)) continue
      for (const link of related) {
        const targetId = link?.targetId
        if (typeof targetId !== 'string' || targetId === '') continue
        if (link?.type === 'diagram') {
          // Resolved against `ro_diagrams`, the same hybrid this walk uses for
          // objects, groups and connections. This is an OBSERVATION, and the
          // repair treats it as one: `enrichDecisionRecordLinkPlans` re-derives
          // the live diagram set from the registry shards and refuses to promote
          // a plan when that walk did not finish. What neither can currently
          // resolve is a workspace whose read model is redirected — refused
          // outright above, and by `repairReferenceIntegrity`.
          if (!diagramIds.has(targetId)) {
            add('decisionRecord.related.diagram', 'related[type=diagram].targetId', adrId, targetId)
          }
        } else if (link?.type === 'adr' || link?.type === 'draft') {
          if (!liveRecordIds.has(targetId)) {
            add('decisionRecord.related.adr', 'related[type=adr|draft].targetId', adrId, targetId)
          }
        }
      }
    }
  }

  // ── Per diagram: layout keys and flow-step refs ───────────────────────────
  const diagramUrls: Array<{ id: string; url: string }> = []
  let truncated = false
  for (const shardUrl of root.shardUrls ?? []) {
    if (!isValidAutomergeUrl(shardUrl)) { truncated = true; continue }
    let shard: RegistryShardLike | undefined
    try {
      shard = (await findReadyDocument<RegistryShardLike>(repo, shardUrl, documentTimeoutMs)).doc()
    } catch {
      // Same rule as the diagram walk below: one unreadable REGISTRY shard must
      // not end the scan. Uncaught, it
      // rejects `scanDocumentReferences` and takes every finding — SQL ones
      // included — down with it, turning the diagnostic into a 500 on exactly
      // the workspaces it exists to diagnose.
      truncated = true
      continue
    }
    for (const [diagramId, stub] of Object.entries(shard?.diagrams ?? {})) {
      if (stub?.docUrl && isValidAutomergeUrl(stub.docUrl)) diagramUrls.push({ id: diagramId, url: stub.docUrl })
    }
  }

  let diagramsWalked = 0
  for (const { id, url } of diagramUrls) {
    if (diagramsWalked >= maxDiagrams || outOfTime()) { truncated = true; break }
    let doc: DiagramDocLike | undefined
    try {
      doc = (await findReadyDocument<DiagramDocLike>(repo, url, documentTimeoutMs)).doc()
    } catch {
      // A registry entry pointing at a document that cannot be read is its own
      // kind of dangling reference — entity-vs-DOCUMENT, which no SQL check can
      // see. Do NOT let it end the walk: one unreadable document must not hide
      // every finding after it.
      add('diagram.docUrl', 'docUrl', id, url)
      diagramsWalked++
      continue
    }
    diagramsWalked++
    if (!doc) continue

    // A layout key is MEMBERSHIP, not existence, so the honest check is against
    // the model: a key naming nothing at all is dead weight that will resurrect
    // a stale position if the id ever returns.
    for (const [layer, layouts] of [['layouts', doc.layouts], ['layouts3d', doc.layouts3d]] as const) {
      for (const key of Object.keys(layouts ?? {})) {
        if (!objectIds.has(key) && !connectionIds.has(key) && !groupIds.has(key)) {
          add('diagram.layouts', layer, id, key)
        }
      }
    }

    for (const flow of Object.values(doc.flows ?? {})) {
      for (const step of flow?.steps ?? []) {
        for (const [field, set] of [
          ['fromObjectId', objectIds], ['toObjectId', objectIds],
          ['objectId', objectIds], ['connectionId', connectionIds],
        ] as const) {
          const value = step?.[field]
          if (typeof value === 'string' && value !== '' && !set.has(value)) {
            add('flowStep.refs', field, id, value)
          }
        }
      }
    }
  }

  const countsByKind: Record<string, number> = {}
  for (const kind of DOCUMENT_CHECKED_KINDS) countsByKind[kind] = 0
  for (const finding of findings) countsByKind[finding.kind]++

  return {
    reportOnly: true,
    landscapeId,
    versionId,
    findings,
    countsByKind,
    checkedKinds: DOCUMENT_CHECKED_KINDS,
    diagramsWalked,
    diagramsSkipped: diagramUrls.length - diagramsWalked,
    truncated,
  }
}
