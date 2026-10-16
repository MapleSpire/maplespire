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

import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { CanvasEngine, type CanvasViewportInsets } from '../canvas/engine/CanvasEngine'
import { useSkinStore } from '../stores/skinStore'
import { useThemeStore } from '../stores/themeStore'
import { filterAndMergeDiagramData } from '../lib/viewLayouts'
import { themeFor3d } from '../plugins/theme3d'
import { resolveSceneDecor } from '../canvas3d/decor/decorSpec'
import { WebglFallback } from '../components/diagram/WebglFallback'
import type { ShareSnapshot, ShareDiagram } from '../lib/share/types'
import type { SkinConfig } from '../skins/types'
import type { SelectedItem } from '../types'
import type { Scene3D } from '../canvas3d'
import type { CanvasViewMode, CanvasCameraPreset } from '../stores/uiStore'
import { feedViewerEngine } from './viewerCanvasData'

const noop = () => {}

/**
 * Read-only 3D board over a share snapshot. Owns its Scene3D lifecycle and is
 * deliberately store-free: everything arrives via props — the same seam the
 * future Model viewer page will use. Shapes aren't draggable (Scene3D readonly
 * turns shape-drags into camera orbits); selection still flows to the panel.
 */
function Viewer3DOverlay({
  sd,
  snapshot,
  skin,
  cameraPreset,
  cameraResetSignal,
  showcase,
  onSelect,
  onBackTo2d,
  sharedSceneRef,
  onRendererReady,
}: {
  sd: ShareDiagram
  snapshot: ShareSnapshot
  skin: SkinConfig
  cameraPreset: CanvasCameraPreset
  cameraResetSignal: number
  showcase: boolean
  onSelect: (item: SelectedItem | null) => void
  /** WebGL-absent fallback: flips the viewer back to the flat canvas. */
  onBackTo2d: () => void
  sharedSceneRef?: MutableRefObject<Scene3D | null>
  onRendererReady?: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<Scene3D | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const onSelectRef = useRef(onSelect)
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    let disposed = false
    let scene: Scene3D | null = null

    import('../canvas3d')
      .then(({ Scene3D }) => {
        if (disposed) return
        const select = (item: SelectedItem | null) => {
          onSelectRef.current(item)
          scene?.setSelection(item ? [item.id] : [])
        }
        scene = new Scene3D(canvas, {
          onObjectSelect: (id) => select(id ? { id, type: 'object' } : null),
          onGroupSelect: (id) => select(id ? { id, type: 'group' } : null),
          onConnectionSelect: (id) => select(id ? { id, type: 'connection' } : null),
          onObjectMove: noop,
          onGroupMove: noop,
        })
        sceneRef.current = scene
        if (sharedSceneRef) sharedSceneRef.current = scene
        scene.setResolvedTheme(useThemeStore.getState().resolved)
        scene.setReadonly(true)
        scene.setShowGrid(false)
        scene.setSize(wrap.clientWidth, wrap.clientHeight)
        setReady(true)
        onRendererReady?.()
      })
      .catch((err) => {
        console.error('3D viewer failed to load', err)
        if (!disposed) setFailed(true)
      })

    const observer = new ResizeObserver(() => {
      if (wrapRef.current && sceneRef.current) {
        sceneRef.current.setSize(wrapRef.current.clientWidth, wrapRef.current.clientHeight)
      }
    })
    observer.observe(wrap)

    return () => {
      disposed = true
      observer.disconnect()
      sceneRef.current = null
      if (sharedSceneRef) sharedSceneRef.current = null
      scene?.dispose()
    }
  }, [onRendererReady, sharedSceneRef])

  const appTheme = useThemeStore((s) => s.resolved)

  useEffect(() => {
    if (ready) sceneRef.current?.setResolvedTheme(appTheme)
  }, [appTheme, ready])

  // Data + skin + camera follow props (3D-resolved placement: 3D ?? 2D).
  useEffect(() => {
    const scene = sceneRef.current
    if (!ready || !scene) return
    scene.setSkin(skin)
    scene.setTheme3d(themeFor3d(skin))
    scene.setConnectionHighlightStyle(sd.connectionHighlightStyle ?? 'traveling-dot')
    scene.setConnectionAnimationsEnabled(sd.connectionAnimationsEnabled ?? true)
    // the shared link shows the dressed board (no controls in the viewer)
    scene.setSceneDecor(resolveSceneDecor(sd))
    const { filteredObjects, filteredConnections, filteredGroups } = filterAndMergeDiagramData(
      sd,
      snapshot.model.objects,
      snapshot.model.connections,
      snapshot.model.groups,
      '3d'
    )
    scene.setData(filteredObjects, filteredConnections, filteredGroups)
    scene.frame(true)
  }, [ready, sd, snapshot, skin])
  useEffect(() => {
    if (ready && sceneRef.current && sceneRef.current.getPreset() !== cameraPreset) {
      sceneRef.current.setCameraPreset(cameraPreset)
    }
  }, [ready, cameraPreset])
  useEffect(() => {
    if (cameraResetSignal > 0) sceneRef.current?.resetCamera()
  }, [cameraResetSignal])
  // Showcase auto-orbit follows the toolbar toggle.
  useEffect(() => {
    if (ready) sceneRef.current?.setShowcase(showcase)
  }, [ready, showcase])

  if (failed) {
    // WebGL-absent fallback: the flat canvas is one click away — never
    // strand the viewer on a blank board.
    return <WebglFallback onBackTo2d={onBackTo2d} />
  }

  return (
    <div ref={wrapRef} data-testid="viewer-canvas-3d" className="absolute inset-0 z-[5]">
      <canvas ref={canvasRef} className="block h-full w-full" style={{ touchAction: 'none' }} />
    </div>
  )
}

