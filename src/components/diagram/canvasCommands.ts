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

import i18n from '../../lib/i18n'
import { useModelStore } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import { generateId } from '../../lib/utils'
import { getModelQuery } from '../../lib/modelQuery'
import { seedConnectionForEdit, seedObjectForEdit } from '../../lib/automerge/bridge'
import { currentWorkspaceRef, workspaceRefKey } from '../../lib/automerge/workspace'
import {
  buildClipboardPayload,
  encodeClipboardPayload,
  type CanvasClipboardPayload,
  type EncodedClipboard,
} from '../../lib/clipboard/canvasClipboard'
import { payloadBounds, pasteMode, planPaste, type PasteContext, type PastePlan } from '../../lib/clipboard/pastePlan'
import type { SelectedItem } from '../../types'

/**
 * The canvas edit commands behind the shortcuts and the context menus — the
 * same functions for the 2D canvas and the 3D board, since both edit the same
 * store. DOM wiring (keys, clipboard events) lives in `useCanvasCommands`.
 */

/** Offset of each repeated paste / duplicate, in world units. */
export const PASTE_STEP = 20

const workspaceKey = (): string => workspaceRefKey(currentWorkspaceRef())

/** The last payload this tab copied: what the context menu's Paste uses, since
 * reading the system clipboard outside a paste event needs a permission. */
let lastCopied: CanvasClipboardPayload | null = null
/** Pastes already made of one copy into one diagram, for the cascade. */
const pasteCounts = new Map<string, number>()

export function rememberedClipboard(): CanvasClipboardPayload | null {
  return lastCopied
}

/** Test seam. */
export function resetCanvasClipboard(): void {
  lastCopied = null
  pasteCounts.clear()
}

function copyName(name: string): string {
  return i18n.t('canvasViewChrome.clipboard.copyName', { name, defaultValue: '{{name}} (copy)' })
}

/** Payload of the current selection, or null when nothing copyable is selected. */
export function selectionPayload(selection?: readonly SelectedItem[]): CanvasClipboardPayload | null {
  const state = useModelStore.getState()
  const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
  if (!diagram) return null
  return buildClipboardPayload(
    state,
    diagram,
    selection ?? state.selectedItems,
    useUIStore.getState().canvasViewMode,
    workspaceKey(),
    generateId(),
  )
}

/** Copy the selection. Returns what to put on the system clipboard. */
export function copySelection(): EncodedClipboard | null {
  const payload = selectionPayload()
  if (!payload) return null
  lastCopied = payload
  return encodeClipboardPayload(payload)
}

/**
 * Cut = copy, then "remove from this diagram" — the safe delete, never a model
 * delete: cutting a system to paste it into another view must not erase it,
 * its documentation and every connection it has elsewhere. One undo entry.
 */
export function cutSelection(): EncodedClipboard | null {
  const payload = selectionPayload()
  if (!payload) return null
  lastCopied = payload
  const store = useModelStore.getState()
  if (payload.objects.length) store.removeObjectsFromDiagram(payload.objects.map((o) => o.id))
  if (payload.groups.length) store.removeGroupsFromDiagram(payload.groups.map((g) => g.id))
  return encodeClipboardPayload(payload)
}

/** Delete/Backspace: remove the selection from this diagram (the model keeps it). */
export function removeSelectionFromDiagram(): boolean {
  const store = useModelStore.getState()
  const objectIds = store.selectedItems.filter((s) => s.type === 'object').map((s) => s.id)
  const groupIds = store.selectedItems.filter((s) => s.type === 'group').map((s) => s.id)
  const connectionIds = store.selectedItems.filter((s) => s.type === 'connection').map((s) => s.id)
  if (!objectIds.length && !groupIds.length && !connectionIds.length) return false
  if (objectIds.length) store.removeObjectsFromDiagram(objectIds)
  if (groupIds.length) store.removeGroupsFromDiagram(groupIds)
  for (const id of connectionIds) store.removeConnectionFromDiagram(id)
  return true
}

/** Ctrl+A: every shape AND group drawn on the diagram. */
export function selectAllOnDiagram(): void {
  const state = useModelStore.getState()
  const diagram = state.diagrams.find((d) => d.id === state.currentDiagramId)
  if (!diagram) return
  const objects = new Set(state.objects.map((o) => o.id))
  const groups = new Map(state.groups.map((g) => [g.id, g]))
  useModelStore.setState({
    selectedItems: [
      ...diagram.objectIds.filter((id) => objects.has(id)).map((id) => ({ id, type: 'object' as const })),
      ...diagram.groupIds
        .filter((id) => groups.has(id) && !groups.get(id)!.parentObjectId)
        .map((id) => ({ id, type: 'group' as const })),
    ],
  })
}

