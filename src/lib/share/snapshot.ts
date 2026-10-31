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
import type { Flow, C4Object, Connection } from '../../types'
import type { DiagramDoc } from '../automerge/types'
import { previewAt } from '../automerge/history'
import { diagramDocToDiagram, diagramDocFlows, rootModelToSlice, mergeShards, type ModelSlice } from '../automerge/projection'
import { getActiveDiagramHandle } from '../automerge/bridge'
import { getModelHandle, getRegistryShardHandles, findDiagramHandle, getRootHandle } from '../automerge/repo'
import { useModelStore } from '../../stores/modelStore'
import { bakeShareScopes, toShareDiagram, sliceModelForShare } from './sliceModel'
import { pageAllComplete } from '../modelQuery/pageAllComplete'
import { workspaceSearchParams } from '../modelQuery/workspaceParams'
import type { ShareSnapshot, ShareDiagram } from './types'


/** Keyset-page an entire read-model collection from the server (the complete,
 * un-windowed model) FOR THE ACTIVE WORKSPACE. Every `/api/model/*` row is keyed
 * by (landscapeId, versionId): a request without them is answered for the default
 * landscape. Captured once, before the loop, so a workspace switch mid-page
 * cannot splice two landscapes into one snapshot.
 *
 * THROWS on a partial collection: a share snapshot is PERSISTED and
 * version-pinned, so a truncated one is not a bad download the user can repeat
 * — it is what the link serves from then on. */
function pageAll<T>(path: 'page-objects' | 'page-connections', key: 'objects' | 'connections'): Promise<T[]> {
  return pageAllComplete<T>(path, key, { workspaceParams: workspaceSearchParams().toString() })
}

/**
 * The full model to slice the share snapshot from.
 *
 * A SINGLE-DIAGRAM share ("share this view") only needs the active diagram's entities,
 * which the RESIDENT STORE always holds — it's exactly what the editor renders, in every
 * topology (monolith, sharded, read-model, boot-from-server). Sourcing it from the store
 * avoids the blank-share bug: the monolithic ModelDoc at `root.modelUrl` can be EMPTY
 * (a frozen pre-split snapshot when sharded, or never-materialised when the model is fed
 * from the server read model) even while the editor is full — reading it would emit a
 * snapshot whose diagram references objects that aren't in `model.objects`, so the viewer
 * renders nothing.
 *
 * A WHOLE-LANDSCAPE share needs every diagram's entities; the resident store may be
 * windowed, so prefer the full monolithic ModelDoc when it actually holds the model, else
 * page the complete object/connection set from the server read model, else fall back to
 * the resident store.
 */
async function fullModelForShare(limitToDiagram: boolean): Promise<ModelSlice> {
  const s = useModelStore.getState()
  const resident: ModelSlice = {
    objects: s.objects,
    connections: s.connections,
    groups: s.groups,
    domains: s.domains,
    tagSnapshots: s.tags,
    decisionRecords: s.decisionRecords,
  }
  if (limitToDiagram) return resident

  const root = (await getRootHandle()).doc()
  const isSharded = !!(root?.modelMetaUrl && isValidAutomergeUrl(root.modelMetaUrl))
  if (!isSharded && root?.modelUrl && isValidAutomergeUrl(root.modelUrl)) {
    const modelDoc = (await getModelHandle()).doc()
    if (modelDoc) {
      const slice = rootModelToSlice(modelDoc)
      if (slice.objects.length > 0) return slice
    }
  }
  const [objects, connections] = await Promise.all([
    pageAll<C4Object>('page-objects', 'objects'),
    pageAll<Connection>('page-connections', 'connections'),
  ])
  return {
    ...resident,
    objects: objects.length ? objects : resident.objects,
    connections: connections.length ? connections : resident.connections,
  }
}

export interface BuildSnapshotOptions {
  /** The diagram the link lands on (the active diagram). */
  rootDiagramId: string
  /** true = only this diagram; false = the whole landscape (all diagrams). */
  limitToDiagram: boolean
  /** Empty/undefined = current heads (latest); non-empty = pin the ROOT diagram. */
  heads?: string[]
  checkpointLabel?: string
}

/** All diagram metadata (id + docUrl) across the registry shards. */
async function allDiagramMetas() {
  const shards = await getRegistryShardHandles()
  return mergeShards(shards.map((h) => h.doc() ?? { diagrams: {} }))
}

/**
 * Materialise a self-contained, read-only snapshot: just the active diagram when
 * `limitToDiagram`, or every diagram in the landscape otherwise. Contains only the
 * referenced model entities — never comments, decision records or history. The
 * root diagram honours `heads` (pinned version); other diagrams use current heads.
 */
export async function buildShareSnapshot(opts: BuildSnapshotOptions): Promise<ShareSnapshot> {
  const rootId = opts.rootDiagramId
  const heads = opts.heads ?? []

  const diagrams: ShareDiagram[] = []
  const flowsByDiagram: Record<string, Flow[]> = {}

  const addDoc = (id: string, doc: DiagramDoc, meta?: { name: string; type: DiagramDoc['type'] }) => {
    // name/type come from the registry meta when provided (authoritative
    // since phase B — a list-view rename never reaches a non-activated doc).
    // The root/pinned case deliberately keeps the DOC's values: a share
    // pinned to historical heads should show that history's name.
    const diagram = diagramDocToDiagram(id, doc)
    diagrams.push(toShareDiagram(meta ? { ...diagram, name: meta.name, type: meta.type } : diagram))
    flowsByDiagram[id] = diagramDocFlows(doc)
  }

  // Root (active) diagram — honour the pinned heads if any.
  const rootHandle = getActiveDiagramHandle()
  if (!rootHandle) throw new Error('No active diagram to share')
  const rootDoc = heads.length ? previewAt(rootHandle, heads) : rootHandle.doc()
  if (!rootDoc) throw new Error('Could not read the diagram document')
  addDoc(rootId, rootDoc)

  // Whole-landscape: materialise every OTHER diagram at its current heads.
  if (!opts.limitToDiagram) {
    const others = (await allDiagramMetas()).filter((m) => m.id !== rootId && m.docUrl)
    const handles = await Promise.all(others.map((m) => findDiagramHandle(m.docUrl).catch(() => null)))
    others.forEach((m, i) => {
      const doc = handles[i]?.doc()
      if (doc) addDoc(m.id, doc, { name: m.name, type: m.type })
    })
  }

  const fullModel = await fullModelForShare(opts.limitToDiagram)
  bakeShareScopes(diagrams, fullModel.objects)
  const model = sliceModelForShare(diagrams, {
    objects: fullModel.objects,
    connections: fullModel.connections,
    groups: fullModel.groups,
    tags: fullModel.tagSnapshots,
  })

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    rootDiagramId: rootId,
    limitToDiagram: opts.limitToDiagram,
    diagrams,
    model,
    flowsByDiagram,
    meta: opts.checkpointLabel ? { checkpointLabel: opts.checkpointLabel } : undefined,
  }
}
