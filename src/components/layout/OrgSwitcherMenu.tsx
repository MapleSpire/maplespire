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

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Layers,
  ChevronDown,
  ChevronUp,
  Search,
  X,
  LayoutGrid,
  Box,
  ArrowLeftRight,
  Route,
  ClipboardList,
  GitBranch,
  FolderOpen,
  Plus,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '../../lib/utils'
import { CURRENT_VERSION_ID } from '../../lib/automerge/workspace'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { WorkspaceMenu } from './WorkspaceMenu'
import { ViewerGlyph } from '../model-viewer/ViewerGlyph'
import type { Diagram } from '../../types'

function diagramTypeLabels(t: TFunction): Record<Diagram['type'], string> {
  return {
    context: t('layoutNav.orgSwitcher.diagramType.context'),
    container: t('layoutNav.orgSwitcher.diagramType.container'),
    component: t('layoutNav.orgSwitcher.diagramType.component'),
  }
}
function diagramTypeShortLabels(t: TFunction): Record<Diagram['type'], string> {
  return {
    context: t('layoutNav.orgSwitcher.diagramTypeShort.context'),
    container: t('layoutNav.orgSwitcher.diagramTypeShort.container'),
    component: t('layoutNav.orgSwitcher.diagramTypeShort.component'),
  }
}
const DIAGRAM_TYPE_ORDER: Diagram['type'][] = ['context', 'container', 'component']

function navLinks(t: TFunction) {
  return [
    { view: 'diagrams' as const, label: t('layoutNav.orgSwitcher.nav.diagrams'), Icon: LayoutGrid, testid: 'nav-diagrams' },
    { view: 'model-viewer' as const, label: t('layoutNav.orgSwitcher.nav.modelViewer'), Icon: ViewerGlyph, testid: 'nav-model-viewer' },
    { view: 'model-objects' as const, label: t('layoutNav.orgSwitcher.nav.modelObjects'), Icon: Box, testid: 'nav-model-objects' },
    { view: 'connections' as const, label: t('layoutNav.orgSwitcher.nav.connections'), Icon: ArrowLeftRight, testid: 'nav-connections' },
    { view: 'dependencies' as const, label: t('layoutNav.orgSwitcher.nav.dependencies'), Icon: Route, testid: 'nav-dependencies' },
    { view: 'decision-records' as const, label: t('layoutNav.orgSwitcher.nav.decisionRecords'), Icon: ClipboardList, testid: 'nav-decision-records' },
    { view: 'drafts' as const, label: t('layoutNav.orgSwitcher.nav.drafts'), Icon: GitBranch, testid: 'nav-drafts' },
  ]
}

/**
 * The editor org-band's workspace + navigation switcher — the design's left-panel
 * mega-menu. Uses the `nav-*` test ids for its behaviours (switch workspace/version, switch view, pick or create a diagram).
 */
