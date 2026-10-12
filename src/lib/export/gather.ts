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

import { isValidAutomergeUrl } from '@automerge/automerge-repo'
import type { C4Object, Connection, Diagram, Flow } from '../../types'
import { useModelStore } from '../../stores/modelStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import {
  findDiagramHandle,
  findModelMetaHandle,
  getModelHandle,
  getModelShardHandles,
  getRegistryShardHandles,
  getRootHandle,
} from '../automerge/repo'
import { currentWorkspaceRef, type WorkspaceRef } from '../automerge/workspace'
import type { ConnectionShard, ModelMeta, ObjectShard, RootDoc } from '../automerge/types'
import {
  diagramDocFlows,
  diagramDocToDiagram,
  mergeShards,
  modelShardsToRootModel,
  rootModelToSlice,
  type ModelSlice,
} from '../automerge/projection'
import { pageAllComplete } from '../modelQuery/pageAllComplete'
import type { ExportBundle, ExportModelProvenance, ExportModelSource, ExportScope } from './types'
import { referencedTagSnapshots } from '../tags/assignments'


/** Resolve to `null` instead of hanging when a doc/server never answers —
 * exports must stay usable offline, where an unsynced doc URL can wait forever
 * (`repo.find()` with a network adapter and no peer never settles at all). */
function withTimeout<T>(p: Promise<T>, ms = 4000): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]).catch(() => null)
}

/**
 * Keyset-page a complete read-model collection for ONE workspace; [] when the
 * server is unreachable, and a THROW when it answered part of one.
 *
 * Returning whichever pages had arrived would let a refused middle page produce
 * a truncated model that step 3 below merges and exports to disk with no error
 * at all; swallowing the throw would turn it into an EMPTY export, i.e. a
 * successful download of nothing.
 *
 * `pageAllComplete` keeps the `[]` for "nothing arrived", which is the offline
 * fallback step 4 depends on, and throws for the case in between. Its docblock
 * has the boundary and why it is where it is.
 *
 * `ref` is passed in rather than read from `currentWorkspaceRef()` per page for
 * two reasons: every `/api/model/*` row is keyed by (landscapeId, versionId), so
 * a request without them answers for the DEFAULT landscape (a non-default
 * landscape's export would page 0 rows and look offline) — and
 * capturing the ref once keeps a workspace switch mid-page from splicing two
 * workspaces' entities into one file.
 */
function pageAll<T>(
  ref: WorkspaceRef,
  path: 'page-objects' | 'page-connections',
  key: 'objects' | 'connections',
): Promise<T[]> {
  return pageAllComplete<T>(path, key, {
    workspaceParams: new URLSearchParams({
      landscapeId: ref.landscapeId,
      versionId: ref.versionId,
    }).toString(),
  })
}

/** Merge server-paged entities over the resident window, deduped by id (resident wins). */
function mergeById<T extends { id: string }>(resident: T[], paged: T[]): T[] {
  if (paged.length === 0) return resident
  const seen = new Set(resident.map((e) => e.id))
  return [...resident, ...paged.filter((e) => !seen.has(e.id))]
}

function mergeTagSnapshots<T extends { tagId: string }>(resident: T[], paged: T[]): T[] {
  if (paged.length === 0) return resident
  const seen = new Set(resident.map((snapshot) => snapshot.tagId))
  return [...resident, ...paged.filter((snapshot) => !seen.has(snapshot.tagId))]
}

/** The active landscape's display name, or a plain fallback when unknown. */
export function activeLandscapeName(): string {
  const ws = useWorkspaceStore.getState()
  return ws.landscapes.find((l) => l.id === ws.ref.landscapeId)?.name ?? 'Landscape'
}

/**
 * Materialise every diagram in the landscape (definitions incl. layouts + flows).
 * Sharded topology: registry metas → each DiagramDoc (best-effort, per-doc timeout
 * so one unsynced doc can't hang the export). Falls back to the resident store's
 * diagram list wherever a doc is unavailable.
 */
