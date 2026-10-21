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

import type { C4Object, Connection, Diagram, Flow, Group, SelectedItem } from '../../types'
import {
  changedFields,
  deepEqual,
  entityKey,
  resolvedConnectionField,
  CONNECTION_3D_TWINS,
  type EntityChange,
  type EntityKind,
  type LayoutSpace,
  type MembershipField,
  type ModelDiff,
  type Placement,
} from './modelDiff'

/**
 * Turning a recorded diff into a store mutation, in two phases:
 *
 * 1. `planApply` READS the current state and decides, change by change, what
 *    can be applied. It is the conflict policy, and it is pure.
 * 2. `executePlan` writes the plan into an immer draft, inside ONE `set()`.
 *
 * The split exists because the placement journal must be written BEFORE the
 * store commit (modelStore's `recordPlacementIntent` contract), and the
 * journal needs to know which placements the commit will write.
 *
 * ## Conflict policy — the user only ever undoes their OWN edits
 *
 * Every change carries the value we wrote (`from`). It is applied only if the
 * store still shows that value; otherwise a peer (or a later edit that is not
 * on this stack) changed it since, and their value stays. Per FIELD for
 * entities, per key for layouts, per id for memberships. An entity we created
 * is not removed if something we do not also remove now references it — a
 * connection, its placement on a diagram this change does not cover, a child
 * element, a detail diagram or its wrapper group, a flow step — so undo never
 * cascade-deletes someone else's work. Limit: under boot-from-server only the
 * RESIDENT window is visible here, so a reference a peer made off-window in
 * the seconds since our create is not seen.
 *
 * Restores are refused the same way when what they point at is gone: a
 * connection whose end a peer deleted, a membership of a deleted element.
 *
 * The `applied` diff is the subset that really happened, in the original
 * orientation, so a redo replays exactly what the undo did and nothing else.
 */

export type Direction = 'undo' | 'redo'

export interface ApplyState {
  objects: readonly C4Object[]
  connections: readonly Connection[]
  groups: readonly Group[]
  diagrams: readonly Diagram[]
  /** Flow steps reference shapes and connections; a referenced one is not removed. */
  flows?: readonly Flow[]
  /** The diagram on screen: the only one whose composition an undo may grow. */
  currentDiagramId?: string | null
}

export interface PlacementWrite {
  diagramId: string
  space: LayoutSpace
  id: string
  isGroup: boolean
  value: Placement
}

export interface ApplyPlan {
  restore: Array<{ kind: EntityKind; entity: C4Object | Connection | Group }>
  remove: Array<{ kind: EntityKind; id: string }>
  update: Array<{ kind: EntityKind; id: string; values: Record<string, unknown> }>
  membership: Array<{ diagramId: string; field: MembershipField; id: string; present: boolean }>
  groupMember: Array<{ groupId: string; id: string; present: boolean }>
  /** `value: undefined` removes the key. */
  layout: Array<{ diagramId: string; space: LayoutSpace; id: string; value?: Placement }>
  diagramField: Array<{ diagramId: string; field: string; value: unknown }>
  placementWrites: PlacementWrite[]
  /** What was applied, in the recorded (before → after) orientation. */
  applied: ModelDiff
  /** How many recorded changes could not be applied (a peer got there first). */
  skipped: number
  /** Endpoints whose lower-connection roll-up must be recomputed. */
  endpoints: Set<string>
}

function listFor(state: ApplyState, kind: EntityKind): readonly { id: string }[] {
  return kind === 'object' ? state.objects : kind === 'connection' ? state.connections : state.groups
}

function fieldMatches(kind: EntityKind, current: object, expected: object, field: string): boolean {
  const cur = (current as Record<string, unknown>)[field]
  const exp = (expected as Record<string, unknown>)[field]
  if (deepEqual(cur, exp)) return true
  return kind === 'connection' && field in CONNECTION_3D_TWINS
    && deepEqual(resolvedConnectionField(current, field), resolvedConnectionField(expected, field))
}