export function ViewerCanvas({
  snapshot,
  diagramId,
  engineRef,
  onSelect,
  view = '2d',
  cameraPreset = 'iso',
  cameraResetSignal = 0,
  showcase = false,
  onExitTo2d,
  sceneRef,
  onRendererReady,
  onZoomChange,
  fitInsets = {},
}: {
  snapshot: ShareSnapshot
  diagramId: string
  engineRef: MutableRefObject<CanvasEngine | null>
  /** Called with the focused shape (or null) so the parent can show its details. */
  onSelect: (item: SelectedItem | null) => void
  /** 2D/3D board view (parent gates it on the share's allow3d). */
  view?: CanvasViewMode
  cameraPreset?: CanvasCameraPreset
  /** Bump to animate the camera back to its preset. */
  cameraResetSignal?: number
  /** Showcase auto-orbit — the parent's toolbar toggle. */
  showcase?: boolean
  /** WebGL-absent fallback: asks the parent to flip its view state back to 2D. */
  onExitTo2d?: () => void
  /** Shared with the readonly perspective bar so 2D and 3D stay in sync. */
  sceneRef?: MutableRefObject<Scene3D | null>
  onRendererReady?: () => void
  onZoomChange?: (zoom: number) => void
  /** The parent's panels overlaying the canvas; the first fit frames between them. */
  fitInsets?: CanvasViewportInsets
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const appTheme = useThemeStore((s) => s.resolved)
  const [selected, setSelected] = useState<SelectedItem[]>([])
  const onSelectRef = useRef(onSelect)
  const onZoomChangeRef = useRef(onZoomChange)
  // Read through a ref: a panel toggle changes the insets only for the NEXT
  // fit, and must not re-run the feed effect (which would re-fit the view).
  const fitInsetsRef = useRef(fitInsets)
  useEffect(() => {
    onSelectRef.current = onSelect
    onZoomChangeRef.current = onZoomChange
    fitInsetsRef.current = fitInsets
  }, [onSelect, onZoomChange, fitInsets])

  const sd = snapshot.diagrams.find((d) => d.id === diagramId) ?? snapshot.diagrams[0]
  const resolvedSkin = useSkinStore((s) => s.getResolvedSkin(sd?.skinId, appTheme))

  // Create the engine once. Selection is allowed in readonly (the engine calls
  // onObjectSelect and returns without dragging); edits stay no-ops. Selecting a
  // shape drives the connection highlight animation via setSelectedItems().
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const skin = useSkinStore.getState().getResolvedSkin(sd?.skinId, appTheme)

    const select = (item: SelectedItem | null) => {
      setSelected(item ? [item] : [])
      onSelectRef.current(item)
    }

    const engine = new CanvasEngine(
      canvas,
      {
        onObjectSelect: (id) => select(id ? { id, type: 'object' } : null),
        onGroupSelect: (id) => select(id ? { id, type: 'group' } : null),
        onConnectionSelect: (id) => select(id ? { id, type: 'connection' } : null),
        onObjectMove: noop,
        onObjectResize: noop,
        onObjectDoubleClick: noop,
        onGroupDoubleClick: noop,
        onConnectionDoubleClick: noop,
        onConnectionLabelMove: noop,
        onConnectionWaypointsChange: noop,
        onConnectionStart: noop,
        onConnectionEnd: noop,
        onConnectionAnchorMove: noop,
        onZoom: (nextZoom) => onZoomChangeRef.current?.(nextZoom),
        onCommentClick: noop,
        onCommentMove: noop,
        onContextMenu: noop,
        onGroupMove: noop,
        onGroupResize: noop,
        onCopyApply: noop,
        onExpandClick: noop,
      },
      skin,
    )
    engineRef.current = engine
    engine.setResolvedTheme(appTheme)
    ;(window as unknown as Record<string, unknown>).__canvasEngine = engine
    engine.setReadonly(true)
    engine.setShowGrid(false)
    onRendererReady?.()

    const resize = () => {
      const parent = canvas.parentElement
      if (parent) engine.resize(parent.clientWidth, parent.clientHeight)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas.parentElement!)

    return () => {
      ro.disconnect()
      engine.destroy()
      engineRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRendererReady])

  // Feed data whenever the snapshot or active diagram changes, then fit + reset selection.
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !sd) return
    feedViewerEngine(engine, sd, snapshot)
    setSelected([])
    onSelectRef.current(null)
    requestAnimationFrame(() => {
      engine.zoomToFit(fitInsetsRef.current)
      onZoomChangeRef.current?.(engine.getZoom())
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, sd])

  // Push selection into the engine → highlights + animates the shape's connections.
  useEffect(() => {
    engineRef.current?.setSelectedItems(selected)
  }, [selected, engineRef])

  // Re-resolve the skin when the app theme flips.
  useEffect(() => {
    engineRef.current?.setSkin(useSkinStore.getState().getResolvedSkin(sd?.skinId, appTheme))
    engineRef.current?.setResolvedTheme(appTheme)
  }, [appTheme, sd, engineRef])

  return (
    <div data-testid="viewer-canvas-2d" className="relative h-full w-full overflow-hidden bg-app">
      <canvas ref={canvasRef} className={view === '3d' ? 'invisible block h-full w-full' : 'block h-full w-full'} />
      {view === '3d' && sd && resolvedSkin && (
        <Viewer3DOverlay
          sd={sd}
          snapshot={snapshot}
          skin={resolvedSkin}
          cameraPreset={cameraPreset}
          cameraResetSignal={cameraResetSignal}
          showcase={showcase}
          onSelect={(item) => {
            setSelected(item ? [item] : [])
            onSelectRef.current(item)
          }}
          onBackTo2d={() => onExitTo2d?.()}
          sharedSceneRef={sceneRef}
          onRendererReady={onRendererReady}
        />
      )}
    </div>
  )
}
