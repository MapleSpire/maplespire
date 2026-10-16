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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, Maximize, Moon, Orbit, PanelLeft, PanelRight, Route, Sun, ZoomIn, ZoomOut } from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { cn } from '../lib/utils'
import { getShare } from '../lib/share/api'
import { readUrlViewMode, writeUrlViewMode } from '../lib/deepLinkView'
import type { ShareSnapshot } from '../lib/share/types'
import type { SelectedItem } from '../types'
import type { CanvasEngine, CanvasViewportInsets } from '../canvas/engine/CanvasEngine'
import { editorCanvasInsets } from '../components/diagram/canvasViewportControls'
import { ViewerCanvas } from './ViewerCanvas'
import { ViewerDetailsPanel } from './ViewerDetailsPanel'
import { ViewerFlowPanel } from './ViewerFlowPanel'
import { CameraControls } from '../components/diagram/CameraControls'
import { ViewerPerspectiveBar } from './ViewerPerspectiveBar'
import type { Scene3D } from '../canvas3d'
import { useThemeStore } from '../stores/themeStore'

export interface ShareViewerProps {
  token: string
  /** `standalone` shows a slim header; `embed` is chrome-light for iframes. */
  mode: 'standalone' | 'embed'
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-app">
      <p className="text-sm text-fg-subtle">{children}</p>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 px-3 py-2 text-[12px] font-medium transition-colors',
        active ? 'border-b-2 border-accent text-fg' : 'text-fg-subtle hover:text-fg-secondary',
      )}
    >
      {children}
    </button>
  )
}

