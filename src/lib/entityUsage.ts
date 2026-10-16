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

import type { Diagram, Flow } from '../types'
import { getModelQuery } from './modelQuery'
import type { EntityFlowsResult } from './modelQuery/types'
import { useModelStore } from '../stores/modelStore'
import { useUIStore } from '../stores/uiStore'

/**
 * "Where is this used?" for the Details panel: the diagrams that contain an
 * entity, the flows that walk through it, and (objects) how many children it
 * has. Each number comes from the SAME source as the table column that shows
 * it, so the panel and the table cannot disagree:
 *
 *  - object diagrams → `relatedDiagrams(…, { includeCurrent })`'s `reference`
 *    bucket: `objectToDiagramIds` on the resident tier, `ro_diagram_objects` on
 *    the server tier — exactly what Model Objects' "In diagrams" counts. Never
 *    the resident registry alone: on the Phase-4 path it can be a bounded window.
 *  - group / connection diagrams → `entityDiagrams` (`ro_diagram_groups` /
 *    `ro_diagram_connections`, what the server-tier tables count); without a
 *    read model, the diagram registry's `groupIds` / `connectionIds` (what the
 *    resident tree row counts) — a registry that is a bounded window under
 *    the summary contract, and then the count says "at least".
 *  - object children → the Model Objects tree's own child page
 *    (`objectTreePage({ parentId })`), i.e. the rows the table expands to.
 *  - flows → the read model's flow index for every diagram but the open one,
 *    plus the open diagram's flows from the store (live, possibly newer than
 *    the projection); without a read model, the open diagram's flows only.
 */

export type UsageEntityKind = 'object' | 'group' | 'connection'

export interface DiagramUsage {
  /** Name-sorted, bounded by the seam's limit. */
  diagrams: Diagram[]
  /** The full count; may exceed `diagrams.length` when bounded. */
  total: number
  /** False when `total` is a floor (a windowed registry answered). */
  complete: boolean
}

export interface FlowUsage {
  flows: Array<{ id: string; diagramId: string; name: string }>
  total: number
  /** False when `total` is a floor. */
  complete: boolean
  /** `model`: the read model's whole-model flow index answered.
   *  `open-diagram`: no index reachable (resident tier, offline), so only the
   *  OPEN diagram's flows were counted — the store holds nothing else (the
   *  bridge projects the active DiagramDoc's flows only). */
  scope: 'model' | 'open-diagram'
}

export const DIAGRAM_USAGE_LIMIT = 50

/** Flows with a step on the object: a process step on it, or a message step
 *  sent or received by it. A flow counts once however many steps touch it. */
export function flowsReferencingObject(flows: readonly Flow[], objectId: string): Flow[] {
  return flows.filter((flow) => flow.steps.some((step) =>
    (step.type === 'process' && step.objectId === objectId)
    || (step.type === 'message' && (step.fromObjectId === objectId || step.toObjectId === objectId))))
}

/** Flows with a message step travelling over the connection. */
export function flowsReferencingConnection(flows: readonly Flow[], connectionId: string): Flow[] {
  return flows.filter((flow) => flow.steps.some((step) =>
    step.type === 'message' && step.connectionId === connectionId))
}

/** Flow usage over the flows the store holds (the open diagram's), with the
 *  completeness verdict. `openDiagramId` is the diagram whose flows are held. */
export function flowUsage(
  heldFlows: readonly Flow[],
  kind: Exclude<UsageEntityKind, 'group'>,
  id: string,
  usage: DiagramUsage,
  openDiagramId: string | null,
): FlowUsage {
  const matched = kind === 'object' ? flowsReferencingObject(heldFlows, id) : flowsReferencingConnection(heldFlows, id)
  const flows = matched.map((flow) => ({ id: flow.id, diagramId: flow.diagramId, name: flow.name }))
  const containsOpen = openDiagramId !== null && usage.diagrams.some((d) => d.id === openDiagramId)
  return { flows, total: flows.length, complete: usage.total - (containsOpen ? 1 : 0) === 0, scope: 'open-diagram' }
}

/** The read model's flow index for every diagram EXCEPT the open one, or
 *  `null` when this tier has none (the caller then falls back to `flowUsage`). */
export async function loadModelFlowUsage(
  kind: Exclude<UsageEntityKind, 'group'>,
  id: string,
  openDiagramId: string | null,
  signal?: AbortSignal,
): Promise<EntityFlowsResult | null> {
  return getModelQuery().entityFlows(kind, id, { limit: DIAGRAM_USAGE_LIMIT, signal, excludeDiagramId: openDiagramId })
}

/** Whole-model flow usage: the index's answer for the other diagrams plus the
 *  open diagram's live flows. Completeness is the index's verdict — it already
 *  left the open diagram out of its coverage test. */