async function gatherAllDiagrams(
  ref: WorkspaceRef,
): Promise<{ diagrams: Diagram[]; flowsByDiagram: Record<string, Flow[]> }> {
  const s = useModelStore.getState()
  const byId = new Map<string, Diagram>(s.diagrams.map((d) => [d.id, d]))
  const flowsByDiagram: Record<string, Flow[]> = {}
  // The resident store's flows belong to the active diagram window.
  if (s.currentDiagramId) flowsByDiagram[s.currentDiagramId] = s.flows

  const metas = await withTimeout(
    getRegistryShardHandles(ref).then((shards) => mergeShards(shards.map((h) => h.doc() ?? { diagrams: {} }))),
  )
  if (metas) {
    const handles = await Promise.all(
      metas.map((m) =>
        m.docUrl && m.id !== s.currentDiagramId ? withTimeout(findDiagramHandle(m.docUrl)) : Promise.resolve(null),
      ),
    )
    metas.forEach((m, i) => {
      const doc = handles[i]?.doc()
      if (!doc) return
      // name/type come from the REGISTRY META (authoritative since phase B):
      // a list-view rename lands in the meta only, and a doc never activated
      // since keeps its stale name indefinitely — exports must not emit it.
      byId.set(m.id, { ...diagramDocToDiagram(m.id, doc), name: m.name, type: m.type })
      flowsByDiagram[m.id] = diagramDocFlows(doc)
    })
  }

  // Active diagram first — its name leads filenames and summaries.
  const diagrams = [...byId.values()].sort((a, b) =>
    a.id === s.currentDiagramId ? -1 : b.id === s.currentDiagramId ? 1 : 0,
  )
  return { diagrams, flowsByDiagram }
}

/**
 * The whole-landscape entity set, and where it came from.
 *
 * The order below is a ladder, not a preference list: each rung is tried only
 * because the one above it could not answer, and `source` records which one did
 * so a caller can refuse to write a file that is missing most of the model.
 *
 *  1. **shards** — once a workspace has been split (`root.modelMetaUrl`), the
 *     ModelMeta + object/connection shards ARE the model, and they are resident
 *     in IndexedDB, so this rung also works offline. Non-negotiable ordering:
 *     the monolith below is left behind as a frozen pre-split snapshot, and for a
 *     workspace born sharded (`createEmptyRoot({ shardedModel: true })`) it is
 *     created EMPTY and stays that way forever.
 *  2. **monolith** — the legacy topology, and only when its document actually
 *     holds entities. An empty one is ambiguous (frozen snapshot vs. genuinely
 *     empty workspace) and must never end the ladder: reading it as authoritative
 *     is exactly how a 30-object landscape exported 5.
 *  3. **read-model** — the server's projection of the same model, workspace-scoped.
 *     The only source under a static baseline, where the shards hold overlays only.
 *  4. **window** — nothing whole-landscape answered. What is left is the resident
 *     store: complete for the ACTIVE diagram and a fraction of everything else.
 */
async function gatherLandscapeModel(
  ref: WorkspaceRef,
  resident: ModelSlice,
): Promise<{ slice: ModelSlice; source: ExportModelSource }> {
  const root = (await withTimeout(getRootHandle(ref)))?.doc() as RootDoc | undefined

  // 1. Sharded.
  const meta = root?.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl)
    ? ((await withTimeout(findModelMetaHandle(root.modelMetaUrl)))?.doc() as ModelMeta | undefined)
    : undefined
  // A static baseline keeps its entities in the server read model and only
  // overlays in the shards, so the shard union is NOT the model there (rung 3).
  if (meta && !meta.staticBaseline) {
    const [objectShards, connectionShards] = await Promise.all([
      withTimeout(getModelShardHandles<ObjectShard>(meta.objectShardUrls ?? []), 15_000),
      withTimeout(getModelShardHandles<ConnectionShard>(meta.connectionShardUrls ?? []), 15_000),
    ])
    if (objectShards && connectionShards) {
      const model = modelShardsToRootModel(
        meta,
        objectShards.map((h) => h.doc() ?? { objects: {} }),
        connectionShards.map((h) => h.doc() ?? { connections: {} }),
      )
      // Deletes against a base shard live as tombstones on the ModelMeta, not as
      // removals from the shard — without this an export resurrects them.
      for (const id of meta.deletedObjectIds ?? []) delete model.objects[id]
      for (const id of meta.deletedConnectionIds ?? []) delete model.connections[id]
      return { slice: rootModelToSlice(model), source: 'shards' }
    }
  }

  // 2. Monolith, only when it holds something.
  if (root?.modelUrl && isValidAutomergeUrl(root.modelUrl)) {
    const modelDoc = (await withTimeout(getModelHandle(ref)))?.doc()
    if (modelDoc) {
      const slice = rootModelToSlice(modelDoc)
      if (slice.objects.length > 0 || slice.connections.length > 0) return { slice, source: 'monolith' }
    }
  }

  // 3. Server read model.
  const [pagedObjects, pagedConnections] = await Promise.all([
    pageAll<C4Object>(ref, 'page-objects', 'objects'),
    pageAll<Connection>(ref, 'page-connections', 'connections'),
  ])
  if (pagedObjects.length > 0 || pagedConnections.length > 0) {
    return {
      slice: { ...resident, objects: pagedObjects, connections: pagedConnections },
      source: 'read-model',
    }
  }

  // 4. The resident window.
  return { slice: resident, source: 'window' }
}

