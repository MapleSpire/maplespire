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
 * Every cross-entity reference in the model, declared once.
 *
 * Before this file the same question — "what happens to a reference when its
 * target is deleted?" — was answered independently at each writer, and the three
 * answers in the codebase (sweep the referrer, tombstone the target, tolerate
 * the miss at read time) were chosen by whoever wrote the delete. That is how
 * `deleteGroup` came to sweep `groupIds` but not `connections`, and how a
 * decision record kept a clickable chip pointing at a deleted diagram.
 *
 * The registry is data, not behaviour: it is the checklist a delete path, a read
 * path and the server-side integrity scan are each measured against. The
 * resolver that implements `lazy3` lives in `./resolve`.
 */

export type RefPolicy =
  /** The writer removes the reference. Valid ONLY where every referrer is
   *  provably resident — a windowed collection makes the sweep silently partial. */
  | 'eager'
  /** Eager sweep plus a durable proof-of-death, so a referrer that was off-window
   *  at delete time still learns the target is gone. */
  | 'tombstone'
  /** Resolved at read time through `resolveRef`, in three states. */
  | 'lazy3'
  /** Not a reference: an owned child that lives inside its parent's document and
   *  dies with it. The obligation is disclosure before the delete, not repair. */
  | 'cascade'
  /** A copy of data owned by another SYSTEM (catalog, org directory). No local
   *  target exists, so it is never resolved, never validated, never repaired. */
  | 'snapshot'
  /** No model target at all — an external URL. Validated for SHAPE (is it a safe
   *  web address?), never for existence. */
  | 'sanitize'

export interface ReferenceDescriptor {
  /** `${source}.${field}`, unique across the registry. */
  id: string
  source: string
  field: string
  /** Collection the id points into, or the foreign system for `snapshot`. */
  target: string
  cardinality: 'one' | 'many'
  policy: RefPolicy
  /**
   * True when the TARGET collection can be windowed on this client, so a miss
   * never proves absence. Every `true` here is a reference whose resolver must
   * be able to answer `unknown`.
   */
  windowedTarget: boolean
  /** Why this row is what it is. Every non-`lazy3` row states its exception. */
  note: string
}