export function OrgSwitcherMenu() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Fixed-position coords for the dropdown so it escapes the panel's overflow-hidden.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    context: true,
    container: true,
    component: true,
  })
  const ref = useRef<HTMLDivElement>(null)
  // The dropdown is portaled to <body>, so it is NOT a DOM descendant of `ref`
  // (the trigger). The outside-click handler must check it separately or clicking
  // inside the menu reads as an outside click and closes it before acting.
  const menuRef = useRef<HTMLDivElement>(null)

  const toggleMenu = () => {
    if (!open && ref.current) {
      const r = ref.current.getBoundingClientRect()
      setPos({ top: r.bottom + 8, left: r.left })
    }
    setOpen((o) => !o)
  }

  const currentView = useUIStore((s) => s.currentView)
  const setCurrentView = useUIStore((s) => s.setCurrentView)
  const diagrams = useModelStore((s) => s.diagrams)
  const currentDiagramId = useModelStore((s) => s.currentDiagramId)
  const setCurrentDiagram = useModelStore((s) => s.setCurrentDiagram)
  const addDiagram = useModelStore((s) => s.addDiagram)
  const domains = useModelStore((s) => s.domains)
  // View-only session: creating a diagram is a model write the sync gate drops —
  // hide the "Create new diagram" section (opening/switching stays available).
  const canManage = !useModelStore((s) => s.workspaceReadOnly)

  const workspaceRef = useWorkspaceStore((s) => s.ref)
  const landscapes = useWorkspaceStore((s) => s.landscapes)
  const loadLandscapes = useWorkspaceStore((s) => s.load)
  // Load the registry up front so the workspace name shows without opening the menu.
  useEffect(() => {
    if (landscapes.length === 0) void loadLandscapes()
  }, [landscapes.length, loadLandscapes])
  const activeLandscape = landscapes.find((l) => l.id === workspaceRef.landscapeId)
  const workspaceName = activeLandscape?.name ?? t('layoutNav.orgSwitcher.workspaceFallback')
  // Version subline (design rule 5: the header shows landscape + VERSION, never
  // the company) — same derivation as WorkspaceMenu's active-version logic.
  const followingDefault = workspaceRef.versionId === CURRENT_VERSION_ID
  const activeVersionId = followingDefault ? activeLandscape?.defaultVersionId : workspaceRef.versionId
  const versionLabel =
    activeLandscape?.versions.find((v) => v.id === activeVersionId)?.label ?? t('layoutNav.orgSwitcher.currentVersion')

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? diagrams.filter((d) => d.name.toLowerCase().includes(q)) : diagrams
  }, [diagrams, query])

  const typeLabels = useMemo(() => diagramTypeLabels(t), [t])
  const typeShortLabels = useMemo(() => diagramTypeShortLabels(t), [t])
  const links = useMemo(() => navLinks(t), [t])

  const selectDiagram = (id: string) => {
    setCurrentDiagram(id)
    setCurrentView('diagram')
    setOpen(false)
    setQuery('')
  }
  const goToView = (view: ReturnType<typeof navLinks>[number]['view']) => {
    setCurrentView(view)
    setOpen(false)
  }
  const createDiagram = (type: Diagram['type']) => {
    const id = addDiagram({
      name: t('layoutNav.orgSwitcher.newDiagramName', { type: diagramTypeShortLabels(t)[type] }),
      type,
      objectIds: [],
      connectionIds: [],
      groupIds: [],
      domainId: domains[0]?.id,
    })
    setCurrentDiagram(id)
    setCurrentView('diagram')
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="relative min-w-0 flex-1" ref={ref}>
      <button
        data-testid="nav-menu"
        onClick={toggleMenu}
        className="flex w-full items-center gap-2.5 rounded-lg pl-0 pr-1 text-left transition-colors"
      >
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-gradient-to-br from-fg-strong to-fg text-fg-inverse shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
          <Layers className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold tracking-tight text-fg">{workspaceName}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform', open && 'rotate-180')} />
          </span>
          <span className="truncate text-[10.5px] text-fg-subtle">
            {versionLabel}
            {followingDefault ? ` · ${t('layoutNav.orgSwitcher.defaultSuffix')}` : ''}
          </span>
        </span>
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: 320,
            maxHeight: `calc(100vh - ${pos.top + 16}px)`,
          }}
          className="z-[60] flex flex-col overflow-hidden rounded-lg border border-line bg-surface-100 shadow-xl"
        >
          <div className="shrink-0 border-b border-line p-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('layoutNav.orgSwitcher.searchPlaceholder')}
                className="w-full rounded-md border border-line bg-surface-50 py-2 pl-9 pr-8 text-[13px] text-fg placeholder:text-fg-subtle focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent"
              />
              {query && (
                <button
                  onClick={() => setQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspaceMenu onClose={() => setOpen(false)} />

          <div className="p-2">
            {links.map(({ view, label, Icon, testid }) => (
              <button
                key={view}
                data-testid={testid}
                onClick={() => goToView(view)}
                className={cn(
                  'mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-[12px] hover:bg-surface-50',
                  currentView === view ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-secondary'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}

            <div className="my-2 border-t border-line" />

            {DIAGRAM_TYPE_ORDER.map((type) => {
              const list = filtered.filter((d) => d.type === type)
              const isExpanded = expanded[type]
              return (
                <div key={type} className="mb-1">
                  <button
                    onClick={() => setExpanded((p) => ({ ...p, [type]: !p[type] }))}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-[12px] font-medium text-fg-secondary hover:bg-surface-50"
                  >
                    <span className="flex items-center gap-2">
                      <FolderOpen className="h-3.5 w-3.5 text-fg-subtle" />
                      {typeLabels[type]}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-[11px] text-fg-subtle">{list.length}</span>
                      {isExpanded ? <ChevronUp className="h-3 w-3 text-fg-subtle" /> : <ChevronDown className="h-3 w-3 text-fg-subtle" />}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="ml-2 mt-0.5">
                      {list.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] italic text-fg-subtle">
                          {t('layoutNav.orgSwitcher.noneOfType', { type: typeLabels[type].toLowerCase() })}
                        </div>
                      ) : (
                        list.map((d) => (
                          <button
                            key={d.id}
                            data-testid={`nav-diagram-${d.id}`}
                            onClick={() => selectDiagram(d.id)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12px] hover:bg-surface-50',
                              d.id === currentDiagramId && currentView === 'diagram'
                                ? 'bg-accent-subtle font-medium text-accent'
                                : 'text-fg-strong'
                            )}
                          >
                            <LayoutGrid className="h-3 w-3 shrink-0 text-fg-subtle" />
                            <span className="truncate">{d.name}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {canManage && (
              <div className="mt-2 border-t border-line pt-2">
                <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                  {t('layoutNav.orgSwitcher.createNewDiagram')}
                </div>
                <div className="flex gap-2 px-1">
                  {DIAGRAM_TYPE_ORDER.map((type) => (
                    <button
                      key={type}
                      data-testid={`create-diagram-${type}`}
                      onClick={() => createDiagram(type)}
                      className="flex items-center gap-1.5 rounded-md border border-line bg-surface-50 px-3 py-1.5 text-[11px] text-fg-secondary transition-colors hover:border-accent hover:bg-accent-subtle hover:text-accent"
                    >
                      <Plus className="h-3 w-3" />
                      {typeShortLabels[type]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