/** Ids the gathered diagrams name but the gathered entities do not cover — the
 * defect's own signature (a diagram listing objects that aren't in the file), and
 * the only completeness check that does not depend on guessing which rung ran. */
function countMissingReferences(
  diagrams: readonly Diagram[],
  objects: readonly C4Object[],
  connections: readonly Connection[],
  groups: readonly { id: string }[],
): ExportModelProvenance['missing'] {
  const have = {
    objects: new Set(objects.map((o) => o.id)),
    connections: new Set(connections.map((c) => c.id)),
    groups: new Set(groups.map((g) => g.id)),
  }
  const missing = { objects: new Set<string>(), connections: new Set<string>(), groups: new Set<string>() }
  for (const d of diagrams) {
    for (const id of d.objectIds ?? []) if (!have.objects.has(id)) missing.objects.add(id)
    for (const id of d.connectionIds ?? []) if (!have.connections.has(id)) missing.connections.add(id)
    for (const id of d.groupIds ?? []) if (!have.groups.has(id)) missing.groups.add(id)
  }
  return { objects: missing.objects.size, connections: missing.connections.size, groups: missing.groups.size }
}

/**
 * Gather everything the exporters need. Never throws for a missing server or
 * unsynced doc — offline it degrades to the resident window (always complete
 * for the active diagram) plus whatever is materialised locally, and SAYS SO in
 * `bundle.model` so a landscape-wide export can refuse rather than write a
 * plausible-looking file with most of the model missing.
 */
export async function gatherExportBundle(scope: ExportScope): Promise<ExportBundle> {
  const s = useModelStore.getState()
  const generatedAt = new Date().toISOString()
  const landscapeName = activeLandscapeName()

  if (scope === 'diagram') {
    const diagram = s.diagrams.find((d) => d.id === s.currentDiagramId) ?? s.diagrams[0]
    const objectIds = new Set(diagram?.objectIds ?? [])
    const connectionIds = new Set(diagram?.connectionIds ?? [])
    const groupIds = new Set(diagram?.groupIds ?? [])
    const objects = s.objects.filter((o) => objectIds.has(o.id))
    return {
      landscapeName,
      generatedAt,
      diagrams: diagram ? [diagram] : [],
      activeDiagramId: diagram?.id ?? null,
      flowsByDiagram: diagram ? { [diagram.id]: s.flows } : {},
      objects,
      connections: s.connections.filter((c) => connectionIds.has(c.id)),
      groups: s.groups.filter((g) => groupIds.has(g.id)),
      domains: s.domains,
      tags: referencedTagSnapshots(objects, s.tags),
      decisionRecords: [],
    }
  }

  // Landscape scope. EVERY document is resolved for the ACTIVE workspace: the
  // repo's getters default to DEFAULT_WORKSPACE_REF, which resolves the 'default'
  // landscape's documents from inside another landscape — and, because
  // getRootHandle also routes the network, re-points the live sync socket at
  // `landscapeId=default` for the rest of the session.
  const ref = currentWorkspaceRef()
  const { diagrams, flowsByDiagram } = await gatherAllDiagrams(ref)

  const resident: ModelSlice = {
    objects: s.objects,
    connections: s.connections,
    groups: s.groups,
    domains: s.domains,
    tagSnapshots: s.tags,
    decisionRecords: s.decisionRecords,
  }
  const { slice, source } = await gatherLandscapeModel(ref, resident)

  // The resident store is the projector's truth (exactly what the canvas and
  // pages show) — it always wins, including edits not yet flushed to a shard.
  // The whole-landscape source only ADDS what the active window doesn't hold.
  const objects = mergeById(resident.objects, slice.objects)
  const connections = mergeById(resident.connections, slice.connections)
  const groups = mergeById(resident.groups, slice.groups)
  const domains = mergeById(resident.domains, slice.domains)
  const tags = mergeTagSnapshots(resident.tagSnapshots, slice.tagSnapshots)
  const decisionRecords = mergeById(resident.decisionRecords, slice.decisionRecords)

  return {
    landscapeName,
    generatedAt,
    diagrams,
    activeDiagramId: s.currentDiagramId,
    flowsByDiagram,
    objects,
    connections,
    groups,
    domains,
    tags,
    decisionRecords,
    model: {
      source,
      missing: countMissingReferences(diagrams, objects, connections, groups),
    },
  }
}