export const REFERENCE_REGISTRY: readonly ReferenceDescriptor[] = [
  // ── Diagram → model ────────────────────────────────────────────────────────
  {
    id: 'diagram.objectIds',
    source: 'diagram', field: 'objectIds', target: 'object',
    cardinality: 'many', policy: 'tombstone', windowedTarget: false,
    note: 'deleteObject sweeps the resident registry; deletedObjectIds carries the proof to diagrams that were off-window at delete time.',
  },
  {
    id: 'diagram.connectionIds',
    source: 'diagram', field: 'connectionIds', target: 'connection',
    cardinality: 'many', policy: 'tombstone', windowedTarget: false,
    note: 'Same path as objectIds, via deletedConnectionIds.',
  },
  {
    id: 'diagram.groupIds',
    source: 'diagram', field: 'groupIds', target: 'group',
    cardinality: 'many', policy: 'eager', windowedTarget: false,
    note: 'Sweep only — there is no deletedGroupIds tombstone yet, so a group deleted while a diagram is off-window survives in that diagram\'s registry meta.',
  },
  {
    id: 'diagram.layouts',
    source: 'diagram', field: 'layouts', target: 'object|group|connection',
    cardinality: 'many', policy: 'eager', windowedTarget: false,
    note: 'A placement key is membership, not existence: a stale key resurrects an old position when the same id is re-added by undo, import or a draft merge.',
  },
  {
    id: 'diagram.layouts3d',
    source: 'diagram', field: 'layouts3d', target: 'object|group|connection',
    cardinality: 'many', policy: 'eager', windowedTarget: false,
    note: 'The 3D layer of diagram.layouts, swept by the same writers.',
  },
  {
    id: 'diagram.objectScopes',
    source: 'diagram', field: 'objectScopes', target: 'object',
    cardinality: 'many', policy: 'eager', windowedTarget: false,
    note: 'Per-diagram internal/external overrides, swept with layouts by deleteObject, deleteSelectedItems and the server stripIdsFromAllDiagrams: a stale key would re-apply an old override when the same id comes back. Keys are deleted, the map never is (a deleted Automerge map drops a peer\'s concurrent write).',
  },
  {
    id: 'diagram.parentObjectId',
    source: 'diagram', field: 'parentObjectId', target: 'object',
    cardinality: 'one', policy: 'lazy3', windowedTarget: false,
    note: 'No writer clears it. An orphaned detail diagram must say so rather than silently losing its way up.',
  },
  {
    id: 'diagram.domainId',
    source: 'diagram', field: 'domainId', target: 'domain',
    cardinality: 'one', policy: 'eager', windowedTarget: false,
    note: 'deleteDomain sweeps it — but deleteDomain has zero callers and there is no delete_domain AI tool, so this path is currently unreachable.',
  },
  {
    id: 'diagram.skinId',
    source: 'diagram', field: 'skinId', target: 'skin',
    cardinality: 'one', policy: 'lazy3', windowedTarget: true,
    note: 'Already lazy-tolerated by getResolvedSkin, but binary: it cannot tell an uninstalled skin from a plugin registry that has not loaded yet.',
  },

  // ── Diagram ← owned children ───────────────────────────────────────────────
  {
    id: 'comment.diagramId',
    source: 'comment', field: 'diagramId', target: 'diagram',
    cardinality: 'one', policy: 'cascade', windowedTarget: false,
    note: 'Comments live inside the DiagramDoc, so this can never dangle durably. The gap is disclosure: deleting a diagram destroys them with no warning.',
  },
  {
    id: 'flow.diagramId',
    source: 'flow', field: 'diagramId', target: 'diagram',
    cardinality: 'one', policy: 'cascade', windowedTarget: false,
    note: 'Same ownership as comment.diagramId.',
  },
  {
    id: 'messageStep.fromObjectId',
    source: 'messageStep', field: 'fromObjectId', target: 'object',
    cardinality: 'one', policy: 'lazy3', windowedTarget: false,
    note: 'No delete path reads state.flows, so a step keeps citing a deleted shape and renders as a bare "?".',
  },
  {
    id: 'messageStep.toObjectId',
    source: 'messageStep', field: 'toObjectId', target: 'object',
    cardinality: 'one', policy: 'lazy3', windowedTarget: false,
    note: 'See messageStep.fromObjectId.',
  },
  {
    id: 'messageStep.connectionId',
    source: 'messageStep', field: 'connectionId', target: 'connection',
    cardinality: 'one', policy: 'lazy3', windowedTarget: false,
    note: 'See messageStep.fromObjectId; a dead id makes focusOnFlowStep a silent no-op.',
  },
  {
    id: 'processStep.objectId',
    source: 'processStep', field: 'objectId', target: 'object',
    cardinality: 'one', policy: 'lazy3', windowedTarget: false,
    note: 'See messageStep.fromObjectId.',
  },

  // ── Decision records ───────────────────────────────────────────────────────
  {
    id: 'decisionRecord.related.diagram',
    source: 'decisionRecord', field: 'related[type=diagram].targetId', target: 'diagram',
    cardinality: 'many', policy: 'lazy3', windowedTarget: true,
    note: 'Under a server-fed registry summary the resident diagram list is one entry, so a miss proves nothing — this is the archetypal unknown.',
  },
  {
    id: 'decisionRecord.related.adr',
    source: 'decisionRecord', field: 'related[type=adr|draft].targetId', target: 'decisionRecord',
    cardinality: 'many', policy: 'lazy3', windowedTarget: true,
    note: 'deleteDecisionRecord sweeps nothing, and the ADR list is a bounded 2 000-row page.',
  },
  {
    id: 'decisionRecord.related.url',
    source: 'decisionRecord', field: 'related[type=url].url', target: 'external',
    cardinality: 'many', policy: 'sanitize', windowedTarget: false,
    note: 'No model target: safeExternalHref decides, and reachability is explicitly out of scope. Do not add link-checking.',
  },

  // ── Groups & connections ───────────────────────────────────────────────────
  {
    id: 'group.parentObjectId',
    source: 'group', field: 'parentObjectId', target: 'object',
    cardinality: 'one', policy: 'lazy3', windowedTarget: false,
    note: 'deleteObject never clears it, so the canvas keeps painting wrapper chrome and a live "create detail diagram" control anchored to a deleted object.',
  },
  {
    id: 'connection.fromId',
    source: 'connection', field: 'fromId', target: 'object|group',
    cardinality: 'one', policy: 'eager', windowedTarget: false,
    note: 'Both endpoint kinds must be swept; a group endpoint left behind renders as "Unknown -> Unknown" on Model Connections.',
  },
  {
    id: 'connection.toId',
    source: 'connection', field: 'toId', target: 'object|group',
    cardinality: 'one', policy: 'eager', windowedTarget: false,
    note: 'See connection.fromId.',
  },
  {
    id: 'object.parentId',
    source: 'object', field: 'parentId', target: 'object',
    cardinality: 'one', policy: 'lazy3', windowedTarget: false,
    note: 'DELIBERATE client/server asymmetry: the server refuses-or-cascades because it materialises the whole model; the client cannot enumerate off-window children, so both read paths re-root a dangling parent instead.',
  },

  // ── Snapshots: cross-SYSTEM, never resolved ────────────────────────────────
  {
    id: 'object.technologyUsages.technologyId',
    source: 'object', field: 'technologyUsages[].technologyId', target: 'technologyCatalog',
    cardinality: 'many', policy: 'snapshot', windowedTarget: false,
    note: 'An offline client cannot observe a catalog delete, and there is no local target to tombstone. The snapshot is the contract.',
  },
  {
    id: 'object.ownerAssignments.catalogId',
    source: 'object', field: 'ownerAssignments[].catalogId', target: 'orgTeam|platformUser',
    cardinality: 'many', policy: 'snapshot', windowedTarget: false,
    note: 'Ownership stays readable and editable while offline; that is why the snapshot exists.',
  },
  {
    id: 'object.tagAssignments.groupId',
    source: 'object', field: 'tagAssignments[].snapshot.groupId', target: 'tagCatalog',
    cardinality: 'many', policy: 'snapshot', windowedTarget: false,
    note: 'Same family as technologyUsages.',
  },
  {
    id: 'object.ownerTeamIds',
    source: 'object', field: 'ownerTeamIds', target: 'orgTeam',
    cardinality: 'many', policy: 'snapshot', windowedTarget: false,
    note: 'The genuine misfit: raw ids with NO snapshot and no sweep, so a deleted team keeps a hashed colour segment and its own perspective row. Fix the DATA (derive from ownerAssignments), not the policy.',
  },
  {
    id: 'object.teamIds',
    source: 'object', field: 'teamIds', target: 'orgTeam',
    cardinality: 'many', policy: 'snapshot', windowedTarget: false,
    note: 'See object.ownerTeamIds.',
  },
]

const BY_ID = new Map(REFERENCE_REGISTRY.map((entry) => [entry.id, entry]))

export function referenceDescriptor(id: string): ReferenceDescriptor | undefined {
  return BY_ID.get(id)
}

/** Every reference that points INTO a collection — the delete-path checklist. */
export function referencesInto(target: string): ReferenceDescriptor[] {
  return REFERENCE_REGISTRY.filter((entry) => entry.target.split('|').includes(target))
}

/** Every reference a collection owns — the read-path checklist. */
export function referencesFrom(source: string): ReferenceDescriptor[] {
  return REFERENCE_REGISTRY.filter((entry) => entry.source === source)
}