export function planApply(diff: ModelDiff, direction: Direction, state: ApplyState): ApplyPlan {
  const plan: ApplyPlan = {
    restore: [], remove: [], update: [], membership: [], groupMember: [], layout: [], diagramField: [],
    placementWrites: [], applied: new Map(), skipped: 0, endpoints: new Set(),
  }
  const undo = direction === 'undo'
  const indexes = new Map<EntityKind, Map<string, { id: string }>>()
  const lookup = (kind: EntityKind, id: string): { id: string } | undefined => {
    let index = indexes.get(kind)
    if (!index) {
      index = new Map(listFor(state, kind).map((entity) => [entity.id, entity]))
      indexes.set(kind, index)
    }
    return index.get(id)
  }
  const diagramById = new Map(state.diagrams.map((diagram) => [diagram.id, diagram]))
  const groupIds = new Set(state.groups.map((group) => group.id))

  // What this apply removes / restores, so cross-references between changes of
  // the same entry are not mistaken for a peer's references.
  const removing = new Set<string>()
  const restoring = new Set<string>()
  const leavingDiagram = new Set<string>()
  const connectionRestores: Connection[] = []
  for (const [key, change] of diff) {
    if (change.type === 'entity') {
      const from = undo ? change.after : change.before
      const to = undo ? change.before : change.after
      if (from && !to) removing.add(key)
      if (!from && to && !lookup(change.kind, change.id)) {
        if (change.kind === 'connection') connectionRestores.push(to as Connection)
        else restoring.add(change.id)
      }
    } else if (change.type === 'membership') {
      const toPresent = undo ? !change.present : change.present
      if (!toPresent) leavingDiagram.add(`${change.diagramId}:${change.field}:${change.id}`)
    }
  }
  /** A shape that will exist once this step is applied. */
  const shapeWillExist = (id: string): boolean =>
    restoring.has(id) || lookup('object', id) !== undefined || lookup('group', id) !== undefined
  // A connection comes back only if BOTH ends exist after this step: a peer may
  // have deleted an endpoint since, and a dangling connection would be written
  // durably and listed as "Unknown → Unknown" on Model Connections.
  for (const c of connectionRestores) {
    if (shapeWillExist(c.fromId) && shapeWillExist(c.toId)) restoring.add(c.id)
  }

  const noteEndpoints = (kind: EntityKind, entity: object | undefined): void => {
    if (!entity) return
    if (kind === 'connection') {
      const c = entity as Connection
      plan.endpoints.add(c.fromId)
      plan.endpoints.add(c.toId)
    } else {
      plan.endpoints.add((entity as { id: string }).id)
    }
  }

  const referencedByFlow = (id: string): boolean =>
    (state.flows ?? []).some((flow) => flow.steps.some((step) => Object.values(step).includes(id)))

  const removable = (kind: EntityKind, id: string): boolean => {
    if (kind === 'connection') {
      // Drawn on a diagram this step does not take it off (a peer added it there).
      for (const diagram of state.diagrams) {
        if (diagram.connectionIds.includes(id) && !leavingDiagram.has(`${diagram.id}:connectionIds:${id}`)) return false
      }
      return !referencedByFlow(id)
    }
    if (referencedByFlow(id)) return false
    if (kind === 'object') {
      // Children, a detail diagram, or the wrapper group of one: removing the
      // parent would leave them pointing at nothing.
      for (const o of state.objects) {
        if (o.parentId === id && !removing.has(entityKey('object', o.id))) return false
      }
      if (state.diagrams.some((diagram) => diagram.parentObjectId === id)) return false
      if (state.groups.some((group) => group.parentObjectId === id && !removing.has(entityKey('group', group.id)))) return false
    }
    for (const c of state.connections) {
      if (c.kind === 'lower') continue
      if (c.fromId !== id && c.toId !== id) continue
      if (!removing.has(entityKey('connection', c.id))) return false
    }
    const field: MembershipField = kind === 'object' ? 'objectIds' : 'groupIds'
    for (const diagram of state.diagrams) {
      if (!diagram[field].includes(id)) continue
      if (!leavingDiagram.has(`${diagram.id}:${field}:${id}`)) return false
    }
    return true
  }

  for (const [key, change] of diff) {
    switch (change.type) {
      case 'entity': {
        const from = undo ? change.after : change.before
        const to = undo ? change.before : change.after
        const current = lookup(change.kind, change.id)
        if (!from && to) {
          if (current || !restoring.has(change.id)) { plan.skipped++; break }
          plan.restore.push({ kind: change.kind, entity: to })
          plan.applied.set(key, change)
          noteEndpoints(change.kind, to)
        } else if (from && !to) {
          if (!current) break // already gone: nothing to do, nothing lost
          if (!removable(change.kind, change.id)) { plan.skipped++; break }
          plan.remove.push({ kind: change.kind, id: change.id })
          plan.applied.set(key, change)
          noteEndpoints(change.kind, current)
        } else if (from && to) {
          if (!current) { plan.skipped++; break }
          const fields = change.fields ?? changedFields(change.kind, change.before!, change.after!)
          const values: Record<string, unknown> = {}
          const appliedFields: string[] = []
          for (const field of fields) {
            if (!fieldMatches(change.kind, current, from, field)) continue
            const value = (to as unknown as Record<string, unknown>)[field]
            // Re-attaching a connection end to a shape a peer deleted since
            // would leave it dangling.
            if (change.kind === 'connection' && (field === 'fromId' || field === 'toId')
              && !shapeWillExist(value as string)) continue
            values[field] = value
            appliedFields.push(field)
          }
          if (appliedFields.length < fields.length) plan.skipped++
          if (appliedFields.length === 0) break
          plan.update.push({ kind: change.kind, id: change.id, values })
          const applied: EntityChange = { ...change, fields: appliedFields }
          plan.applied.set(key, applied)
          if (change.kind === 'connection' && ('fromId' in values || 'toId' in values)) {
            noteEndpoints('connection', current)
            noteEndpoints('connection', to)
          }
          if (change.kind === 'object' && 'parentId' in values) plan.endpoints.add(change.id)
        }
        break
      }
      case 'membership': {
        const diagram = diagramById.get(change.diagramId)
        if (!diagram) { plan.skipped++; break }
        const toPresent = undo ? !change.present : change.present
        if (diagram[change.field].includes(change.id) === toPresent) break
        // An id with nothing behind it draws nothing and can never be selected
        // again (a peer deleted it since): do not put one back.
        // Only the CURRENT diagram's composition is written from the store under
        // a sharded registry; another diagram's is rebuilt from its registry meta
        // (bridge `registryMetaFor`), so an id put back there would show until
        // the next reload and then vanish. Refuse it rather than pretend.
        if (toPresent && state.currentDiagramId !== undefined && change.diagramId !== state.currentDiagramId) {
          plan.skipped++
          break
        }
        if (toPresent) {
          const kind: EntityKind = change.field === 'connectionIds' ? 'connection'
            : change.field === 'groupIds' ? 'group' : 'object'
          if (!lookup(kind, change.id) && !restoring.has(change.id)) {
            plan.skipped++
            break
          }
        }
        plan.membership.push({ diagramId: change.diagramId, field: change.field, id: change.id, present: toPresent })
        plan.applied.set(key, change)
        plan.endpoints.add(change.id)
        break
      }
      case 'groupMember': {
        const group = lookup('group', change.groupId) as Group | undefined
        if (!group) { plan.skipped++; break }
        const toPresent = undo ? !change.present : change.present
        if (group.objectIds.includes(change.id) === toPresent) break
        if (toPresent && !lookup('object', change.id) && !restoring.has(change.id)) { plan.skipped++; break }
        plan.groupMember.push({ groupId: change.groupId, id: change.id, present: toPresent })
        plan.applied.set(key, change)
        plan.endpoints.add(change.id)
        break
      }
      case 'layout': {
        const diagram = diagramById.get(change.diagramId)
        if (!diagram) { plan.skipped++; break }
        const raw = change.space === '2d' ? diagram.layouts?.[change.id] : diagram.layouts3d?.[change.id]
        const shown = change.space === '2d' ? raw : raw ?? diagram.layouts?.[change.id]
        const fromShown = undo ? change.afterResolved : change.beforeResolved
        if (!deepEqual(shown, fromShown)) { plan.skipped++; break }
        const toRaw = undo ? change.before : change.after
        const toShown = undo ? change.beforeResolved : change.afterResolved
        let value: Placement | undefined
        if (toRaw) value = toRaw
        else if (change.space === '3d') {
          // The 3D layer had no key: it showed the 2D placement. Write that as
          // a value (journaled) rather than deleting the key — unless the 3D
          // layer no longer exists at all, in which case it already shows 2D.
          if (!diagram.layouts3d || !toShown) break
          value = toShown
        }
        plan.layout.push({ diagramId: change.diagramId, space: change.space, id: change.id, value })
        if (value) {
          plan.placementWrites.push({
            diagramId: change.diagramId, space: change.space, id: change.id,
            isGroup: groupIds.has(change.id) || (restoring.has(change.id) && diff.has(entityKey('group', change.id))),
            value,
          })
        }
        plan.applied.set(key, change)
        break
      }
      case 'diagramField': {
        const diagram = diagramById.get(change.diagramId)
        if (!diagram) { plan.skipped++; break }
        const current = (diagram as unknown as Record<string, unknown>)[change.field]
        if (!deepEqual(current, undo ? change.after : change.before)) { plan.skipped++; break }
        plan.diagramField.push({ diagramId: change.diagramId, field: change.field, value: undo ? change.before : change.after })
        plan.applied.set(key, change)
        break
      }
    }
  }
  return plan
}