function DiagramSwitcher({
  diagrams,
  activeId,
  onSelect,
}: {
  diagrams: { id: string; name: string }[]
  activeId: string
  onSelect: (id: string) => void
}) {
  const { t } = useTranslation()
  return (
    <select
      value={activeId}
      onChange={(e) => onSelect(e.target.value)}
      aria-label={t('viewer.switchDiagramAriaLabel')}
      className="max-w-[70%] truncate rounded-md border border-line bg-surface-50 px-2 py-1 text-sm font-medium text-fg shadow-sm focus:outline-none focus:ring-1 focus:ring-accent"
    >
      {diagrams.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  )
}

type LoadState = 'loading' | 'ready' | 'notfound' | 'error' | 'restricted'

/** Restricted-share gate: a signed-in prompt (needsAuth) or a no-access notice. */
function RestrictedNotice({ token, needsAuth }: { token: string; needsAuth: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full w-full items-center justify-center bg-app px-4">
      <div className="w-full max-w-[400px] rounded-xl border border-line bg-surface-100 p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-surface-200 text-fg-secondary">
          <Lock className="h-5 w-5" />
        </div>
        <h1 className="mb-1.5 text-[16px] font-semibold text-fg">
          {needsAuth ? t('viewer.restricted.signInTitle') : t('viewer.restricted.noAccessTitle')}
        </h1>
        <p className="mb-6 text-[13px] leading-relaxed text-fg-secondary">
          {needsAuth ? t('viewer.restricted.signInBody') : t('viewer.restricted.noAccessBody')}
        </p>
        {needsAuth && (
          <a
            href={`/login?next=${encodeURIComponent(`/share/${token}`)}`}
            className="inline-flex w-full items-center justify-center rounded-lg bg-inverse px-4 py-2.5 text-[13px] font-medium text-on-inverse transition-colors hover:bg-inverse-hover"
          >
            {t('viewer.restricted.signInButton')}
          </a>
        )}
      </div>
    </div>
  )
}

/** The embed layout's right aside: `w-72` (288 px) at `right-2`, plus the same
 *  8 px gap on its canvas side. */
const EMBED_ASIDE_INSETS: CanvasViewportInsets = { right: 8 + 288 + 8 }

/**
 * Public, INTERACTIVE read-only viewer. Renders the shared snapshot via
 * CanvasEngine (read-only but selectable): focusing a shape animates its
 * connections and shows its details; a Flows tab steps through flows.
 */
export function ShareViewer({ token, mode }: ShareViewerProps) {
  const { t } = useTranslation()
  const resolvedTheme = useThemeStore((theme) => theme.resolved)
  const setThemeMode = useThemeStore((theme) => theme.setMode)
  const [state, setState] = useState<LoadState>('loading')
  const [snapshot, setSnapshot] = useState<ShareSnapshot | null>(null)
  const [activeDiagramId, setActiveDiagramId] = useState<string | null>(null)
  const [restricted, setRestricted] = useState<{ needsAuth: boolean }>({ needsAuth: true })
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [tab, setTab] = useState<'details' | 'flows'>('details')
  const [flowSidebarOpen, setFlowSidebarOpen] = useState(true)
  const [detailsSidebarOpen, setDetailsSidebarOpen] = useState(true)
  const [rendererVersion, setRendererVersion] = useState(0)
  const [zoom, setZoom] = useState(1)
  // 3D board (offered only when the link allows it — see allow3d).
  const [allow3d, setAllow3d] = useState(true)
  // `?view=3d` deep link opens straight into 3D; the toggle reflects back into
  // the URL so a shared link keeps whatever view the reader landed on.
  const [view, setView] = useState<'2d' | '3d'>(() => (readUrlViewMode() === '3d' ? '3d' : '2d'))
  const [cameraPreset, setCameraPreset] = useState<'tilt' | 'iso'>('iso')
  const [cameraResetSignal, setCameraResetSignal] = useState(0)
  // Showcase mode: slow auto-orbit for presentations/embeds. The toggle
  // is hidden under reduced motion (Scene3D.setShowcase also no-ops there).
  const [showcase, setShowcase] = useState(false)
  const reducedMotion =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const engineRef = useRef<CanvasEngine | null>(null)
  const sceneRef = useRef<Scene3D | null>(null)
  const onRendererReady = useCallback(() => {
    setRendererVersion((version) => version + 1)
    const engine = engineRef.current
    if (engine) setZoom(engine.getZoom())
  }, [])

  useEffect(() => {
    let cancelled = false
    void getShare(token).then((outcome) => {
      if (cancelled) return
      switch (outcome.kind) {
        case 'ok':
          setSnapshot(outcome.result.snapshot)
          setActiveDiagramId(outcome.result.snapshot.rootDiagramId)
          setAllow3d(outcome.result.allow3d ?? true)
          setState('ready')
          break
        case 'notfound':
          setState('notfound')
          break
        case 'restricted':
          setRestricted({ needsAuth: outcome.needsAuth })
          setState('restricted')
          break
        default:
          setState('error')
      }
    })
    return () => {
      cancelled = true
    }
  }, [token])

  // Reflect the EFFECTIVE view into the URL — never advertise 3D on a link that
  // disallows it — so the reader's address bar is a copyable deep link.
  useEffect(() => {
    writeUrlViewMode(allow3d && view === '3d' ? '3d' : '2d')
  }, [allow3d, view])

  const onSelect = useCallback((item: SelectedItem | null) => {
    setSelected(item)
    if (item) setTab('details')
  }, [])

  const selectDiagram = useCallback((id: string) => {
    setActiveDiagramId(id)
    setSelected(null)
  }, [])

  if (state === 'loading') return <Centered>{t('viewer.loading')}</Centered>
  if (state === 'notfound') return <Centered>{t('viewer.notFound')}</Centered>
  if (state === 'restricted') return <RestrictedNotice token={token} needsAuth={restricted.needsAuth} />
  if (state === 'error' || !snapshot || !activeDiagramId) return <Centered>{t('viewer.loadError')}</Centered>

  const activeName = snapshot.diagrams.find((d) => d.id === activeDiagramId)?.name ?? t('viewer.sharedDiagramFallback')
  const diagramFlows = snapshot.flowsByDiagram[activeDiagramId] ?? []
  const multiDiagram = snapshot.diagrams.length > 1
  // The panels overlaying the canvas, for every fit and flow-step focus. The
  // standalone panels have the editor's geometry (312 px at a 14 px margin).
  const viewerInsets = mode === 'standalone'
    ? editorCanvasInsets(flowSidebarOpen, detailsSidebarOpen)
    : EMBED_ASIDE_INSETS

  const zoomBy = (factor: number) => {
    if (allow3d && view === '3d') {
      const scene = sceneRef.current
      if (!scene) return
      const pose = scene.getCameraPose()
      scene.flyTo(pose.targetX, pose.targetZ, pose.distance / factor, 220)
      return
    }
    const engine = engineRef.current
    if (!engine) return
    const next = Math.max(0.1, Math.min(4, engine.getZoom() * factor))
    engine.setZoom(next)
    setZoom(next)
  }

  const fitCanvas = () => {
    if (allow3d && view === '3d') {
      sceneRef.current?.frame(false, viewerInsets)
      return
    }
    const engine = engineRef.current
    if (!engine) return
    engine.zoomToFit(viewerInsets)
    setZoom(engine.getZoom())
  }

  const viewToggle = allow3d && (
    <div className="flex gap-0.5 rounded-[10px] bg-surface-200 p-0.5" role="group" aria-label={t('viewer.viewMode')}>
      {(['2d', '3d'] as const).map((m) => (
        <button
          key={m}
          data-testid={`viewer-view-${m}`}
          aria-pressed={view === m}
          onClick={() => {
            if (m === '3d' && view === '3d') {
              setCameraResetSignal((n) => n + 1)
              return
            }
            setView(m)
          }}
          title={m === '2d' ? t('viewer.view2d') : t('viewer.view3d')}
          className={
            'flex h-[24px] items-center justify-center rounded-lg px-2 text-[11px] font-bold tracking-[0.02em] transition-colors ' +
            (view === m ? 'bg-inverse text-on-inverse' : 'text-fg-subtle hover:text-fg')
          }
        >
          {m.toUpperCase()}
        </button>
      ))}
    </div>
  )

  const canvas = (
    <ViewerCanvas
      snapshot={snapshot}
      diagramId={activeDiagramId}
      engineRef={engineRef}
      sceneRef={sceneRef}
      onRendererReady={onRendererReady}
      onZoomChange={setZoom}
      fitInsets={viewerInsets}
      onSelect={onSelect}
      view={allow3d ? view : '2d'}
      cameraPreset={cameraPreset}
      cameraResetSignal={cameraResetSignal}
      showcase={showcase}
      onExitTo2d={() => setView('2d')}
    />
  )

  const themeToggle = (
    <div
      data-testid="viewer-theme-toggle"
      className="flex gap-0.5 rounded-[10px] bg-surface-200 p-0.5"
      role="group"
      aria-label={t('appearance.label')}
    >
      {([
        { mode: 'light' as const, Icon: Sun },
        { mode: 'dark' as const, Icon: Moon },
      ]).map(({ mode: theme, Icon }) => (
        <button
          key={theme}
          type="button"
          data-testid={`viewer-theme-${theme}`}
          aria-pressed={resolvedTheme === theme}
          onClick={() => setThemeMode(theme)}
          title={t(`appearance.${theme}`)}
          aria-label={t(`appearance.${theme}`)}
          className={cn(
            'flex h-[24px] w-[28px] items-center justify-center rounded-lg transition-colors',
            resolvedTheme === theme
              ? 'bg-inverse text-on-inverse'
              : 'text-fg-subtle hover:bg-surface-hover hover:text-fg',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ))}
    </div>
  )

  const divider = <span className="mx-0.5 h-5 w-px bg-line" aria-hidden="true" />
  const toolButton = 'flex h-[34px] w-[34px] items-center justify-center rounded-[10px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg'
  const toolPill = (
    <div
      data-testid="viewer-tool-pill"
      className="absolute left-1/2 top-3.5 z-30 flex -translate-x-1/2 items-center gap-1 rounded-[15px] border border-line bg-surface-100 p-1.5 elevation-xl"
    >
      <button
        type="button"
        data-testid="viewer-zoom-out"
        onClick={() => zoomBy(1 / 1.2)}
        title={t('canvasViewChrome.zoom.zoomOut')}
        aria-label={t('canvasViewChrome.zoom.zoomOut')}
        className={toolButton}
      >
        <ZoomOut className="h-[17px] w-[17px]" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="viewer-zoom-fit"
        onClick={fitCanvas}
        title={t('canvasViewChrome.zoom.zoomToFit')}
        aria-label={t('canvasViewChrome.zoom.zoomToFit')}
        className="flex h-[34px] min-w-[48px] items-center justify-center rounded-[10px] px-1.5 text-[11px] font-medium tabular-nums text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
      >
        {allow3d && view === '3d' ? '3D' : `${Math.round(zoom * 100)}%`}
      </button>
      <button
        type="button"
        data-testid="viewer-zoom-in"
        onClick={() => zoomBy(1.2)}
        title={t('canvasViewChrome.zoom.zoomIn')}
        aria-label={t('canvasViewChrome.zoom.zoomIn')}
        className={toolButton}
      >
        <ZoomIn className="h-[17px] w-[17px]" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="viewer-center-diagram"
        onClick={fitCanvas}
        title={t('canvasViewChrome.zoom.fitToScreen')}
        aria-label={t('canvasViewChrome.zoom.fitToScreen')}
        className={toolButton}
      >
        <Maximize className="h-[17px] w-[17px]" aria-hidden="true" />
      </button>
      {divider}
      {themeToggle}
      {allow3d && <>{divider}{viewToggle}</>}
    </div>
  )

  // The details panel card is opaque and spans the full height of the corner,
  // so the cluster must sit LEFT of it while it is open or its buttons are
  // unreachable. 338/12 match resolvePerspectiveBarLayout's panelRight (and the
  // editor's cluster in Canvas3DView); embed's always-on w-72 panel at right-2
  // needs 288+8+12.
  const cameraControls = allow3d && view === '3d' && (
    <CameraControls
      preset={cameraPreset}
      onPresetChange={setCameraPreset}
      onReset={() => setCameraResetSignal((n) => n + 1)}
      className={cn(
        'absolute bottom-3 z-10 transition-[right] motion-reduce:transition-none',
        mode === 'standalone'
          ? detailsSidebarOpen
            ? 'right-[338px]'
            : 'right-3'
          : 'right-[308px]',
      )}
    >
      {!reducedMotion && (
        <button
          data-testid="viewer-showcase"
          aria-pressed={showcase}
          onClick={() => setShowcase((s) => !s)}
          title={t('view3d.showcase.toggle')}
          className={
            'ml-0.5 flex h-8 w-8 items-center justify-center rounded-lg transition-colors ' +
            (showcase ? 'bg-inverse text-on-inverse' : 'text-fg-secondary hover:bg-surface-50')
          }
        >
          <Orbit className="h-4 w-4" />
        </button>
      )}
    </CameraControls>
  )

  if (mode === 'standalone') return (
    <div className="flex h-full w-full flex-col bg-app">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface-100 px-3">
        {multiDiagram ? (
          <DiagramSwitcher diagrams={snapshot.diagrams} activeId={activeDiagramId} onSelect={selectDiagram} />
        ) : (
          <span className="truncate text-sm font-medium text-fg">{activeName}</span>
        )}
        <Badge variant="warning">{t('viewer.readOnly')}</Badge>
        <div className="flex-1" />
      </header>
      {/* Match AppShell: the canvas clips itself, while this region deliberately
          leaves the DS elevation halo around both floating panels visible. */}
      <div className="relative min-h-0 flex-1">
        <main className="absolute inset-0">{canvas}</main>
        {toolPill}

        {flowSidebarOpen ? (
          <div data-testid="viewer-flow-sidebar-shell" className="absolute bottom-3.5 left-3.5 top-3.5 z-20">
            <aside className="flex h-full w-[312px] flex-col overflow-hidden rounded-[20px] border border-line bg-surface-100 elevation-xl">
              <div className="flex h-[56px] shrink-0 items-center gap-2.5 border-b border-line px-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent-subtle text-accent">
                  <Route className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold text-fg">{t('viewer.flowsTab')}</div>
                  <div className="text-[10px] text-fg-subtle">{t('viewer.flowSidebarHint')}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setFlowSidebarOpen(false)}
                  title={t('layoutChrome.leftSidebar.collapsePanel')}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-hover hover:text-fg-secondary"
                >
                  <PanelLeft className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <ViewerFlowPanel key={activeDiagramId} flows={diagramFlows} engineRef={engineRef} insets={viewerInsets} />
              </div>
            </aside>
          </div>
        ) : (
          <button
            type="button"
            data-testid="viewer-show-flow-sidebar"
            onClick={() => setFlowSidebarOpen(true)}
            title={t('viewer.showFlows')}
            className="absolute left-3.5 top-3.5 z-30 flex h-9 w-9 items-center justify-center rounded-[12px] border border-line bg-surface-100 text-fg-secondary elevation-xl hover:bg-surface-hover"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        {detailsSidebarOpen ? (
          <div data-testid="viewer-details-sidebar-shell" className="absolute bottom-3.5 right-3.5 top-3.5 z-20">
            <aside className="flex h-full w-[312px] flex-col overflow-hidden rounded-[20px] border border-line bg-surface-100 elevation-xl">
              <div className="flex h-[56px] shrink-0 items-center gap-2 border-b border-line px-3.5">
                <button
                  type="button"
                  onClick={() => setDetailsSidebarOpen(false)}
                  title={t('layoutNav.rightSidebar.collapsePanel')}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle hover:bg-surface-hover hover:text-fg-secondary"
                >
                  <PanelRight className="h-4 w-4" />
                </button>
                <span className="text-[13px] font-semibold text-fg">{t('layoutNav.rightSidebar.tabs.properties')}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-fg-subtle">
                  <Lock className="h-3 w-3" /> {t('viewer.readOnly')}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <ViewerDetailsPanel snapshot={snapshot} selected={selected} diagramId={activeDiagramId} />
              </div>
            </aside>
          </div>
        ) : (
          <button
            type="button"
            data-testid="viewer-show-details-sidebar"
            onClick={() => setDetailsSidebarOpen(true)}
            title={t('viewer.showDetails')}
            className="absolute right-3.5 top-3.5 z-30 flex h-9 w-9 items-center justify-center rounded-[12px] border border-line bg-surface-100 text-fg-secondary elevation-xl hover:bg-surface-hover"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}

        {cameraControls}
        <ViewerPerspectiveBar
          key={activeDiagramId}
          snapshot={snapshot}
          diagramId={activeDiagramId}
          engineRef={engineRef}
          sceneRef={sceneRef}
          leftSidebarOpen={flowSidebarOpen}
          rightSidebarOpen={detailsSidebarOpen}
          rendererVersion={rendererVersion}
        />
      </div>
    </div>
  )

  return (
    <div className="relative h-full w-full bg-app">
      {multiDiagram && (
        <div className="absolute left-2 top-2 z-10">
          <DiagramSwitcher diagrams={snapshot.diagrams} activeId={activeDiagramId} onSelect={selectDiagram} />
        </div>
      )}
      {allow3d && <div className="absolute right-2 top-2 z-10">{viewToggle}</div>}
      {cameraControls}
      {canvas}
      <aside className="absolute bottom-2 right-2 top-12 z-10 flex w-72 flex-col overflow-hidden rounded-xl border border-line bg-surface-100/95 shadow-xl backdrop-blur-sm">
        <div className="flex shrink-0 border-b border-line">
          <TabButton active={tab === 'details'} onClick={() => setTab('details')}>
            {t('viewer.detailsTab')}
          </TabButton>
          {diagramFlows.length > 0 && (
            <TabButton active={tab === 'flows'} onClick={() => setTab('flows')}>
              {t('viewer.flowsTab')}
            </TabButton>
          )}
        </div>
        <div className="min-h-0 flex-1">
          {tab === 'details' ? (
            <ViewerDetailsPanel snapshot={snapshot} selected={selected} diagramId={activeDiagramId} />
          ) : (
            <ViewerFlowPanel key={activeDiagramId} flows={diagramFlows} engineRef={engineRef} insets={viewerInsets} />
          )}
        </div>
      </aside>
    </div>
  )
}
