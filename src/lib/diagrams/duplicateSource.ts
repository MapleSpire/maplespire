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
import { isValidAutomergeUrl, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import { findDiagramHandle, getRegistryShardHandles, releaseDocumentRequest } from '../automerge/repo'
import { diagramDocFlows, diagramDocToDiagram, mergeShards } from '../automerge/projection'
import { fetchDiagramMeta } from '../modelQuery/diagramMeta'
import type { DiagramDoc } from '../automerge/types'

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
 *
 * `serverFirst` asks the server before walking the shards. On a summary-only
 * registry the walk resolves and pins EVERY registry shard — the cost that mode
 * exists to avoid. A duplicate is rare enough to pay it; an inline expansion
 * runs on every "Expand here", so it asks the server and walks only offline.
 */
async function docUrlFor(diagramId: string, serverFirst = false): Promise<string | undefined> {
  // `diagram-meta` carries the registry entry, layouts NOT included — we want it
  // only for the `docUrl` that leads to the document that does have them.
  const fromServer = async () => (await withTimeout(fetchDiagramMeta(diagramId)))?.meta.docUrl || undefined
  if (serverFirst) {
    const url = await fromServer()
    if (url) return url
  }
  const shards = await withTimeout(getRegistryShardHandles())
  if (shards) {
    const metas = mergeShards(shards.map((h) => h.doc() ?? { diagrams: {} }))
    const url = metas.find((m) => m.id === diagramId)?.docUrl
    if (url) return url
  }
  return serverFirst ? undefined : fromServer()
}

/**
 * A non-active diagram's placement, read from its own document — the same
 * resolution a duplicate needs, for an inline expansion (`expandInline.ts`).
 *
 * `null` means the document could not be reached (offline and never synced
 * here, or no URL from either source). A reachable document with no `layouts`
 * resolves `{}`: its shapes sit at their model positions, as they do when that
 * diagram is opened, so that is not the same answer as "unknown".
 *
 * A deep copy: the planner hands these objects to the engine, which owns its
 * shapes' geometry, and a frozen document snapshot is not something to share.
 */
export async function loadDiagramLayouts(
  diagramId: string,
): Promise<NonNullable<Diagram['layouts']> | null> {
  const url = await docUrlFor(diagramId, true)
  if (!url) return null
  const handle = await withTimeout(findDiagramHandle(url))
  const doc = handle?.doc()
  if (!doc) return null
  return structuredClone(diagramDocToDiagram(diagramId, doc).layouts ?? {})
}

/** The lease an inline expansion holds on its target's document. Its own role,
 *  because it is RELEASED on close; the default role is the bridge's. */
export const INLINE_EXPANSION_ROLE = 'inline-expansion'

/**
 * One lease ROLE per session (`inline-expansion:<n>`). The registry keeps one
 * token per (session, role), not a count, so two sessions on one document under
 * one role would share a token and the first close would stop syncing the
 * other's. Distinct roles need no count of our own — and nothing of ours to
 * outlive the registry, which is cleared on a workspace switch.
 */
let sessionSeq = 0

/** A placement read that stays open: see `openDiagramPlacement`. */
export interface DiagramPlacementSession {
  /** The placement now: a record, or `null` while the document cannot be read. */
  read(): Promise<NonNullable<Diagram['layouts']> | null>
  /** Called when the document changes, and when it arrives after a `read`
   *  gave up on it. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void
  /** Stop listening and give the lease back. Idempotent. */
  close(): void
}

/**
 * `loadDiagramLayouts` for something that stays on screen — an inline
 * expansion, whose placement goes stale when the target is edited or when its
 * bytes arrive after a reconnect.
 *
 * One session per target, opened before the first read, so a change can never
 * fall between a read and the subscription that should have heard it: the
 * document listener is attached the moment the handle resolves, before its
 * contents are read. The URL and the handle are kept, so a later read needs no
 * network once the document has been reached; and the one `find` per session is
 * kept too, so repeated reads of an unreachable document do not stack retry
 * loops. A `find` that outlives a read's timeout is not abandoned: when it
 * lands, subscribers hear about it.
 */
export function openDiagramPlacement(diagramId: string, timeoutMs = 4000): DiagramPlacementSession {
  let closed = false
  let url: string | undefined
  const role = `${INLINE_EXPANSION_ROLE}:${++sessionSeq}`
  /** A find was started, so the lease under `role` is held. */
  let leased = false
  let finding: Promise<DocHandle<DiagramDoc>> | undefined
  let handle: DocHandle<DiagramDoc> | undefined
  /** A read timed out while the find was still running. */
  let gaveUp = false
  const listeners = new Set<() => void>()
  // No `closed` check needed: both callers are already cut off by close
  // (the document listener is removed, the find's handler returns).
  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  const onDocumentChange = () => emit()

  const startFind = (documentUrl: string) => {
    leased = true
    finding = findDiagramHandle(documentUrl, role).then(
      (resolved) => {
        if (closed) return resolved
        handle = resolved
        resolved.on('change', onDocumentChange)
        if (gaveUp) emit()
        return resolved
      },
      (error: unknown) => {
        // Forgotten, so the next read tries again rather than re-reading a
        // rejection for the life of the session.
        finding = undefined
        throw error
      },
    )
    finding.catch(() => {})
  }

  return {
    async read() {
      if (closed) return null
      if (!handle) {
        if (!url) url = await docUrlFor(diagramId, true)
        if (closed || !url) return null
        if (!finding) startFind(url)
        const resolved = await withTimeout(finding!, timeoutMs)
        if (!resolved) {
          // A REJECTED find also reads as null here, but it reset `finding`:
          // it did not outlive the read, so its successor landing inside the
          // next read is not a late arrival (QA lens, reproduced).
          gaveUp = finding !== undefined
          return null
        }
      }
      const doc = handle?.doc()
      if (!doc) return null
      return structuredClone(diagramDocToDiagram(diagramId, doc).layouts ?? {})
    },
    subscribe(onChange) {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
    close() {
      closed = true
      handle?.off('change', onDocumentChange)
      if (leased && url && isValidAutomergeUrl(url)) releaseDocumentRequest(url as AutomergeUrl, role)
      leased = false
    },
  }
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
