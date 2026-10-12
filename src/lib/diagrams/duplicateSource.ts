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

import type { Diagram, Flow } from '../../types'
import { useModelStore } from '../../stores/modelStore'
import { findDiagramHandle, getRegistryShardHandles } from '../automerge/repo'
import { diagramDocFlows, diagramDocToDiagram, mergeShards } from '../automerge/projection'
import { fetchDiagramMeta } from '../modelQuery/diagramMeta'

/**
 * Resolving the diagram to copy is the whole difficulty of duplication.
 *
 * The store does NOT hold a usable copy of a diagram that is not the active
 * one. `resolveDiagramProjection` falls back to `metaToStubDiagram`, which
 * carries composition (from the denormalised registry meta) but **no
 * `layouts`** — placement lives in the diagram's own unloaded DiagramDoc. Every
 * card in the diagrams list except the selected one is such a stub.
 *
 * Duplicating a stub therefore yields a diagram with the right shapes at the
 * wrong places: each object falls back to its model-level `position`, so a
 * carefully arranged view comes back as a pile. It looks like a successful
 * duplicate, which is exactly what makes it worth refusing.
 */
export interface DiagramDuplicateSource {
  diagram: Diagram
  flows: Flow[]
  /** Which tier answered — for the log line, and to make the tests specific. */
  via: 'store' | 'document'
}

/**
 * A diagram is copyable only once we can see where its members sit.
 *
 * This guard exists because a stub is easy to mistake for a document. The first
 * version of this file trusted `/api/model/diagram-meta`, whose payload looks
 * like a `Diagram` and destructures like one — but the server returns the
 * REGISTRY META there (`id`, `name`, `type`, the three composition arrays,
 * `parentObjectId`) and never the placement. Duplicating from it produced a
 * copy whose every shape collapsed to the model-level 0,0 default, and nothing
 * about the result said so. Assert the property, not the provenance.
 */
function hasPlacement(diagram: Diagram): boolean {
  const members = [...diagram.objectIds, ...diagram.groupIds]
  if (members.length === 0) return true // an empty diagram has nothing to place
  const layouts = diagram.layouts
  return Boolean(layouts) && members.some((id) => layouts![id] !== undefined)
}

/** Never hang the click: an unsynced doc URL with no peer can wait forever
 *  (`repo.find` with a network adapter attached and no peer never settles). */
function withTimeout<T>(p: Promise<T>, ms = 4000): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]).catch(() => null)
}

/**
 * The diagram's document URL. Two sources, because neither covers every mode:
 * the resident registry shards are absent whenever the registry is summary-only
 * (boot-from-server, and any server-paged diagram list), and the server is
 * absent offline.
 */
async function docUrlFor(diagramId: string): Promise<string | undefined> {
  const shards = await withTimeout(getRegistryShardHandles())
  if (shards) {
    const metas = mergeShards(shards.map((h) => h.doc() ?? { diagrams: {} }))
    const url = metas.find((m) => m.id === diagramId)?.docUrl
    if (url) return url
  }
  // `diagram-meta` carries the registry entry, layouts NOT included — we want it
  // only for the `docUrl` that leads to the document that does have them.
  return (await withTimeout(fetchDiagramMeta(diagramId)))?.meta.docUrl || undefined
}

/**
 * Materialise a diagram completely enough to copy it, or resolve `null`.
 *
 * `null` means "we could not see this diagram's layout", not "no such diagram" —
 * the caller must refuse rather than produce a plausible-looking wrong copy.
 */
export async function loadDiagramDuplicateSource(
  diagramId: string,
): Promise<DiagramDuplicateSource | null> {
  const state = useModelStore.getState()

  // 1. The active diagram is fully resident, including edits not yet flushed to
  //    its document. It is the only tier that can be ahead of storage.
  if (diagramId === state.currentDiagramId) {
    const diagram = state.diagrams.find((d) => d.id === diagramId)
    if (diagram && hasPlacement(diagram)) {
      return { diagram, flows: state.flows.filter((f) => f.diagramId === diagramId), via: 'store' }
    }
  }

  // 2. The diagram's own document — the only thing that holds `layouts` for a
  //    diagram nobody has open. Works offline for any document the local repo
  //    already holds.
  const url = await docUrlFor(diagramId)
  if (url) {
    const handle = await withTimeout(findDiagramHandle(url))
    const doc = handle?.doc()
    // name/type come from the store's projection (meta-authoritative since
    // phase B): duplicating a renamed-but-never-activated diagram must copy
    // the rename, not the doc's stale name.
    const stub = useModelStore.getState().diagrams.find((d) => d.id === diagramId)
    const diagram = doc && {
      ...diagramDocToDiagram(diagramId, doc),
      ...(stub ? { name: stub.name, type: stub.type } : {}),
    }
    if (diagram && hasPlacement(diagram)) {
      return { diagram, flows: diagramDocFlows(doc), via: 'document' }
    }
  }

  return null
}