/** Mutable view of the store slices `executePlan` writes (an immer draft). */
export interface ApplyDraft {
  objects: C4Object[]
  connections: Connection[]
  groups: Group[]
  diagrams: Diagram[]
  selectedItems: SelectedItem[]
  pendingDeletedObjectIds: string[]
  pendingDeletedConnectionIds: string[]
  pendingDeletedGroupIds: string[]
}

function assign(target: object, values: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined) delete (target as Record<string, unknown>)[field]
    else (target as Record<string, unknown>)[field] = value
  }
}

/** Write a plan into a draft. One call = one store transaction. */
export function executePlan(draft: ApplyDraft, plan: ApplyPlan): void {
  const pending = {
    object: 'pendingDeletedObjectIds',
    connection: 'pendingDeletedConnectionIds',
    group: 'pendingDeletedGroupIds',
  } as const

  // 1. Restores. A FRESH copy, never the recorded reference: the bridge only
  //    writes an entity whose reference differs from what it last rendered, and
  //    a restored entity must be written (it lifts the tombstone).
  for (const { kind, entity } of plan.restore) {
    const list = (kind === 'object' ? draft.objects : kind === 'connection' ? draft.connections : draft.groups) as Array<{ id: string }>
    list.push({ ...entity })
    const intents = draft[pending[kind]]
    if (intents.includes(entity.id)) draft[pending[kind]] = intents.filter((id) => id !== entity.id)
  }

  // 2. Field updates.
  if (plan.update.length) {
    const byKind = {
      object: new Map(draft.objects.map((e) => [e.id, e as object])),
      connection: new Map(draft.connections.map((e) => [e.id, e as object])),
      group: new Map(draft.groups.map((e) => [e.id, e as object])),
    }
    for (const { kind, id, values } of plan.update) {
      const entity = byKind[kind].get(id)
      if (entity) assign(entity, values)
    }
  }

  // 3. Memberships and placements.
  const diagramById = new Map(draft.diagrams.map((diagram) => [diagram.id, diagram]))
  for (const { diagramId, field, id, present } of plan.membership) {
    const diagram = diagramById.get(diagramId)
    if (!diagram) continue
    if (present) { if (!diagram[field].includes(id)) diagram[field].push(id) }
    else diagram[field] = diagram[field].filter((x) => x !== id)
  }
  if (plan.groupMember.length) {
    const groupById = new Map(draft.groups.map((group) => [group.id, group]))
    for (const { groupId, id, present } of plan.groupMember) {
      const group = groupById.get(groupId)
      if (!group) continue
      if (present) { if (!group.objectIds.includes(id)) group.objectIds.push(id) }
      else group.objectIds = group.objectIds.filter((x) => x !== id)
    }
  }
  for (const { diagramId, space, id, value } of plan.layout) {
    const diagram = diagramById.get(diagramId)
    if (!diagram) continue
    if (value) {
      const map = space === '2d' ? (diagram.layouts ??= {}) : (diagram.layouts3d ??= {})
      map[id] = { position: { ...value.position }, size: { ...value.size } }
    } else {
      const map = space === '2d' ? diagram.layouts : diagram.layouts3d
      if (map) delete map[id]
    }
  }
  for (const { diagramId, field, value } of plan.diagramField) {
    const diagram = diagramById.get(diagramId)
    if (diagram) assign(diagram, { [field]: value })
  }

  // 4. Removals, with the same sweep the delete actions do, and the EXPLICIT
  //    delete intent: absence from the store is never a deletion to the sync
  //    bridge, so an undone create without it comes back on the next reload.
  if (plan.remove.length) {
    const ids = { object: new Set<string>(), connection: new Set<string>(), group: new Set<string>() }
    for (const { kind, id } of plan.remove) {
      ids[kind].add(id)
      if (!draft[pending[kind]].includes(id)) draft[pending[kind]].push(id)
    }
    const shapeIds = new Set([...ids.object, ...ids.group])
    // `planApply` only removes a shape nothing else references, so what is
    // left incident to it here is a derived lower connection.
    for (const c of draft.connections) {
      if (shapeIds.has(c.fromId) || shapeIds.has(c.toId)) ids.connection.add(c.id)
    }
    if (ids.object.size) draft.objects = draft.objects.filter((o) => !ids.object.has(o.id))
    if (ids.group.size) draft.groups = draft.groups.filter((g) => !ids.group.has(g.id))
    if (ids.connection.size) draft.connections = draft.connections.filter((c) => !ids.connection.has(c.id))
    for (const diagram of draft.diagrams) {
      if (ids.object.size && diagram.objectIds.some((id) => ids.object.has(id))) {
        diagram.objectIds = diagram.objectIds.filter((id) => !ids.object.has(id))
      }
      if (ids.group.size && diagram.groupIds.some((id) => ids.group.has(id))) {
        diagram.groupIds = diagram.groupIds.filter((id) => !ids.group.has(id))
      }
      if (ids.connection.size && diagram.connectionIds.some((id) => ids.connection.has(id))) {
        diagram.connectionIds = diagram.connectionIds.filter((id) => !ids.connection.has(id))
      }
      for (const id of shapeIds) {
        if (diagram.layouts?.[id]) delete diagram.layouts[id]
        if (diagram.layouts3d?.[id]) delete diagram.layouts3d[id]
      }
    }
    if (ids.object.size) {
      for (const group of draft.groups) {
        if (group.objectIds.some((id) => ids.object.has(id))) {
          group.objectIds = group.objectIds.filter((id) => !ids.object.has(id))
        }
      }
    }
    const gone = new Set([...shapeIds, ...ids.connection])
    if (draft.selectedItems.some((item) => gone.has(item.id))) {
      draft.selectedItems = draft.selectedItems.filter((item) => !gone.has(item.id))
    }
  }
}

/** Keep only the selected items that are still drawn on `diagram`. */
export function selectionOnDiagram(selection: readonly SelectedItem[], diagram: Diagram | undefined): SelectedItem[] {
  if (!diagram) return []
  const objects = new Set(diagram.objectIds)
  const groups = new Set(diagram.groupIds)
  const connections = new Set(diagram.connectionIds)
  return selection.filter((item) =>
    item.type === 'object' ? objects.has(item.id)
      : item.type === 'group' ? groups.has(item.id)
        : connections.has(item.id))
}
