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

// Build a GOAL-SHAPED diagram to load-test against.
//
// The goal is 10-500 shapes and 10-1 000 connections per diagram. A typical dev
// workspace's heaviest diagram is far lighter, so a run against it would pass
// while proving nothing about the target. This mints a diagram of the requested
// shape and REGISTERS it, because an unreferenced document is quarantined by
// docScope ("unindexed/unlinked doc") and other peers could not open it.
//
// Only the DiagramDoc is synthesised. The referenced C4 objects are NOT created
// in the model shards: this harness measures DIAGRAM DOCUMENT sync, and the
// objects matter to rendering, not to the sync plane. A run whose purpose is
// render cost must seed the model too — say so rather than reusing this.

/** The DiagramDoc payload. Mirrors `DiagramDoc` (src/lib/automerge/types.ts)
 * — `Diagram` minus `id`, plus comments/flows/checkpoints, which live in the
 * SAME document and are part of what makes it heavy. */
export function buildGoalDiagramDoc({
  name = 't1-bench',
  shapes = 500,
  connections = 800,
  type = 'container',
} = {}) {
  const objectIds = Array.from({ length: shapes }, (_, i) => `t1-obj-${i}`)
  const connectionIds = Array.from({ length: connections }, (_, i) => `t1-conn-${i}`)
  const layouts = {}
  // A plausible grid: position is what the load generator will move, so the
  // starting values have to be real numbers rather than zeros.
  const perRow = Math.max(1, Math.ceil(Math.sqrt(shapes)))
  objectIds.forEach((id, index) => {
    layouts[id] = {
      position: { x: (index % perRow) * 220, y: Math.floor(index / perRow) * 140 },
      size: { width: 180, height: 100 },
    }
  })
  return {
    name,
    type,
    description: 'T1 load-test diagram — synthetic, safe to delete',
    objectIds,
    connectionIds,
    groupIds: [],
    layouts,
    comments: {},
    flows: {},
    checkpoints: [],
  }
}

/** The registry stub. Shape from `DiagramMeta` (src/lib/automerge/types.ts).
 * `objectIds`/`connectionIds` are the denormalised composition the registry
 * carries so cross-diagram queries resolve without loading the DiagramDoc —
 * which is also what lets `pickDiagram` weigh a diagram without opening it. */
export function buildDiagramMeta(id, docUrl, doc) {
  return {
    id,
    name: doc.name,
    type: doc.type,
    docUrl,
    objectIds: [...doc.objectIds],
    connectionIds: [...doc.connectionIds],
    groupIds: [],
  }
}

/** Which object ids each peer will move.
 *
 * `shared` puts every peer on the SAME few objects — the contended case, which
 * has measured roughly twice the convergence time. `disjoint` gives each
 * peer its own slice, the optimistic case. Running only one of them would
 * answer half the question, so the harness takes it as a knob and the report
 * records which was used.
 */
export function assignTargets(objectIds, peerCount, { mode = 'shared', sharedWidth = 10 } = {}) {
  const ids = objectIds ?? []
  if (ids.length === 0 || peerCount < 1) return []
  if (mode === 'shared') {
    const pool = ids.slice(0, Math.max(1, Math.min(sharedWidth, ids.length)))
    return Array.from({ length: peerCount }, () => [...pool])
  }
  if (mode === 'disjoint') {
    const perPeer = Math.max(1, Math.floor(ids.length / peerCount))
    return Array.from({ length: peerCount }, (_, peer) => {
      const start = (peer * perPeer) % ids.length
      const slice = ids.slice(start, start + perPeer)
      return slice.length > 0 ? slice : [ids[peer % ids.length]]
    })
  }
  throw new Error(`unknown contention mode ${mode}`)
}
