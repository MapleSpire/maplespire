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
 * Spotlight: what choosing a result does.
 *
 * Every action here calls a store action the rest of the app already uses (the
 * tool pill, the workspace nav, the Model Viewer's "edit in Model objects"), so
 * the Spotlight adds a way in, never a second implementation.
 */

import type { LucideIcon } from 'lucide-react'
import {
  Boxes, ClipboardList, Eye, GitBranch, History, LayoutGrid, Moon, Network, Plus, Settings, Share2, Sun, Table2,
} from 'lucide-react'
import { useModelStore, getDiagramIndex } from '../../stores/modelStore'
import { useUIStore } from '../../stores/uiStore'
import type { AppView } from '../../stores/uiStore'
import { useThemeStore } from '../../stores/themeStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { loadEntityDiagramUsage, loadObjectDiagramUsage, openEntityInDiagram, openFlowInDiagram } from '../entityUsage'
import type { UsageEntityKind } from '../entityUsage'
import type { SpotlightKind } from './spotlight/grammar'

// ── commands ──────────────────────────────────────────────────────────────────

export interface SpotlightCommand {
  /** Also the i18n key: `spotlight.commands.<id>.title` / `.keywords` / `.description`. */
  readonly id: string
  readonly icon: LucideIcon
  readonly shortcut?: string
  readonly run: () => void
}

function goTo(view: AppView): () => void {
  return () => useUIStore.getState().setCurrentView(view)
}

/** The commands available right now (a read-only workspace cannot create a
 *  diagram; 3D and history need an open diagram). Built when the Spotlight
 *  opens, so availability follows the current state. `blankDiagramName` is the
 *  translated default name, as the tool pill's "Blank diagram" uses. */
export function spotlightCommands({ blankDiagramName }: { blankDiagramName: string }): SpotlightCommand[] {
  const model = useModelStore.getState()
  const ui = useUIStore.getState()
  const theme = useThemeStore.getState()
  const onDiagram = ui.currentView === 'diagram' && !!model.currentDiagramId
  const commands: SpotlightCommand[] = [
    { id: 'goDiagrams', icon: LayoutGrid, run: goTo('diagrams') },
    { id: 'goObjects', icon: Table2, run: goTo('model-objects') },
    { id: 'goConnections', icon: Network, run: goTo('connections') },
    { id: 'goDependencies', icon: GitBranch, run: goTo('dependencies') },
    { id: 'goViewer', icon: Boxes, run: goTo('model-viewer') },
    { id: 'goDecisions', icon: ClipboardList, run: goTo('decision-records') },
    { id: 'goDrafts', icon: GitBranch, run: goTo('drafts') },
  ]
  if (!model.workspaceReadOnly) {
    commands.push({ id: 'newDiagram', icon: Plus, run: () => createBlankDiagram(blankDiagramName) })
  }
  if (onDiagram) {
    const to3d = ui.canvasViewMode !== '3d'
    const diagramId = model.currentDiagramId
    commands.push(
      { id: to3d ? 'view3d' : 'view2d', icon: Eye, run: () => useUIStore.getState().setCanvasViewMode(to3d ? '3d' : '2d', diagramId) },
      { id: 'history', icon: History, run: () => useUIStore.getState().setHistoryOpen(true) },
    )
  }
  commands.push(
    { id: 'share', icon: Share2, run: () => useUIStore.getState().setShareOpen(true) },
    theme.resolved === 'dark'
      ? { id: 'themeLight', icon: Sun, run: () => useThemeStore.getState().setMode('light') }
      : { id: 'themeDark', icon: Moon, run: () => useThemeStore.getState().setMode('dark') },
    { id: 'settings', icon: Settings, run: () => useUIStore.getState().setSettingsOpen(true) },
  )
  return commands
}

/** Same as the tool pill's "Blank diagram" (EditorToolPill). */
function createBlankDiagram(name: string): void {
  const model = useModelStore.getState()
  const id = model.addDiagram({
    name,
    type: 'context',
    objectIds: [],
    connectionIds: [],
    groupIds: [],
    domainId: model.domains[0]?.id,
  })
  model.setCurrentDiagram(id)
  model.clearSelection()
  useUIStore.getState().setCurrentView('diagram')
}

// ── opening a result ──────────────────────────────────────────────────────────

/** The deep link a diagram opens at (router.tsx: landscape/$id/version/$id/diagram/$id). */
export function diagramHref(diagramId: string): string {
  const { landscapeId, versionId } = useWorkspaceStore.getState().ref
  const seg = encodeURIComponent
  return `/app/landscape/${seg(landscapeId)}/version/${seg(versionId)}/diagram/${seg(diagramId)}`
}

const C4_KINDS = new Set<SpotlightKind>(['system', 'app', 'store', 'component', 'actor'])

/** True when the result can still be opened from what the store holds. */
export function spotlightTargetExists(kind: SpotlightKind, id: string): boolean {
  const index = getDiagramIndex()
  const model = useModelStore.getState()
  if (C4_KINDS.has(kind)) return index.objectById.has(id)
  switch (kind) {
    case 'group': return index.groupById.has(id)
    case 'connection': return index.connectionById.has(id)
    case 'diagram': return index.diagramById.has(id)
    case 'flow': return model.flows.some((f) => f.id === id)
    case 'adr': return model.decisionRecords.some((r) => r.id === id)
    default: return false
  }
}

/** What the row knew about a result the store may not hold (a server hit). */
export interface SpotlightOpenHint {
  /** The entity's own name or label, as the hit carried it. */
  readonly name?: string
  /** A flow's diagram. */
  readonly diagramId?: string
}

/** "Reveal in model": the Model Viewer's "edit in Model objects" route. */
function revealObject(id: string, hint: SpotlightOpenHint): void {
  const name = getDiagramIndex().objectById.get(id)?.name ?? hint.name ?? ''
  const ui = useUIStore.getState()
  ui.setModelObjectsSearchQuery(name)
  ui.setCurrentView('model-objects')
}

function revealConnection(id: string, hint: SpotlightOpenHint): void {
  const label = getDiagramIndex().connectionById.get(id)?.label ?? hint.name ?? ''
  const ui = useUIStore.getState()
  ui.setConnectionsSearchQuery(label)
  ui.setCurrentView('connections')
}

/** The diagram to open an entity in: the open one when it places the entity,
 *  else the first by name among those the store knows. */
function residentDiagramFor(kind: UsageEntityKind, id: string): string | null {
  const index = getDiagramIndex()
  const ids = kind === 'object' ? index.objectToDiagramIds.get(id)
    : kind === 'group' ? index.groupToDiagramIds.get(id)
      : index.connectionToDiagramIds.get(id)
  if (!ids || ids.size === 0) return null
  const current = useModelStore.getState().currentDiagramId
  if (current && ids.has(current)) return current
  const names = [...ids].map((d) => ({ id: d, name: index.diagramById.get(d)?.name ?? '' }))
  names.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return names[0].id
}

async function openEntity(kind: UsageEntityKind, id: string, fallback: () => void): Promise<void> {
  const resident = residentDiagramFor(kind, id)
  if (resident) {
    openEntityInDiagram(resident, kind, id)
    return
  }
  // Off the resident window: ask the model-query seam (server tier when there is one).
  try {
    const usage = kind === 'object' ? await loadObjectDiagramUsage(id) : await loadEntityDiagramUsage(kind, id)
    const diagram = usage?.diagrams[0]
    if (diagram) {
      openEntityInDiagram(diagram.id, kind, id)
      return
    }
  } catch (err) {
    console.warn('spotlight: diagram lookup failed', err)
  }
  fallback()
}

/**
 * Open a result. `meta` is the design's secondary action (⌘↵): reveal an
 * object in Model objects, a connection in Model connections, or a diagram in
 * a new tab. `hint` covers a result the store does not hold (a server hit).
 */
export function openSpotlightResult(kind: SpotlightKind, id: string, modifier: 'none' | 'meta', hint: SpotlightOpenHint = {}): void {
  if (C4_KINDS.has(kind)) {
    if (modifier === 'meta') revealObject(id, hint)
    else void openEntity('object', id, () => revealObject(id, hint))
    return
  }
  const model = useModelStore.getState()
  const ui = useUIStore.getState()
  switch (kind) {
    case 'group':
      void openEntity('group', id, goTo('model-objects'))
      return
    case 'connection':
      if (modifier === 'meta') revealConnection(id, hint)
      else void openEntity('connection', id, () => revealConnection(id, hint))
      return
    case 'diagram':
      if (modifier === 'meta') {
        window.open(diagramHref(id), '_blank', 'noopener')
        return
      }
      if (model.currentDiagramId !== id) model.setCurrentDiagram(id)
      ui.setCurrentView('diagram')
      return
    case 'flow': {
      const diagramId = model.flows.find((f) => f.id === id)?.diagramId ?? hint.diagramId
      if (diagramId) openFlowInDiagram(diagramId, id)
      return
    }
    case 'adr':
      ui.setSelectedADRId(id)
      ui.setCurrentView('decision-records')
      return
    default:
  }
}
