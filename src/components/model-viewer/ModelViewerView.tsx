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

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Box } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { useModelStore } from '../../stores/modelStore'
import { WorkspaceShell, WorkspacePill, PillFilterPopover } from '../layout/WorkspaceShell'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { useViewerData } from './useViewerData'
import { ViewerGrid, type ViewerSelection } from './ViewerGrid'
import { ViewerBreadcrumb, ViewerBottomControls } from './ViewerChrome'
import { ViewerObjectPanel, ViewerConnectionPanel } from './ViewerPanels'
import { ModelViewer3D } from './ModelViewer3D'
import {
  childrenOf,
  connsAtLevel,
  hasChildren,
  levelKind,
  validatePath,
  type ParentId,
} from '../../lib/modelViewer/levels'

/**
 * Model viewer — an automatic, read-only view of every object and connection in
 * the landscape (design kit `ui_kits/model-viewer`): the C4 tree laid out as a
 * grid of square tiles per level, a calm connection overlay that lights up on
 * engagement, a drill-down zoom into lower levels (2D WAAPI twin-layer zoom /
 * 3D camera dive with the same reading), and read-only detail panels that link
 * out to the editing surfaces.
 */
export function ModelViewerView() {
  const { t } = useTranslation()
  const domains = useModelStore((s) => s.domains)

  const storePath = useUIStore((s) => s.modelViewerPath)
  const setPath = useUIStore((s) => s.setModelViewerPath)
  const searchQuery = useUIStore((s) => s.modelViewerSearchQuery)
  const setSearchQuery = useUIStore((s) => s.setModelViewerSearchQuery)
  const domainIds = useUIStore((s) => s.modelViewerDomainIds)
  const toggleDomainId = useUIStore((s) => s.toggleModelViewerDomainId)
  const clearDomainIds = useUIStore((s) => s.clearModelViewerDomainIds)
  const opts = useUIStore((s) => s.modelViewerOptions)
  const setOpts = useUIStore((s) => s.setModelViewerOptions)
  const mode = useUIStore((s) => s.modelViewerMode)
  const setMode = useUIStore((s) => s.setModelViewerMode)
  const navOpen = useUIStore((s) => s.workspaceNavOpen)
  const rightOpen = useUIStore((s) => s.rightSidebarOpen)
  const setRightOpen = useUIStore((s) => s.setRightSidebarOpen)
  const {
    model,
    connections,
    loaded,
    totalObjects,
    connectionsTruncated,
    coverage,
    hasMoreObjects,
    loadingMore,
    loadMore,
  } = useViewerData({
    parentId: storePath.at(-1) ?? null,
    query: searchQuery,
    domainIds,
  })

  const [selection, setSelection] = useState<ViewerSelection>(null)
  const [filterOpen, setFilterOpen] = useState(false)

  // Objects can be deleted/reparented while the viewer is open (or across
  // workspace switches) — always render a path the current model can serve,
  // and write the truncation back so the URL/store never points nowhere.
  const path = useMemo(() => (loaded ? validatePath(model, storePath) : storePath), [loaded, model, storePath])
  useEffect(() => {
    if (loaded && path.length !== storePath.length) setPath(path)
  }, [loaded, path, storePath, setPath])

  const domainById = useMemo(() => new Map(domains.map((d) => [d.id, d])), [domains])
  const curParent: ParentId = path.length ? path[path.length - 1] : null
  const levelObjects = useMemo(() => childrenOf(model, curParent), [model, curParent])
  const levelConns = useMemo(
    () => connsAtLevel(model, connections, curParent),
    [model, connections, curParent]
  )

  // A stale selection (object left this level / connection deleted) is ignored
  // during render. Keeping this derived avoids an effect-driven extra render.
  const activeSelection = useMemo(() => {
    if (!selection) return null
    if (selection.kind === 'object') return model.objectById.has(selection.id) ? selection : null
    return connections.some((connection) => connection.id === selection.id) ? selection : null
  }, [selection, model, connections])

  const go = (newPath: string[]) => {
    setPath(newPath)
    setSelection(null)
  }
  const selectObject = (id: string) => {
    setSelection({ kind: 'object', id })
    setRightOpen(true)
  }
  const selectConn = (id: string) => {
    setSelection({ kind: 'conn', id })
    setRightOpen(true)
  }
  const drillInto = (id: string) => {
    if (hasChildren(model, id)) {
      // A query narrows one level; carrying it into a different C4 level often
      // produces a confusing empty canvas even though the chevron is valid.
      if (searchQuery) setSearchQuery('')
      go([...path, id])
    }
  }

  const insets = {
    left: navOpen ? 334 : 24,
    right: activeSelection && rightOpen ? 334 : 24,
  }

  const right =
    activeSelection?.kind === 'object' ? (
      <ViewerObjectPanel
        id={activeSelection.id}
        model={model}
        connections={connections}
        domainById={domainById}
        onOpenConn={selectConn}
        onOpenLower={hasChildren(model, activeSelection.id) ? () => drillInto(activeSelection.id) : undefined}
      />
    ) : activeSelection?.kind === 'conn' ? (
      <ViewerConnectionPanel id={activeSelection.id} model={model} connections={connections} onOpenObject={selectObject} />
    ) : undefined

  const empty = loaded && model.objectById.size === 0

  return (
    <WorkspaceShell
      active="model-viewer"
      pill={
        <WorkspacePill
          searchPlaceholder={t('modelViewer.searchPlaceholder')}
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          searchTestId="mv-search"
          filter={{
            active: domainIds.length,
            open: filterOpen,
            onToggle: setFilterOpen,
            onClear: clearDomainIds,
            panel: (
              <PillFilterPopover>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                  {t('modelViewer.filterDomain')}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {domains.map((d) => {
                    const on = domainIds.includes(d.id)
                    return (
                      <button
                        key={d.id}
                        onClick={() => toggleDomainId(d.id)}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                          on
                            ? 'border-accent bg-accent-subtle text-accent'
                            : 'border-line bg-surface-50 text-fg-secondary hover:border-line-strong'
                        )}
                      >
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: d.color ?? 'var(--color-fg-subtle)' }}
                        />
                        {d.name}
                      </button>
                    )
                  })}
                </div>
              </PillFilterPopover>
            ),
          }}
          extra={
            <SegmentedTabs
              size="sm"
              value={mode}
              onChange={setMode}
              tabs={[
                { id: '2d', label: t('modelViewer.mode.flat'), testid: 'mv-view-2d' },
                { id: '3d', label: t('modelViewer.mode.board'), testid: 'mv-view-3d' },
              ]}
            />
          }
        />
      }
      right={right}
      footer={[
        {
          label: t('modelViewer.footer.objects'),
          value: totalObjects > levelObjects.length ? `${levelObjects.length}/${totalObjects}` : levelObjects.length,
        },
        { label: t('modelViewer.footer.connections'), value: levelConns.length },
        {
          label: t('modelViewer.footer.level'),
          value: t(`modelViewer.breadcrumb.level.${levelKind(model, curParent)}`),
        },
      ]}
    >
      <div className="relative min-h-0 flex-1">
        {loaded && (hasMoreObjects || totalObjects > levelObjects.length || connectionsTruncated || coverage !== 'full') && (
          <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface-100/95 px-3 py-1.5 text-[11px] text-fg-secondary shadow-card backdrop-blur">
            <span>
              {coverage !== 'full'
                ? t('modelViewer.window.offlinePartial')
                : connectionsTruncated
                  ? t('modelViewer.window.connectionsLimited')
                  : t('modelViewer.window.objectsLimited', { visible: levelObjects.length, total: totalObjects })}
            </span>
            {hasMoreObjects && coverage === 'full' && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="pointer-events-auto rounded-full border border-line-strong bg-surface-50 px-2 py-0.5 font-medium text-accent hover:bg-accent-subtle disabled:opacity-50"
              >
                {loadingMore ? t('modelViewer.window.loadingMore') : t('modelViewer.window.loadMore')}
              </button>
            )}
          </div>
        )}
        {empty ? (
          <div className="mv-canvas absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-[300px] flex-col items-center gap-2.5 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-200 text-fg-subtle">
                <Box className="h-5 w-5" />
              </span>
              <div className="text-[13px] font-semibold text-fg-secondary">{t('modelViewer.empty.title')}</div>
              <div className="text-[12px] leading-relaxed text-fg-subtle">{t('modelViewer.empty.body')}</div>
            </div>
          </div>
        ) : mode === '3d' ? (
          <ModelViewer3D
            model={model}
            connections={connections}
            domainById={domainById}
            path={path}
            onPath={go}
            selection={activeSelection}
            onSelectObject={selectObject}
            onSelectConn={selectConn}
            onClear={() => setSelection(null)}
            opts={opts}
            onBackTo2d={() => setMode('2d')}
            insets={insets}
          />
        ) : (
          <ViewerGrid
            model={model}
            connections={connections}
            domainById={domainById}
            path={path}
            onPath={go}
            selection={activeSelection}
            onSelectObject={selectObject}
            onSelectConn={selectConn}
            onClear={() => setSelection(null)}
            opts={opts}
            filters={{ query: searchQuery, domainIds }}
            insets={insets}
            bottomRight={<ViewerBottomControls opts={opts} setOpts={setOpts} />}
          />
        )}
        {!empty && <ViewerBreadcrumb model={model} path={path} onGo={go} />}
      </div>
    </WorkspaceShell>
  )
}