export function mergeFlowUsage(
  model: EntityFlowsResult,
  heldFlows: readonly Flow[],
  kind: Exclude<UsageEntityKind, 'group'>,
  id: string,
  openDiagramId: string | null,
): FlowUsage {
  const matched = kind === 'object' ? flowsReferencingObject(heldFlows, id) : flowsReferencingConnection(heldFlows, id)
  const open = matched
    .filter((flow) => openDiagramId !== null && flow.diagramId === openDiagramId)
    .map((flow) => ({ id: flow.id, diagramId: flow.diagramId, name: flow.name }))
  return {
    flows: [...open, ...model.flows.filter((flow) => flow.diagramId !== openDiagramId)],
    total: model.total + open.length,
    complete: model.complete,
    scope: 'model',
  }
}

function byName(left: Diagram, right: Diagram): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
}

/** Diagrams placing the group or connection, from the diagram registry.
 *  `registryComplete` is false when the registry is a bounded window. */
export function registryDiagramUsage(
  diagrams: readonly Diagram[],
  kind: Exclude<UsageEntityKind, 'object'>,
  id: string,
  registryComplete: boolean,
): DiagramUsage {
  const matching = diagrams
    .filter((diagram) => ((kind === 'group' ? diagram.groupIds : diagram.connectionIds) ?? []).includes(id))
    .sort(byName)
  return { diagrams: matching.slice(0, DIAGRAM_USAGE_LIMIT), total: matching.length, complete: registryComplete }
}

/** Diagrams placing the group or connection, from the read model; `null` when
 *  this tier has none (the caller then uses `registryDiagramUsage`). */
export async function loadEntityDiagramUsage(
  kind: Exclude<UsageEntityKind, 'object'>,
  id: string,
  signal?: AbortSignal,
): Promise<DiagramUsage | null> {
  const result = await getModelQuery().entityDiagrams(kind, id, { limit: DIAGRAM_USAGE_LIMIT, signal })
  return result ? { ...result, complete: true } : null
}

/** Every diagram containing the object, through the model-query seam. */
export async function loadObjectDiagramUsage(objectId: string, signal?: AbortSignal): Promise<DiagramUsage> {
  const related = await getModelQuery().relatedDiagrams(objectId, {
    includeCurrent: true,
    limit: DIAGRAM_USAGE_LIMIT,
    signal,
  })
  return { diagrams: related.reference, total: related.totals.reference, complete: true }
}

/** Children counted before the walk stops; past it the count is a floor
 *  (`complete: false`) rather than an unbounded walk. A ROW ceiling, not a
 *  page one: tiers clamp the requested page size differently (the resident
 *  fallback serves 50 rows a page, the server up to 500). */
export const CHILD_COUNT_CEILING = 2000
const CHILD_PAGE_LIMIT = 100

/** Direct children (objects whose parent is this object), counted over the
 *  Model Objects tree's child pages. A page served from a `working-set`
 *  (offline / server error fallback) makes the count a floor. */
export async function loadChildCount(
  objectId: string,
  signal?: AbortSignal,
): Promise<{ count: number; complete: boolean }> {
  let count = 0
  let cursor: string | null = null
  let partial = false
  do {
    const result = await getModelQuery().objectTreePage({ parentId: objectId, cursor, limit: CHILD_PAGE_LIMIT }, signal)
    count += result.items.length
    if (result.coverage === 'working-set') partial = true
    cursor = result.nextCursor
    if (!cursor) return { count, complete: !partial }
    // A page with no rows but a cursor would loop for ever; treat it as a floor.
    if (!result.items.length) break
  } while (count < CHILD_COUNT_CEILING)
  return { count: Math.min(count, CHILD_COUNT_CEILING), complete: false }
}

/** Open a flow: its diagram on the canvas, with the flow current. */
export function openFlowInDiagram(diagramId: string, flowId: string): void {
  const model = useModelStore.getState()
  const ui = useUIStore.getState()
  if (model.currentDiagramId !== diagramId) model.setCurrentDiagram(diagramId)
  ui.setCurrentFlow(flowId)
  ui.setCurrentView('diagram')
}

/** Open `diagramId` on the canvas with the entity selected and centred. */
export function openEntityInDiagram(diagramId: string, kind: UsageEntityKind, id: string): void {
  const model = useModelStore.getState()
  const ui = useUIStore.getState()
  ui.setPendingCanvasFocus({ diagramId, kind, id })
  // setCurrentDiagram clears the selection, so select AFTER switching.
  if (model.currentDiagramId !== diagramId) model.setCurrentDiagram(diagramId)
  if (kind === 'object') model.selectObjects([id])
  else if (kind === 'group') model.selectGroup(id)
  else model.selectConnection(id)
  ui.setCurrentView('diagram')
}