export interface PasteOptions {
  /** "Paste as copy" (Ctrl+Shift+V) and Duplicate: never reference. */
  forceCopy?: boolean
  /** Centre the pasted shapes here (a context-menu "Paste here"). */
  anchor?: { x: number; y: number }
  /** The world rectangle on screen; a paste that would land entirely outside
   * it is centred in it instead, so the user sees what they pasted. */
  visibleRect?: { x: number; y: number; width: number; height: number }
  /** Fixed offset instead of the cascade (Duplicate). */
  offset?: { x: number; y: number }
}

/**
 * Elements the paste would reference but that the windowed store does not
 * hold (boot-from-server): fetch them from the model seam and seed them, the
 * same way a drop from the left panel does. Never the payload's snapshot —
 * that could be older than the model and would be written back over it.
 */
async function ensureResident(payload: CanvasClipboardPayload): Promise<void> {
  const state = useModelStore.getState()
  const residentObjects = new Set(state.objects.map((o) => o.id))
  const residentConnections = new Set(state.connections.map((c) => c.id))
  const query = getModelQuery()
  await Promise.all([
    ...payload.objects
      .filter((o) => !residentObjects.has(o.id))
      .map(async (o) => {
        const fetched = await query.object(o.id).catch(() => undefined)
        if (fetched) seedObjectForEdit(fetched)
      }),
    ...payload.connections
      .filter((c) => !residentConnections.has(c.id))
      .map(async (c) => {
        const fetched = await query.connection(c.id).catch(() => undefined)
        if (fetched) seedConnectionForEdit(fetched)
      }),
  ])
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Plan and apply a paste of `payload` onto the current diagram. */
export async function pastePayload(payload: CanvasClipboardPayload, options: PasteOptions = {}): Promise<PastePlan | null> {
  const forceCopy = options.forceCopy ?? false
  // The paste belongs to the diagram on screen when the user pressed the key.
  const targetId = useModelStore.getState().currentDiagramId
  const view = useUIStore.getState().currentView
  if (!forceCopy && payload.workspaceKey === workspaceKey()) await ensureResident(payload)

  const state = useModelStore.getState()
  // Moved on while the elements were fetched: landing on another diagram (or
  // off the canvas, where it would not even be undoable) is not what was asked.
  if (state.currentDiagramId !== targetId || useUIStore.getState().currentView !== view) return null
  const target = state.diagrams.find((d) => d.id === state.currentDiagramId)
  if (!target || state.workspaceReadOnly || target.readonly) return null
  const objects = new Set(state.objects.map((o) => o.id))
  const groups = new Set(state.groups.map((g) => g.id))
  const connections = new Set(state.connections.map((c) => c.id))
  const context: PasteContext = {
    workspaceKey: workspaceKey(),
    target,
    objectExists: (id) => objects.has(id),
    groupExists: (id) => groups.has(id),
    connectionExists: (id) => connections.has(id),
    knownTagIds: new Set(state.tags.map((tag) => tag.tagId)),
    defaultDomainId: state.domains[0]?.id,
    forceCopy,
    offset: { x: 0, y: 0 },
    mintId: generateId,
    copyName,
  }

  const bounds = payloadBounds(payload)
  if (options.offset) {
    context.offset = options.offset
  } else if (options.anchor && bounds) {
    context.offset = {
      x: options.anchor.x - (bounds.x + bounds.width / 2),
      y: options.anchor.y - (bounds.y + bounds.height / 2),
    }
  } else {
    // Cascade: a copy pasted where its originals are steps down-right, and
    // every further paste of the same copy steps again; a reference paste
    // into another view lands exactly where the shapes were.
    const key = `${payload.copyId}:${target.id}`
    const count = pasteCounts.get(key) ?? 0
    const overOriginals = pasteMode(payload, context) === 'copy' && payload.sourceDiagramId === target.id
    const steps = count + (overOriginals ? 1 : 0)
    context.offset = { x: steps * PASTE_STEP, y: steps * PASTE_STEP }
    pasteCounts.set(key, count + 1)
    if (bounds && options.visibleRect) {
      const landed = { ...bounds, x: bounds.x + context.offset.x, y: bounds.y + context.offset.y }
      if (!intersects(landed, options.visibleRect)) {
        context.offset = {
          x: options.visibleRect.x + options.visibleRect.width / 2 - (bounds.x + bounds.width / 2),
          y: options.visibleRect.y + options.visibleRect.height / 2 - (bounds.y + bounds.height / 2),
        }
      }
    }
  }

  const plan = planPaste(payload, context)
  useModelStore.getState().pasteEntities(plan)
  return plan
}

/** Ctrl+D: copies of the selection next to it. Leaves the clipboard alone. */
export async function duplicateSelection(): Promise<PastePlan | null> {
  const payload = selectionPayload()
  if (!payload) return null
  return pastePayload(payload, { forceCopy: true, offset: { x: PASTE_STEP, y: PASTE_STEP } })
}
